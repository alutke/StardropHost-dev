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
# - Uses a persistent Python HTTP metrics listener instead of an nc loop.
# ===========================================

set -uo pipefail

STATUS_FILE="${STATUS_FILE:-/home/steam/.local/share/stardrop/status.json}"
METRICS_FILE="${METRICS_FILE:-/home/steam/.local/share/stardrop/metrics.prom}"
SMAPI_LOG="${SMAPI_LOG:-/home/steam/.config/StardewValley/ErrorLogs/SMAPI-latest.txt}"
LIVE_STATUS_FILE="${LIVE_STATUS_FILE:-/home/steam/.local/share/stardrop/live-status.json}"
STATE_DIR="${STATE_DIR:-/home/steam/.local/share/stardrop}"
COUNTERS_STATE="${COUNTERS_STATE:-${STATE_DIR}/counters.state}"

METRICS_PORT="${METRICS_PORT:-9090}"
METRICS_BIND="${METRICS_BIND:-0.0.0.0}"
ENABLE_METRICS_SERVER="${ENABLE_METRICS_SERVER:-true}"
UPDATE_INTERVAL="${UPDATE_INTERVAL:-15}"
STARTUP_DELAY="${STARTUP_DELAY:-30}"
METRICS_RESTART_BACKOFF="${METRICS_RESTART_BACKOFF:-10}"

GREEN='\033[0;32m'
NC='\033[0m'

# Disable colour when not attached to a TTY.
[ -t 1 ] || { GREEN=''; NC=''; }

log() {
  printf '%b[Status-Reporter]%b %s\n' "$GREEN" "$NC" "$*"
}

is_true() {
  case "${1,,}" in
    true|1|yes|y|on) return 0 ;;
    *) return 1 ;;
  esac
}

mkdir -p "$(dirname "$STATUS_FILE")" "$(dirname "$METRICS_FILE")" "$STATE_DIR"

# ---- State ----
LAST_LOG_SIZE=0
LAST_LOG_INODE=""
GAME_DAY="Unknown"
GAME_PAUSED=0

# Cumulative counters (persisted across restarts/rotations).
PASSOUT_TOTAL=0
READYCHECK_TOTAL=0
OFFLINE_TOTAL=0

# Per-current-log session counts. We track these so that on rotation we can
# detect resets and only ever ADD new events to the cumulative totals.
PASSOUT_SESSION=0
READYCHECK_SESSION=0
OFFLINE_SESSION=0

PREV_CG_USAGE=""
PREV_SYS_TOTAL=""
PREV_SYS_IDLE=""
PREV_SAMPLE_TS=""
CPU_QUOTA_CORES=""

CPU_PERCENT="0.0"
SYS_CPU_PERCENT="0.0"

json_escape() {
  # Python is already a hard dependency; use it for correct JSON string escaping.
  python3 -c 'import json,sys; print(json.dumps(sys.argv[1])[1:-1], end="")' "$1"
}

# ---- Counter persistence ----
load_counters() {
  if [ -r "$COUNTERS_STATE" ]; then
    # shellcheck disable=SC1090
    . "$COUNTERS_STATE" 2>/dev/null || true
  fi
  # Ensure numeric defaults.
  PASSOUT_TOTAL=${PASSOUT_TOTAL:-0}
  READYCHECK_TOTAL=${READYCHECK_TOTAL:-0}
  OFFLINE_TOTAL=${OFFLINE_TOTAL:-0}
}

save_counters() {
  local tmp
  tmp=$(mktemp -p "$STATE_DIR" .counters.XXXXXX 2>/dev/null) || return 0
  cat > "$tmp" <<EOF
PASSOUT_TOTAL=$PASSOUT_TOTAL
READYCHECK_TOTAL=$READYCHECK_TOTAL
OFFLINE_TOTAL=$OFFLINE_TOTAL
EOF
  mv "$tmp" "$COUNTERS_STATE" 2>/dev/null || rm -f "$tmp"
}

# ---- Process info ----
get_game_pid() {
  # -n: newest match, so a stale parent doesn't shadow a freshly-restarted child.
  pgrep -fn 'StardewModdingAPI' 2>/dev/null || true
}

get_uptime_seconds() {
  local pid="${1:-}"
  if [ -z "$pid" ] || [ ! -r "/proc/$pid/stat" ] || [ ! -r /proc/uptime ]; then
    echo "0"
    return
  fi

  local hz uptime start_ticks
  hz=$(getconf CLK_TCK 2>/dev/null || echo 100)
  read -r uptime _ < /proc/uptime
  start_ticks=$(awk '{print $22}' "/proc/$pid/stat" 2>/dev/null || echo "")

  if [ -z "$start_ticks" ]; then
    echo "0"
    return
  fi

  awk -v up="$uptime" -v st="$start_ticks" -v hz="$hz" 'BEGIN {
    seconds = up - (st / hz)
    if (seconds < 0) seconds = 0
    printf "%.0f", seconds
  }'
}

