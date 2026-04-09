#!/bin/bash
# ===========================================
# StardropHost | scripts/status-reporter.sh
# ===========================================
# Serves Prometheus metrics on port 9090 and
# writes a JSON status file for the web panel.
#
# Metrics exposed:
#   stardrop_game_running
#   stardrop_uptime_seconds
#   stardrop_players_online
#   stardrop_memory_usage_mb
#   stardrop_cpu_usage_percent
#   stardrop_events_passout_total
#   stardrop_events_readycheck_total
#   stardrop_events_offline_total
#   stardrop_script_healthy
# ===========================================

STATUS_FILE="/home/steam/.local/share/stardrop/status.json"
METRICS_FILE="/home/steam/.local/share/stardrop/metrics.prom"
SMAPI_LOG="/home/steam/.config/StardewValley/ErrorLogs/SMAPI-latest.txt"
METRICS_PORT=${METRICS_PORT:-9090}
UPDATE_INTERVAL=15

GREEN='\033[0;32m'
NC='\033[0m'
log() { echo -e "${GREEN}[Status-Reporter]${NC} $1"; }

mkdir -p "$(dirname "$STATUS_FILE")"
mkdir -p "$(dirname "$METRICS_FILE")"

# -- Uptime --
get_uptime_seconds() {
    local pid=$(pgrep -f StardewModdingAPI 2>/dev/null | head -1)
    if [ -n "$pid" ] && [ -d "/proc/$pid" ]; then
        local start_time=$(stat -c %Y "/proc/$pid" 2>/dev/null)
        if [ -n "$start_time" ]; then
            echo $(($(date +%s) - start_time))
            return
        fi
    fi
    echo "0"
}

# -- Player count --
# BUG FIX: Reads from SMAPI-latest.txt (not Docker stdout)
# BUG FIX: Player IDs are numeric (e.g. -3472295406447050512)
#          Updated regex from [A-Za-z0-9_]+ to [-0-9]+ for IDs
get_player_count() {
    if [ ! -f "$SMAPI_LOG" ]; then
        echo "0"
        return
    fi

    awk '
        function mark_join(id) {
            if (id != "" && id != "Server" && id != "SMAPI") connected[id] = 1
        }
        function mark_leave(id) {
            if (id != "") delete connected[id]
        }

        # Join patterns - player IDs are numeric
        match($0, /Received connection for vanilla player ([-0-9]+)/, a) { mark_join(a[1]); next }
        match($0, /Approved request for farmhand ([-0-9]+)/, a)          { mark_join(a[1]); next }
        match($0, /farmhand ([-0-9]+) connected/, a)                      { mark_join(a[1]); next }
        match($0, /client ([-0-9]+) connected/, a)                        { mark_join(a[1]); next }
        match($0, /peer ([-0-9]+) joined/, a)                             { mark_join(a[1]); next }

        # Leave patterns
        match($0, /farmhand ([-0-9]+) disconnected/, a)                   { mark_leave(a[1]); next }
        match($0, /client ([-0-9]+) disconnected/, a)                     { mark_leave(a[1]); next }
        match($0, /peer ([-0-9]+) left/, a)                               { mark_leave(a[1]); next }
        match($0, /connection ([-0-9]+) disconnected/, a)                 { mark_leave(a[1]); next }
        match($0, /player ([-0-9]+) disconnected/, a)                     { mark_leave(a[1]); next }

        END {
            count = 0
            for (id in connected) count++
            print count
        }
    ' "$SMAPI_LOG" 2>/dev/null || echo "0"
}

# -- Game day --
get_game_day() {
    if [ -f "$SMAPI_LOG" ]; then
        local day_info=""
        day_info=$(grep -oP "starting \K[a-z]+ \d+ Y\d+" "$SMAPI_LOG" 2>/dev/null | tail -1 || true)
        if [ -z "$day_info" ]; then
            day_info=$(grep -oP "Season:\s*\K[a-z]+, Day \d+, Year \d+" "$SMAPI_LOG" 2>/dev/null | tail -1 || true)
        fi
        echo "${day_info:-Unknown}"
    else
        echo "Not started"
    fi
}

# -- Game paused --
get_game_paused() {
    if [ ! -f "$SMAPI_LOG" ]; then
        echo "0"
        return
    fi

    local latest_state
    latest_state=$(grep -nE \
        "Disconnected: ServerOfflineMode|Starting LAN server|joined the game|player connected|farmhand connected|peer .* joined|client .* connected" \
        "$SMAPI_LOG" 2>/dev/null | tail -1 || true)

    if echo "$latest_state" | grep -q "Disconnected: ServerOfflineMode"; then
        echo "1"
    else
        echo "0"
    fi
}

