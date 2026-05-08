#!/usr/bin/env bash
# ===========================================
# StardropHost | status-reporter.sh
# ===========================================
# - live-status.json is the authoritative source for player/game state.
# - Counts online non-host players only.
# - Parses SMAPI logs incrementally for event counters/fallbacks.
# - Persists counter totals to disk so Prometheus counters stay monotonic
#   across log rotations and script restarts.
# - Writes metrics.prom and status.json atomically.
# - Uses a persistent Python HTTP metrics listener.
# ===========================================

set -uo pipefail

exec python3 -u - "$0" <<'PY'
import http.server
import json
import os
import re
import signal
import socketserver
import sys
import tempfile
import threading
import time
from pathlib import Path


STATUS_FILE = Path(os.environ.get("STATUS_FILE", "/home/steam/.local/share/stardrop/status.json"))
METRICS_FILE = Path(os.environ.get("METRICS_FILE", "/home/steam/.local/share/stardrop/metrics.prom"))
SMAPI_LOG = Path(os.environ.get("SMAPI_LOG", "/home/steam/.config/StardewValley/ErrorLogs/SMAPI-latest.txt"))
LIVE_STATUS_FILE = Path(os.environ.get("LIVE_STATUS_FILE", "/home/steam/.local/share/stardrop/live-status.json"))
STATE_DIR = Path(os.environ.get("STATE_DIR", "/home/steam/.local/share/stardrop"))
COUNTERS_STATE = Path(os.environ.get("COUNTERS_STATE", str(STATE_DIR / "counters.state")))

METRICS_PORT = int(os.environ.get("METRICS_PORT", "9090") or "9090")
METRICS_BIND = os.environ.get("METRICS_BIND", "0.0.0.0")
ENABLE_METRICS_SERVER = os.environ.get("ENABLE_METRICS_SERVER", "true")
UPDATE_INTERVAL = max(1, int(os.environ.get("UPDATE_INTERVAL", "15") or "15"))
STARTUP_DELAY = max(0, int(os.environ.get("STARTUP_DELAY", "30") or "30"))

STATE_DIR.mkdir(parents=True, exist_ok=True)
STATUS_FILE.parent.mkdir(parents=True, exist_ok=True)
METRICS_FILE.parent.mkdir(parents=True, exist_ok=True)


def is_true(value):
    return str(value or "").strip().lower() in {"true", "1", "yes", "y", "on"}


def log(message):
    print(f"[Status-Reporter] {message}", flush=True)


def atomic_write(path, text):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent), text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