# ---- Log parsing ----
parse_line() {
  local line="$1"
  local lc="${line,,}"

  # Anchored phrases to avoid false positives from generic words like
  # "collapsed" appearing in stack traces or unrelated mod messages.
  if [[ "$lc" =~ (passed[[:space:]]out|collapsed[[:space:]]from[[:space:]]exhaustion|fellasleepfromexhaustion) ]]; then
    PASSOUT_SESSION=$((PASSOUT_SESSION + 1))
  fi

  if [[ "$line" == *"ReadyCheckDialog"* ]]; then
    READYCHECK_SESSION=$((READYCHECK_SESSION + 1))
  fi

  if [[ "$line" == *"ServerOfflineMode"* ]]; then
    OFFLINE_SESSION=$((OFFLINE_SESSION + 1))
    GAME_PAUSED=1
  fi

  # Fallback day detection if live-status.json is unavailable. Use a
  # case-insensitive class so we match "Spring 5 Y2" as well as lowercased.
  if [[ "$line" =~ [Ss]tarting[[:space:]]([A-Za-z]+[[:space:]][0-9]+[[:space:]][Yy][0-9]+) ]]; then
    GAME_DAY="${BASH_REMATCH[1]}"
  fi
}

parse_stream() {
  while IFS= read -r line || [ -n "$line" ]; do
    parse_line "$line"
  done
}

log_size() {
  stat -c %s "$SMAPI_LOG" 2>/dev/null || echo 0
}

log_inode() {
  stat -c %i "$SMAPI_LOG" 2>/dev/null || echo ""
}

# Reparse the entire current log file. Used on first start and after rotation.
# Updates SESSION counters; cumulative TOTALs are not reset here.
reparse_full_log() {
  local prev_passout=$PASSOUT_SESSION
  local prev_readycheck=$READYCHECK_SESSION
  local prev_offline=$OFFLINE_SESSION

  PASSOUT_SESSION=0
  READYCHECK_SESSION=0
  OFFLINE_SESSION=0

  if [ -f "$SMAPI_LOG" ]; then
    parse_stream < "$SMAPI_LOG"
    LAST_LOG_SIZE=$(log_size)
    LAST_LOG_INODE=$(log_inode)
  else
    LAST_LOG_SIZE=0
    LAST_LOG_INODE=""
  fi

  # On the very first parse (called from main before the loop), prev_* are 0
  # and we adopt the freshly-counted session as the baseline contribution to
  # totals. On rotation, prev_* hold whatever we had counted in the previous
  # file; those events are already in TOTAL, so we don't re-add them.
  if [ "$prev_passout" -eq 0 ] && [ "$prev_readycheck" -eq 0 ] && [ "$prev_offline" -eq 0 ] && \
     [ "$PASSOUT_TOTAL" -eq 0 ] && [ "$READYCHECK_TOTAL" -eq 0 ] && [ "$OFFLINE_TOTAL" -eq 0 ]; then
    # Cold start with no persisted counters: seed totals from first parse.
    PASSOUT_TOTAL=$PASSOUT_SESSION
    READYCHECK_TOTAL=$READYCHECK_SESSION
    OFFLINE_TOTAL=$OFFLINE_SESSION
  fi
}

# Read only the new tail of the log and bump TOTALS by the deltas.
parse_new_log_data() {
  if [ ! -f "$SMAPI_LOG" ]; then
    LAST_LOG_SIZE=0
    LAST_LOG_INODE=""
    return
  fi

  local size inode
  size=$(log_size)
  inode=$(log_inode)

  # Inode change == rotation. Reparse from scratch and don't double-count.
  if [ -n "$inode" ] && [ -n "$LAST_LOG_INODE" ] && [ "$inode" != "$LAST_LOG_INODE" ]; then
    reparse_full_log
    return
  fi

  # Truncation in place (some loggers do this instead of rotating).
  if [ "$size" -lt "$LAST_LOG_SIZE" ]; then
    reparse_full_log
    return
  fi

  if [ "$size" -eq "$LAST_LOG_SIZE" ]; then
    return
  fi

  local before_passout=$PASSOUT_SESSION
  local before_readycheck=$READYCHECK_SESSION
  local before_offline=$OFFLINE_SESSION

  # Process substitution preserves counter state in this shell.
  parse_stream < <(tail -c +"$((LAST_LOG_SIZE + 1))" "$SMAPI_LOG" 2>/dev/null)

  PASSOUT_TOTAL=$((PASSOUT_TOTAL + (PASSOUT_SESSION - before_passout)))
  READYCHECK_TOTAL=$((READYCHECK_TOTAL + (READYCHECK_SESSION - before_readycheck)))
  OFFLINE_TOTAL=$((OFFLINE_TOTAL + (OFFLINE_SESSION - before_offline)))

  LAST_LOG_SIZE="$size"
  LAST_LOG_INODE="$inode"
}