# -- Memory: container (cgroup) + system (/proc/meminfo) --
# Outputs: "<container_mb> <sys_used_mb> <sys_total_mb>"
get_memory_metrics() {
    local container_mb=0
    if [ -f "/sys/fs/cgroup/memory.current" ]; then
        local m; m=$(cat /sys/fs/cgroup/memory.current 2>/dev/null)
        [ -n "$m" ] && [ "$m" -gt 0 ] 2>/dev/null && container_mb=$((m / 1024 / 1024))
    fi
    if [ "$container_mb" -eq 0 ] && [ -f "/sys/fs/cgroup/memory/memory.usage_in_bytes" ]; then
        local m; m=$(cat /sys/fs/cgroup/memory/memory.usage_in_bytes 2>/dev/null)
        [ -n "$m" ] && [ "$m" -gt 0 ] 2>/dev/null && container_mb=$((m / 1024 / 1024))
    fi

    local sys_result
    sys_result=$(awk '/^MemTotal/{t=$2} /^MemAvailable/{a=$2} END{
        printf "%d %d", int((t-a)/1024), int(t/1024)
    }' /proc/meminfo 2>/dev/null || echo "0 0")

    echo "$container_mb $sys_result"
}

# -- CPU: container (cgroup) + system (/proc/stat), sampled over 1s --
# Outputs: "<container_pct> <sys_pct>"
get_cpu_metrics() {
    # Allocated cores for container %
    local cores; cores=$(nproc 2>/dev/null || echo "1")
    if [ -f "/sys/fs/cgroup/cpu.max" ]; then
        local quota period
        quota=$(awk '{print $1}' /sys/fs/cgroup/cpu.max 2>/dev/null)
        period=$(awk '{print $2}' /sys/fs/cgroup/cpu.max 2>/dev/null)
        if [ -n "$quota" ] && [ "$quota" != "max" ] && [ -n "$period" ] && [ "$period" -gt 0 ]; then
            cores=$(echo "$quota $period" | awk '{c=int($1/$2); print (c<1)?1:c}')
        fi
    fi

    # First samples
    local cg_u1=""; local cg_v1=false
    if [ -f "/sys/fs/cgroup/cpu.stat" ]; then
        cg_u1=$(grep "^usage_usec" /sys/fs/cgroup/cpu.stat 2>/dev/null | awk '{print $2}')
        cg_v1=true
    elif [ -f "/sys/fs/cgroup/cpu/cpuacct.usage" ]; then
        cg_u1=$(cat /sys/fs/cgroup/cpu/cpuacct.usage 2>/dev/null)
    fi
    local sys_s1
    sys_s1=$(awk '/^cpu /{idle=$5; t=0; for(i=2;i<=NF;i++) t+=$i; print t, idle}' /proc/stat 2>/dev/null)

    sleep 1

    # Second samples
    local cg_u2=""
    if $cg_v1 && [ -f "/sys/fs/cgroup/cpu.stat" ]; then
        cg_u2=$(grep "^usage_usec" /sys/fs/cgroup/cpu.stat 2>/dev/null | awk '{print $2}')
    elif [ -f "/sys/fs/cgroup/cpu/cpuacct.usage" ]; then
        cg_u2=$(cat /sys/fs/cgroup/cpu/cpuacct.usage 2>/dev/null)
    fi
    local sys_s2
    sys_s2=$(awk '/^cpu /{idle=$5; t=0; for(i=2;i<=NF;i++) t+=$i; print t, idle}' /proc/stat 2>/dev/null)

    # Container CPU %
    local container_cpu="0.0"
    if [ -n "$cg_u1" ] && [ -n "$cg_u2" ]; then
        local delta=$((cg_u2 - cg_u1))
        if $cg_v1; then
            container_cpu=$(echo "$delta $cores" | awk '{printf "%.1f", ($1/1000000)/$2*100}')
        else
            container_cpu=$(echo "$delta $cores" | awk '{printf "%.1f", ($1/1000000000)/$2*100}')
        fi
    fi

    # System CPU %
    local sys_cpu="0.0"
    if [ -n "$sys_s1" ] && [ -n "$sys_s2" ]; then
        sys_cpu=$(echo "$sys_s1 $sys_s2" | awk '{dt=$3-$1; di=$4-$2; if(dt>0) printf "%.1f",(dt-di)/dt*100; else print "0.0"}')
    fi

    echo "$container_cpu $sys_cpu"
}

# -- Events --
get_event_counts() {
    local passout=0 readycheck=0 offline=0
    if [ -f "$SMAPI_LOG" ]; then
        passout=$(grep -ciE "passed out|exhausted|collapsed" "$SMAPI_LOG" 2>/dev/null || echo "0")
        readycheck=$(grep -c "ReadyCheckDialog" "$SMAPI_LOG" 2>/dev/null || echo "0")
        offline=$(grep -c "ServerOfflineMode" "$SMAPI_LOG" 2>/dev/null || echo "0")
    fi
    echo "$passout $readycheck $offline"
}

# -- Script health --
check_script_health() {
    local healthy=1
    pgrep -f "event-handler.sh" >/dev/null 2>&1 || healthy=0
    echo "$healthy"
}

