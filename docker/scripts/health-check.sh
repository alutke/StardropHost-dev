#!/bin/bash
# ===========================================
# StardropHost | scripts/health-check.sh
# ===========================================
# Quick health check for the StardropHost stack.
# Returns exit 0 if healthy, non-zero if any
# critical component has failed.
#
# Usage: health-check.sh [--json]
# ===========================================

SMAPI_LOG="/home/steam/.config/StardewValley/ErrorLogs/SMAPI-latest.txt"
STATUS_FILE="/home/steam/.local/share/stardrop/status.json"
LIVE_FILE="/home/steam/.local/share/stardrop/live-status.json"
PANEL_PORT="${PANEL_PORT:-18642}"
STALE_THRESHOLD=120   # seconds before a status file is considered stale
LOG_STALE_THRESHOLD=300

JSON_MODE=false
[ "${1:-}" = "--json" ] && JSON_MODE=true

# -- Colors (suppressed in JSON mode) --
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

pass() { $JSON_MODE || echo -e "  ${GREEN}✅${NC} $1"; }
warn() { $JSON_MODE || echo -e "  ${YELLOW}⚠️ ${NC} $1"; }
fail() { $JSON_MODE || echo -e "  ${RED}❌${NC} $1"; }

OVERALL=0

check_panel() {
    if curl -sf --max-time 5 "http://localhost:${PANEL_PORT}/api/auth/status" >/dev/null 2>&1; then
        pass "Web panel responding on port $PANEL_PORT"
        echo "panel_ok"
    else
        fail "Web panel not responding on port $PANEL_PORT"
        echo "panel_fail"
        OVERALL=1
    fi
}

check_game() {
    local game_pid
    game_pid=$(pgrep -f 'StardewModdingAPI' 2>/dev/null | head -1)
    if [ -n "$game_pid" ]; then
        pass "SMAPI running (PID $game_pid)"
        echo "game_ok"
    else
        warn "SMAPI not running (server may be stopped)"
        echo "game_stopped"
    fi
}

check_smapi_log() {
    if [ ! -f "$SMAPI_LOG" ]; then
        warn "SMAPI log not found (game has not started yet)"
        echo "log_missing"
        return
    fi
    local age=$(( $(date +%s) - $(stat -c %Y "$SMAPI_LOG" 2>/dev/null || echo 0) ))
    if [ "$age" -lt "$LOG_STALE_THRESHOLD" ]; then
        pass "SMAPI log fresh (${age}s old)"
        echo "log_ok"
    else
        warn "SMAPI log stale (${age}s old — game may not be writing)"
        echo "log_stale"
    fi
}

check_status_file() {
    if [ ! -f "$STATUS_FILE" ]; then
        warn "status.json missing (status-reporter.sh may not have run yet)"
        echo "status_missing"
        return
    fi
    local age=$(( $(date +%s) - $(stat -c %Y "$STATUS_FILE" 2>/dev/null || echo 0) ))
    if [ "$age" -lt "$STALE_THRESHOLD" ]; then
        pass "status.json fresh (${age}s old)"
        echo "status_ok"
    else
        warn "status.json stale (${age}s old)"
        echo "status_stale"
    fi
}

check_live_file() {
    if [ ! -f "$LIVE_FILE" ]; then
        warn "live-status.json missing (StardropDashboard mod not yet written)"
        echo "live_missing"
        return
    fi
    local age=$(( $(date +%s) - $(stat -c %Y "$LIVE_FILE" 2>/dev/null || echo 0) ))
    if [ "$age" -lt "$STALE_THRESHOLD" ]; then
        pass "live-status.json fresh (${age}s old)"
        echo "live_ok"
    else
        warn "live-status.json stale (${age}s old)"
        echo "live_stale"
    fi
}

check_disk() {
    local usage
    usage=$(df /home/steam 2>/dev/null | awk 'NR==2 {print $5}' | tr -d '%')
    if [ -z "$usage" ]; then
        warn "Could not determine disk usage"
        echo "disk_unknown"
        return
    fi
    if [ "$usage" -lt 85 ]; then
        pass "Disk usage ${usage}%"
        echo "disk_ok"
    elif [ "$usage" -lt 95 ]; then
        warn "Disk usage high: ${usage}%"
        echo "disk_warn"
    else
        fail "Disk usage critical: ${usage}%"
        echo "disk_critical"
        OVERALL=1
    fi
}

# -- Run checks --
if ! $JSON_MODE; then
    echo ""
    echo "StardropHost Health Check"
    echo "========================="
fi

PANEL_RESULT=$(check_panel)
GAME_RESULT=$(check_game)
LOG_RESULT=$(check_smapi_log)
STATUS_RESULT=$(check_status_file)
LIVE_RESULT=$(check_live_file)
DISK_RESULT=$(check_disk)

if $JSON_MODE; then
    cat <<EOF
{
  "panel":   "$PANEL_RESULT",
  "game":    "$GAME_RESULT",
  "log":     "$LOG_RESULT",
  "status":  "$STATUS_RESULT",
  "live":    "$LIVE_RESULT",
  "disk":    "$DISK_RESULT",
  "healthy": $([ $OVERALL -eq 0 ] && echo true || echo false)
}
EOF
else
    echo ""
    if [ $OVERALL -eq 0 ]; then
        echo -e "${GREEN}Health check passed${NC}"
    else
        echo -e "${RED}Health check failed — see above${NC}"
    fi
    echo ""
fi

exit $OVERALL