# ---- Live status ----
get_live_status() {
  python3 - "$LIVE_STATUS_FILE" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])

players_online = 0
game_day = "Unknown"
paused = 0
server_state = "unknown"

try:
    data = json.loads(path.read_text())
except Exception:
    print(f"{players_online}\t{game_day}\t{paused}\t{server_state}")
    raise SystemExit(0)

players = data.get("players") or []
players_online = sum(
    1 for player in players
    if player.get("isOnline") is True and player.get("isHost") is not True
)

season = data.get("season")
day = data.get("day")
year = data.get("year")
if season and day is not None and year is not None:
    game_day = f"{season} {day} Y{year}"

server_state = str(data.get("serverState", "unknown"))
paused = 0 if server_state.lower() == "running" else 1

print(f"{players_online}\t{game_day}\t{paused}\t{server_state}")
PY
}

# ---- Resource metrics ----
get_memory_metrics() {
  local container_mb=0

  if [ -r /sys/fs/cgroup/memory.current ]; then
    local m
    m=$(cat /sys/fs/cgroup/memory.current 2>/dev/null || echo 0)
    [ -n "$m" ] && [ "$m" -gt 0 ] 2>/dev/null && container_mb=$((m / 1024 / 1024))
  elif [ -r /sys/fs/cgroup/memory/memory.usage_in_bytes ]; then
    local m
    m=$(cat /sys/fs/cgroup/memory/memory.usage_in_bytes 2>/dev/null || echo 0)
    [ -n "$m" ] && [ "$m" -gt 0 ] 2>/dev/null && container_mb=$((m / 1024 / 1024))
  fi

  local meminfo="/host-proc/meminfo"
  [ -f "$meminfo" ] || meminfo="/proc/meminfo"

  local sys_result
  sys_result=$(awk '
    /^MemTotal/ {t=$2}
    /^MemAvailable/ {a=$2}
    END {
      if (t > 0) printf "%d %d", int((t-a)/1024), int(t/1024);
      else printf "0 0";
    }' "$meminfo" 2>/dev/null || echo "0 0")

  echo "$container_mb $sys_result"
}

get_cpu_quota_cores() {
  local cores
  cores=$(nproc 2>/dev/null || echo "1")

  if [ -r /sys/fs/cgroup/cpu.max ]; then
    local quota period
    read -r quota period < /sys/fs/cgroup/cpu.max
    if [ -n "${quota:-}" ] && [ "$quota" != "max" ] && [ -n "${period:-}" ] && [ "$period" -gt 0 ] 2>/dev/null; then
      awk -v q="$quota" -v p="$period" 'BEGIN {
        c = q / p
        if (c <= 0) c = 1
        printf "%.3f", c
      }'
      return
    fi
  fi

  echo "$cores"
}

read_cgroup_cpu_usage() {
  if [ -r /sys/fs/cgroup/cpu.stat ]; then
    awk '$1=="usage_usec"{print $2}' /sys/fs/cgroup/cpu.stat 2>/dev/null
  elif [ -r /sys/fs/cgroup/cpu/cpuacct.usage ]; then
    # cpuacct.usage is in nanoseconds; convert to microseconds for parity.
    awk '{printf "%.0f", $1/1000}' /sys/fs/cgroup/cpu/cpuacct.usage 2>/dev/null
  else
    echo ""
  fi
}

read_system_cpu_sample() {
  local proc_stat="/host-proc/stat"
  [ -f "$proc_stat" ] || proc_stat="/proc/stat"

  awk '/^cpu / {
    idle=$5
    total=0
    for(i=2;i<=NF;i++) total+=$i
    print total, idle
  }' "$proc_stat" 2>/dev/null
}