# -- Update metrics and status.json --
update_metrics() {
    local game_running=0
    pgrep -f StardewModdingAPI >/dev/null 2>&1 && game_running=1

    local uptime=$(get_uptime_seconds)
    local players=$(get_player_count)
    case "$players" in ''|*[!0-9]*) players=0 ;; esac
    local game_day=$(get_game_day)
    local game_paused=$(get_game_paused)
    local mem_metrics=($(get_memory_metrics))
    local memory=${mem_metrics[0]:-0}
    local sys_mem_used=${mem_metrics[1]:-0}
    local sys_mem_total=${mem_metrics[2]:-0}
    local cpu_metrics=($(get_cpu_metrics))
    local cpu=${cpu_metrics[0]:-0.0}
    local sys_cpu=${cpu_metrics[1]:-0.0}
    local events=($(get_event_counts))
    local passout=${events[0]:-0}
    local readycheck=${events[1]:-0}
    local offline=${events[2]:-0}
    local script_health=$(check_script_health)
    local timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)

    # -- Write Prometheus metrics (atomic) --
    local tmp_metrics="${METRICS_FILE}.tmp"
    cat > "$tmp_metrics" << EOPROM
# HELP stardrop_game_running Whether the game process is running.
# TYPE stardrop_game_running gauge
stardrop_game_running $game_running

# HELP stardrop_uptime_seconds Game process uptime in seconds.
# TYPE stardrop_uptime_seconds gauge
stardrop_uptime_seconds $uptime

# HELP stardrop_players_online Number of players currently connected.
# TYPE stardrop_players_online gauge
stardrop_players_online $players

# HELP stardrop_memory_usage_mb Game process RSS memory in megabytes.
# TYPE stardrop_memory_usage_mb gauge
stardrop_memory_usage_mb $memory

# HELP stardrop_cpu_usage_percent Game process CPU usage as % of total capacity.
# TYPE stardrop_cpu_usage_percent gauge
stardrop_cpu_usage_percent $cpu

# HELP stardrop_events_passout_total Total passout events detected.
# TYPE stardrop_events_passout_total counter
stardrop_events_passout_total $passout

# HELP stardrop_events_readycheck_total Total ready-check dialog events.
# TYPE stardrop_events_readycheck_total counter
stardrop_events_readycheck_total $readycheck

# HELP stardrop_events_offline_total Total server-offline events.
# TYPE stardrop_events_offline_total counter
stardrop_events_offline_total $offline

# HELP stardrop_script_healthy Whether background scripts are running.
# TYPE stardrop_script_healthy gauge
stardrop_script_healthy $script_health
EOPROM
    mv "$tmp_metrics" "$METRICS_FILE"

    # -- Write JSON status file (atomic) --
    local tmp_status="${STATUS_FILE}.tmp"
    cat > "$tmp_status" << EOJSON
{
  "timestamp": "$timestamp",
  "server": {
    "version": "1.0.0",
    "game_running": $([ "$game_running" = "1" ] && echo "true" || echo "false"),
    "uptime_seconds": $uptime
  },
  "game": {
    "day": "$game_day",
    "players_online": $players,
    "paused": $([ "$game_paused" = "1" ] && echo "true" || echo "false")
  },
  "resources": {
    "memory_mb": $memory,
    "cpu_percent": $cpu,
    "sys_cpu_percent": $sys_cpu,
    "sys_memory_mb": $sys_mem_used,
    "sys_memory_total_mb": $sys_mem_total
  },
  "events": {
    "passout": $passout,
    "readycheck": $readycheck,
    "offline": $offline
  },
  "scripts_healthy": $([ "$script_health" = "1" ] && echo "true" || echo "false")
}
EOJSON
    mv "$tmp_status" "$STATUS_FILE"
}

# -- HTTP metrics server --
serve_metrics() {
    log "Starting Prometheus metrics HTTP server on port $METRICS_PORT..."

    while true; do
        local body=""
        if [ -f "$METRICS_FILE" ]; then
            body=$(cat "$METRICS_FILE" 2>/dev/null)
        else
            body="# No metrics available yet"
        fi

        local content_length=${#body}

        {
            echo -e "HTTP/1.1 200 OK\r"
            echo -e "Content-Type: text/plain; version=0.0.4; charset=utf-8\r"
            echo -e "Content-Length: ${content_length}\r"
            echo -e "Connection: close\r"
            echo -e "\r"
            echo -n "$body"
        } | nc -l "$METRICS_PORT" -q 1 -w 5 >/dev/null 2>&1
    done
}

# -- Main --
log "Status reporter starting..."
log "  Metrics port:    $METRICS_PORT"
log "  Update interval: ${UPDATE_INTERVAL}s"
log "  Status file:     $STATUS_FILE"
log "  SMAPI log:       $SMAPI_LOG"

sleep 30

serve_metrics &
SERVE_PID=$!
log "✅ HTTP metrics server started (PID: $SERVE_PID)"

while true; do
    update_metrics
    sleep $UPDATE_INTERVAL
done