class StatusReporter:
    def __init__(self):
        self.last_log_size = 0
        self.last_log_inode = None
        self.game_day = "Unknown"
        self.game_paused = 0

        self.passout_total = 0
        self.readycheck_total = 0
        self.offline_total = 0

        self.passout_session = 0
        self.readycheck_session = 0
        self.offline_session = 0

        self.prev_cg_usage = None
        self.prev_sys_total = None
        self.prev_sys_idle = None
        self.prev_sample_ts = None
        self.cpu_quota_cores = self.get_cpu_quota_cores()

        self.cpu_percent = "0.0"
        self.sys_cpu_percent = "0.0"
        self.running = True

    def load_counters(self):
        if not COUNTERS_STATE.is_file():
            return
        try:
            for line in COUNTERS_STATE.read_text(encoding="utf-8").splitlines():
                if "=" not in line:
                    continue
                key, value = line.split("=", 1)
                try:
                    parsed = int(value.strip() or "0")
                except ValueError:
                    parsed = 0
                if key == "PASSOUT_TOTAL":
                    self.passout_total = parsed
                elif key == "READYCHECK_TOTAL":
                    self.readycheck_total = parsed
                elif key == "OFFLINE_TOTAL":
                    self.offline_total = parsed
        except Exception:
            pass

    def save_counters(self):
        text = (
            f"PASSOUT_TOTAL={self.passout_total}\n"
            f"READYCHECK_TOTAL={self.readycheck_total}\n"
            f"OFFLINE_TOTAL={self.offline_total}\n"
        )
        try:
            atomic_write(COUNTERS_STATE, text)
        except Exception:
            pass

    def parse_line(self, line):
        lower = line.lower()
        if re.search(r"passed\s+out|collapsed\s+from\s+exhaustion|fellasleepfromexhaustion", lower):
            self.passout_session += 1

        if "ReadyCheckDialog" in line:
            self.readycheck_session += 1

        if "ServerOfflineMode" in line:
            self.offline_session += 1
            self.game_paused = 1

        match = re.search(r"[Ss]tarting\s+([A-Za-z]+\s+[0-9]+\s+[Yy][0-9]+)", line)
        if match:
            self.game_day = match.group(1)

    def parse_stream(self, lines):
        for line in lines:
            self.parse_line(line.rstrip("\n"))

    def log_stat(self):
        try:
            stat = SMAPI_LOG.stat()
            return stat.st_size, stat.st_ino
        except FileNotFoundError:
            return 0, None
        except Exception:
            return self.last_log_size, self.last_log_inode

    def reparse_full_log(self):
        prev_passout = self.passout_session
        prev_readycheck = self.readycheck_session
        prev_offline = self.offline_session

        self.passout_session = 0
        self.readycheck_session = 0
        self.offline_session = 0

        try:
            with SMAPI_LOG.open("r", encoding="utf-8", errors="replace") as handle:
                self.parse_stream(handle)
            self.last_log_size, self.last_log_inode = self.log_stat()
        except FileNotFoundError:
            self.last_log_size = 0
            self.last_log_inode = None
        except Exception:
            pass

        if (
            prev_passout == 0
            and prev_readycheck == 0
            and prev_offline == 0
            and self.passout_total == 0
            and self.readycheck_total == 0
            and self.offline_total == 0
        ):
            self.passout_total = self.passout_session
            self.readycheck_total = self.readycheck_session
            self.offline_total = self.offline_session

    def parse_new_log_data(self):
        size, inode = self.log_stat()
        if inode is None:
            self.last_log_size = 0
            self.last_log_inode = None
            return

        if self.last_log_inode is not None and inode != self.last_log_inode:
            self.reparse_full_log()
            return

        if size < self.last_log_size:
            self.reparse_full_log()
            return

        if size == self.last_log_size:
            return

        before_passout = self.passout_session
        before_readycheck = self.readycheck_session
        before_offline = self.offline_session

        try:
            with SMAPI_LOG.open("rb") as handle:
                handle.seek(self.last_log_size)
                chunk = handle.read(size - self.last_log_size)
            text = chunk.decode("utf-8", errors="replace")
            self.parse_stream(text.splitlines())
        except Exception:
            return

        self.passout_total += self.passout_session - before_passout
        self.readycheck_total += self.readycheck_session - before_readycheck
        self.offline_total += self.offline_session - before_offline
        self.last_log_size = size
        self.last_log_inode = inode

    def get_game_pid(self):
        newest_pid = None
        newest_start = -1
        proc = Path("/proc")
        if not proc.is_dir():
            return None
        for entry in proc.iterdir():
            if not entry.name.isdigit():
                continue
            try:
                cmdline = (entry / "cmdline").read_bytes().replace(b"\x00", b" ").decode("utf-8", errors="ignore")
            except Exception:
                continue
            if "StardewModdingAPI" not in cmdline:
                continue
            start_ticks = self.get_process_start_ticks(entry)
            if start_ticks > newest_start:
                newest_pid = int(entry.name)
                newest_start = start_ticks
        return newest_pid

    def get_process_start_ticks(self, proc_dir):
        try:
            stat = (proc_dir / "stat").read_text(encoding="utf-8")
            after_comm = stat.rsplit(")", 1)[1].strip()
            fields = after_comm.split()
            return int(fields[19])
        except Exception:
            return 0

    def get_uptime_seconds(self, pid):
        if not pid:
            return 0
        try:
            uptime = float(Path("/proc/uptime").read_text(encoding="utf-8").split()[0])
            start_ticks = self.get_process_start_ticks(Path("/proc") / str(pid))
            hz = os.sysconf(os.sysconf_names.get("SC_CLK_TCK", "SC_CLK_TCK"))
            return max(0, round(uptime - (start_ticks / hz)))
        except Exception:
            return 0

    def get_live_status(self):
        players_online = 0
        game_day = "Unknown"
        paused = 0
        server_state = "unknown"

        try:
            data = json.loads(LIVE_STATUS_FILE.read_text(encoding="utf-8"))
            players = data.get("players") or []
            players_online = sum(
                1
                for player in players
                if player.get("isOnline") is True and player.get("isHost") is not True
            )
            season = data.get("season")
            day = data.get("day")
            year = data.get("year")
            if season and day is not None and year is not None:
                game_day = f"{season} {day} Y{year}"
            server_state = str(data.get("serverState", "unknown"))
            paused = 0 if server_state.lower() == "running" else 1
        except Exception:
            pass

        return players_online, game_day, paused, server_state

    def get_memory_metrics(self):
        container_mb = 0
        for path in (Path("/sys/fs/cgroup/memory.current"), Path("/sys/fs/cgroup/memory/memory.usage_in_bytes")):
            try:
                value = int(path.read_text(encoding="utf-8").strip())
                if value > 0:
                    container_mb = round(value / 1024 / 1024)
                    break
            except Exception:
                pass

        meminfo = Path("/host-proc/meminfo")
        if not meminfo.is_file():
            meminfo = Path("/proc/meminfo")

        total = 0
        available = 0
        try:
            for line in meminfo.read_text(encoding="utf-8").splitlines():
                if line.startswith("MemTotal:"):
                    total = int(line.split()[1])
                elif line.startswith("MemAvailable:"):
                    available = int(line.split()[1])
            if total > 0:
                return container_mb, round((total - available) / 1024), round(total / 1024)
        except Exception:
            pass
        return container_mb, 0, 0

    def get_cpu_quota_cores(self):
        try:
            cores = os.cpu_count() or 1
        except Exception:
            cores = 1

        try:
            quota, period = Path("/sys/fs/cgroup/cpu.max").read_text(encoding="utf-8").split()[:2]
            if quota != "max":
                period_int = int(period)
                if period_int > 0:
                    return max(1.0, int(quota) / period_int)
        except Exception:
            pass
        return float(cores)

    def read_cgroup_cpu_usage(self):
        try:
            for line in Path("/sys/fs/cgroup/cpu.stat").read_text(encoding="utf-8").splitlines():
                key, value = line.split()[:2]
                if key == "usage_usec":
                    return int(value)
        except Exception:
            pass

        try:
            return round(int(Path("/sys/fs/cgroup/cpu/cpuacct.usage").read_text(encoding="utf-8").strip()) / 1000)
        except Exception:
            return None

    def read_system_cpu_sample(self):
        proc_stat = Path("/host-proc/stat")
        if not proc_stat.is_file():
            proc_stat = Path("/proc/stat")
        try:
            parts = proc_stat.read_text(encoding="utf-8").splitlines()[0].split()
            values = [int(v) for v in parts[1:]]
            return sum(values), values[3]
        except Exception:
            return None, None

    def update_cpu_metrics(self):
        now = time.time()
        cg_usage = self.read_cgroup_cpu_usage()
        sys_total, sys_idle = self.read_system_cpu_sample()

        self.cpu_percent = "0.0"
        self.sys_cpu_percent = "0.0"

        if self.prev_sample_ts is not None and cg_usage is not None and self.prev_cg_usage is not None:
            elapsed = now - self.prev_sample_ts
            delta = max(0, cg_usage - self.prev_cg_usage)
            if elapsed > 0 and self.cpu_quota_cores > 0:
                self.cpu_percent = f"{((delta / 1_000_000) / elapsed / self.cpu_quota_cores * 100):.1f}"

        if (
            self.prev_sys_total is not None
            and self.prev_sys_idle is not None
            and sys_total is not None
            and sys_idle is not None
        ):
            dt = sys_total - self.prev_sys_total
            di = sys_idle - self.prev_sys_idle
            if dt > 0:
                self.sys_cpu_percent = f"{((dt - di) / dt * 100):.1f}"

        self.prev_sample_ts = now
        self.prev_cg_usage = cg_usage
        self.prev_sys_total = sys_total
        self.prev_sys_idle = sys_idle

    def check_script_health(self):
        proc = Path("/proc")
        if not proc.is_dir():
            return 0
        for entry in proc.iterdir():
            if not entry.name.isdigit():
                continue
            try:
                cmdline = (entry / "cmdline").read_bytes().replace(b"\x00", b" ").decode("utf-8", errors="ignore")
            except Exception:
                continue
            if "event-handler.sh" in cmdline:
                return 1
        return 0

    def write_outputs(self, game_pid):
        game_running = 1 if game_pid else 0
        uptime = self.get_uptime_seconds(game_pid)
        live_players, live_day, live_paused, _live_state = self.get_live_status()
        players = live_players if game_running else 0
        game_day = live_day or self.game_day
        paused = live_paused if live_paused is not None else self.game_paused
        memory, sys_mem_used, sys_mem_total = self.get_memory_metrics()
        self.update_cpu_metrics()
        script_health = self.check_script_health()
        timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

        metrics = f"""# HELP stardrop_game_running Whether the game process is running.
# TYPE stardrop_game_running gauge
stardrop_game_running {game_running}
# HELP stardrop_uptime_seconds Game process uptime in seconds.
# TYPE stardrop_uptime_seconds gauge
stardrop_uptime_seconds {uptime}
# HELP stardrop_players_online Number of online non-host players.
# TYPE stardrop_players_online gauge
stardrop_players_online {players}
# HELP stardrop_memory_usage_mb Container memory usage in megabytes.
# TYPE stardrop_memory_usage_mb gauge
stardrop_memory_usage_mb {memory}
# HELP stardrop_cpu_usage_percent Container CPU usage as percent of allocated capacity.
# TYPE stardrop_cpu_usage_percent gauge
stardrop_cpu_usage_percent {self.cpu_percent}
# HELP stardrop_events_passout_total Total passout events detected (monotonic across rotations).
# TYPE stardrop_events_passout_total counter
stardrop_events_passout_total {self.passout_total}
# HELP stardrop_events_readycheck_total Total ready-check dialog events (monotonic across rotations).
# TYPE stardrop_events_readycheck_total counter
stardrop_events_readycheck_total {self.readycheck_total}
# HELP stardrop_events_offline_total Total server-offline events (monotonic across rotations).
# TYPE stardrop_events_offline_total counter
stardrop_events_offline_total {self.offline_total}
# HELP stardrop_script_healthy Whether background scripts are running.
# TYPE stardrop_script_healthy gauge
stardrop_script_healthy {script_health}
"""
        atomic_write(METRICS_FILE, metrics)

        status = {
            "timestamp": timestamp,
            "server": {
                "version": "1.0.0",
                "game_running": bool(game_running),
                "uptime_seconds": uptime,
            },
            "game": {
                "day": game_day,
                "players_online": players,
                "paused": bool(paused),
            },
            "resources": {
                "memory_mb": memory,
                "cpu_percent": float(self.cpu_percent),
                "sys_cpu_percent": float(self.sys_cpu_percent),
                "sys_memory_mb": sys_mem_used,
                "sys_memory_total_mb": sys_mem_total,
            },
            "events": {
                "passout": self.passout_total,
                "readycheck": self.readycheck_total,
                "offline": self.offline_total,
            },
            "scripts_healthy": bool(script_health),
        }
        atomic_write(STATUS_FILE, json.dumps(status, separators=(",", ":")) + "\n")
        self.save_counters()

    def update_metrics(self):
        self.parse_new_log_data()
        self.write_outputs(self.get_game_pid())

    def run(self):
        log("Status reporter starting...")
        log(f" Metrics bind: {METRICS_BIND}:{METRICS_PORT}")
        log(f" Metrics server enabled: {ENABLE_METRICS_SERVER}")
        log(f" Update interval: {UPDATE_INTERVAL}s")
        log(f" Startup delay: {STARTUP_DELAY}s")
        log(f" Status file: {STATUS_FILE}")
        log(f" Live status file: {LIVE_STATUS_FILE}")
        log(f" SMAPI log: {SMAPI_LOG}")
        log(f" Counter state: {COUNTERS_STATE}")

        self.load_counters()
        if STARTUP_DELAY:
            time.sleep(STARTUP_DELAY)

        self.reparse_full_log()
        self.update_metrics()

        if is_true(ENABLE_METRICS_SERVER):
            start_metrics_server()
        else:
            log("Prometheus HTTP listener disabled; status.json and metrics.prom still update")

        while self.running:
            time.sleep(UPDATE_INTERVAL)
            self.update_metrics()


REPORTER = StatusReporter()


class MetricsHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path not in ("/", "/metrics"):
            self.send_response(404)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(b"Not found\n")
            return

        body = b"# No metrics available yet\n"
        for _ in range(2):
            try:
                data = METRICS_FILE.read_bytes()
            except FileNotFoundError:
                data = b""
            if data:
                body = data
                break
            time.sleep(0.02)

        self.send_response(200)
        self.send_header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass

    def log_message(self, _fmt, *_args):
        return


class MetricsServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


def start_metrics_server():
    try:
        server = MetricsServer((METRICS_BIND, METRICS_PORT), MetricsHandler)
    except Exception as exc:
        log(f"Metrics HTTP listener failed to start: {exc}")
        return

    thread = threading.Thread(target=server.serve_forever, name="metrics-http", daemon=True)
    thread.start()
    log(f"HTTP metrics server started on {METRICS_BIND}:{METRICS_PORT}")


def shutdown(_signum, _frame):
    REPORTER.running = False
    REPORTER.save_counters()
    raise SystemExit(0)


signal.signal(signal.SIGTERM, shutdown)
signal.signal(signal.SIGINT, shutdown)

try:
    REPORTER.run()
finally:
    REPORTER.save_counters()
PY