update_cpu_metrics() {
  local now cg_usage sys_total sys_idle
  now=$(date +%s)
  cg_usage=$(read_cgroup_cpu_usage)
  read -r sys_total sys_idle < <(read_system_cpu_sample) || true

  CPU_PERCENT="0.0"
  SYS_CPU_PERCENT="0.0"

  if [ -n "$PREV_SAMPLE_TS" ] && [ -n "$cg_usage" ] && [ -n "$PREV_CG_USAGE" ]; then
    local elapsed delta cores
    elapsed=$((now - PREV_SAMPLE_TS))
    delta=$((cg_usage - PREV_CG_USAGE))
    [ "$delta" -lt 0 ] && delta=0

    if [ "$elapsed" -gt 0 ]; then
      cores="${CPU_QUOTA_CORES:-$(get_cpu_quota_cores)}"
      CPU_PERCENT=$(awk -v d="$delta" -v e="$elapsed" -v c="$cores" '
        BEGIN {
          if (e > 0 && c > 0) printf "%.1f", (d / 1000000) / e / c * 100;
          else printf "0.0";
        }')
    fi
  fi

  if [ -n "$PREV_SYS_TOTAL" ] && [ -n "$PREV_SYS_IDLE" ] && [ -n "${sys_total:-}" ] && [ -n "${sys_idle:-}" ]; then
    SYS_CPU_PERCENT=$(awk -v t1="$PREV_SYS_TOTAL" -v i1="$PREV_SYS_IDLE" -v t2="$sys_total" -v i2="$sys_idle" '
      BEGIN {
        dt=t2-t1; di=i2-i1;
        if (dt > 0) printf "%.1f", (dt-di)/dt*100;
        else printf "0.0";
      }')
  fi

  PREV_SAMPLE_TS="$now"
  PREV_CG_USAGE="$cg_usage"
  PREV_SYS_TOTAL="${sys_total:-}"
  PREV_SYS_IDLE="${sys_idle:-}"
}

check_script_health() {
  local healthy=1
  pgrep -f 'event-handler.sh' >/dev/null 2>&1 || healthy=0
  echo "$healthy"
}

# ---- Output ----
write_outputs() {
  local game_pid="$1"
  local game_running=0
  [ -n "$game_pid" ] && game_running=1

  local uptime
  uptime=$(get_uptime_seconds "$game_pid")

  local live_players live_day live_paused live_state
  IFS=$'\t' read -r live_players live_day live_paused live_state < <(get_live_status) || true

  local players="${live_players:-0}"
  local game_day="${live_day:-$GAME_DAY}"
  local paused="${live_paused:-$GAME_PAUSED}"

  if [ "$game_running" -eq 0 ]; then
    players=0
  fi

  local game_day_escaped
  game_day_escaped=$(json_escape "$game_day")

  local memory sys_mem_used sys_mem_total
  read -r memory sys_mem_used sys_mem_total <<< "$(get_memory_metrics)"

  update_cpu_metrics

  local script_health timestamp tmp_metrics tmp_status
  script_health=$(check_script_health)
  timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  tmp_metrics=$(mktemp -p "$(dirname "$METRICS_FILE")" .metrics.XXXXXX)
  cat > "$tmp_metrics" <<EOPROM
# HELP stardrop_game_running Whether the game process is running.
# TYPE stardrop_game_running gauge
stardrop_game_running $game_running
# HELP stardrop_uptime_seconds Game process uptime in seconds.
# TYPE stardrop_uptime_seconds gauge
stardrop_uptime_seconds $uptime
# HELP stardrop_players_online Number of online non-host players.
# TYPE stardrop_players_online gauge
stardrop_players_online $players
# HELP stardrop_memory_usage_mb Container memory usage in megabytes.
# TYPE stardrop_memory_usage_mb gauge
stardrop_memory_usage_mb ${memory:-0}
# HELP stardrop_cpu_usage_percent Container CPU usage as percent of allocated capacity.
# TYPE stardrop_cpu_usage_percent gauge
stardrop_cpu_usage_percent ${CPU_PERCENT:-0.0}
# HELP stardrop_events_passout_total Total passout events detected (monotonic across rotations).
# TYPE stardrop_events_passout_total counter
stardrop_events_passout_total $PASSOUT_TOTAL
# HELP stardrop_events_readycheck_total Total ready-check dialog events (monotonic across rotations).
# TYPE stardrop_events_readycheck_total counter
stardrop_events_readycheck_total $READYCHECK_TOTAL
# HELP stardrop_events_offline_total Total server-offline events (monotonic across rotations).
# TYPE stardrop_events_offline_total counter
stardrop_events_offline_total $OFFLINE_TOTAL
# HELP stardrop_script_healthy Whether background scripts are running.
# TYPE stardrop_script_healthy gauge
stardrop_script_healthy $script_health
EOPROM
  mv "$tmp_metrics" "$METRICS_FILE"

  tmp_status=$(mktemp -p "$(dirname "$STATUS_FILE")" .status.XXXXXX)
  cat > "$tmp_status" <<EOJSON
{
  "timestamp": "$timestamp",
  "server": {
    "version": "1.0.0",
    "game_running": $([ "$game_running" = "1" ] && echo "true" || echo "false"),
    "uptime_seconds": $uptime
  },
  "game": {
    "day": "$game_day_escaped",
    "players_online": $players,
    "paused": $([ "$paused" = "1" ] && echo "true" || echo "false")
  },
  "resources": {
    "memory_mb": ${memory:-0},
    "cpu_percent": ${CPU_PERCENT:-0.0},
    "sys_cpu_percent": ${SYS_CPU_PERCENT:-0.0},
    "sys_memory_mb": ${sys_mem_used:-0},
    "sys_memory_total_mb": ${sys_mem_total:-0}
  },
  "events": {
    "passout": $PASSOUT_TOTAL,
    "readycheck": $READYCHECK_TOTAL,
    "offline": $OFFLINE_TOTAL
  },
  "scripts_healthy": $([ "$script_health" = "1" ] && echo "true" || echo "false")
}
EOJSON
  mv "$tmp_status" "$STATUS_FILE"

  save_counters
}

update_metrics() {
  parse_new_log_data
  local game_pid
  game_pid=$(get_game_pid)
  write_outputs "$game_pid"
}

# ---- HTTP listener ----
serve_metrics_once() {
  if ! command -v python3 >/dev/null 2>&1; then
    log "python3 not found; metrics HTTP listener cannot start"
    return 1
  fi

  # exec so signals from the supervisor reach Python directly.
  exec python3 -u - "$METRICS_BIND" "$METRICS_PORT" "$METRICS_FILE" <<'PYHTTP'
import http.server
import socketserver
import sys
from pathlib import Path

bind = sys.argv[1]
port = int(sys.argv[2])
metrics_file = Path(sys.argv[3])

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path not in ("/", "/metrics"):
            self.send_response(404)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(b"Not found\n")
            return

        # Tiny retry: write_outputs() does tmp+mv, so concurrent reads are
        # safe at the inode level, but a fresh open immediately after a
        # truncate-style replace can briefly see zero bytes on some FSes.
        body = b"# No metrics available yet\n"
        for _ in range(2):
            try:
                data = metrics_file.read_bytes()
            except FileNotFoundError:
                data = b""
            if data:
                body = data
                break

        self.send_response(200)
        self.send_header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass

    def log_message(self, fmt, *args):
        return

class Server(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True

with Server((bind, port), Handler) as httpd:
    print(f"[Status-Reporter] Python metrics listener serving {metrics_file} on {bind}:{port}", flush=True)
    httpd.serve_forever()
PYHTTP
}

serve_metrics() {
  while true; do
    serve_metrics_once
    local rc=$?
    log "Metrics HTTP listener exited with code $rc; restarting in ${METRICS_RESTART_BACKOFF}s"
    sleep "$METRICS_RESTART_BACKOFF"
  done
}

cleanup() {
  if [ -n "${SERVE_PID:-}" ]; then
    kill "$SERVE_PID" 2>/dev/null || true
    wait "$SERVE_PID" 2>/dev/null || true
  fi
  save_counters
}
trap cleanup EXIT TERM INT

# ---- Main ----
log "Status reporter starting..."
log " Metrics bind: ${METRICS_BIND}:${METRICS_PORT}"
log " Metrics server enabled: $ENABLE_METRICS_SERVER"
log " Update interval: ${UPDATE_INTERVAL}s"
log " Startup delay: ${STARTUP_DELAY}s"
log " Status file: $STATUS_FILE"
log " Live status file: $LIVE_STATUS_FILE"
log " SMAPI log: $SMAPI_LOG"
log " Counter state: $COUNTERS_STATE"

CPU_QUOTA_CORES=$(get_cpu_quota_cores)

load_counters
sleep "$STARTUP_DELAY"

reparse_full_log
update_metrics

if is_true "$ENABLE_METRICS_SERVER"; then
  serve_metrics &
  SERVE_PID=$!
  log "✅ HTTP metrics server started (PID: $SERVE_PID)"
else
  SERVE_PID=""
  log "Prometheus HTTP listener disabled; status.json and metrics.prom still update"
fi

while true; do
  sleep "$UPDATE_INTERVAL"
  update_metrics
done
