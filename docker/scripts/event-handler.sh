#!/bin/bash
# ===========================================
# StardropHost | scripts/event-handler.sh
# ===========================================
# Monitors SMAPI logs in real time and handles
# all game events via a single tail -F stream.
#
# Handles:
#   - Passout (2AM)     : Escape + Enter confirmations
#   - ReadyCheckDialog  : Enter confirmations
#   - ServerOfflineMode : F9 to re-enable server
#
# Note: Save loaded / AlwaysOnServer enable logic removed.
# StardropHost.Dependencies mod handles headless server
# behaviour natively — no xdotool F9 press needed.
# ===========================================

SMAPI_LOG="/home/steam/.config/StardewValley/ErrorLogs/SMAPI-latest.txt"
LOCK_FILE="/tmp/stardrop-key-lock"
LOCK_TIMEOUT=10

# -- Cooldown tracking --
LAST_PASSOUT_TIME=0
LAST_READYCHECK_TIME=0
LAST_OFFLINE_TIME=0

PASSOUT_COOLDOWN=30
READYCHECK_COOLDOWN=10
OFFLINE_COOLDOWN=60

# -- Colors --
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m'

log_passout()    { echo -e "${YELLOW}[Event-Passout]${NC} $1"; }
log_readycheck() { echo -e "${PURPLE}[Event-ReadyCheck]${NC} $1"; }
log_reconnect()  { echo -e "${CYAN}[Event-Reconnect]${NC} $1"; }
log_info()       { echo -e "${GREEN}[Event-Handler]${NC} $1"; }

export DISPLAY=:99

# -- Send key with mutex lock --
send_key_locked() {
    local key="$1"
    (
        if flock -w "$LOCK_TIMEOUT" 200; then
            xdotool key "$key" 2>/dev/null
        else
            log_info "Could not acquire key lock (key: $key)"
            return 1
        fi
    ) 200>"$LOCK_FILE"
}

# -- Cooldown check --
check_cooldown() {
    local last_time="$1"
    local cooldown="$2"
    local current_time
    current_time=$(date +%s)
    [ $((current_time - last_time)) -lt "$cooldown" ] && return 1
    return 0
}

# -- Handle passout (2AM) --
handle_passout() {
    check_cooldown "$LAST_PASSOUT_TIME" "$PASSOUT_COOLDOWN" || return
    log_passout "Passout event detected (2AM)"
    LAST_PASSOUT_TIME=$(date +%s)

    if ! command -v xdotool >/dev/null 2>&1; then
        log_passout "xdotool not installed"
        return
    fi

    sleep 3

    log_passout "Step 1: Closing any open menus..."
    send_key_locked Escape
    sleep 0.5

    log_passout "Step 2: Confirming dialogs..."
    for i in 1 2 3 4 5; do
        send_key_locked Return
        sleep 1
    done

    log_passout "Passout dialogs confirmed"

    sleep 5
    if tail -20 "$SMAPI_LOG" 2>/dev/null | grep -qiE "Saving|woke up|Day [0-9]"; then
        log_passout "✅ New day confirmed"
    fi
}

# -- Handle ReadyCheckDialog --
handle_readycheck() {
    check_cooldown "$LAST_READYCHECK_TIME" "$READYCHECK_COOLDOWN" || return
    log_readycheck "ReadyCheckDialog detected"
    LAST_READYCHECK_TIME=$(date +%s)

    if ! command -v xdotool >/dev/null 2>&1; then
        log_readycheck "xdotool not installed"
        return
    fi

    sleep 2

    log_readycheck "Sending Enter key to confirm..."
    for i in 1 2 3; do
        send_key_locked Return
        sleep 0.5
    done
    log_readycheck "✅ Confirmation sent"
}

# -- Handle ServerOfflineMode --
handle_offline() {
    check_cooldown "$LAST_OFFLINE_TIME" "$OFFLINE_COOLDOWN" || return
    log_reconnect "ServerOfflineMode detected"
    LAST_OFFLINE_TIME=$(date +%s)

    if ! command -v xdotool >/dev/null 2>&1; then
        log_reconnect "xdotool not installed"
        return
    fi

    sleep 5
    log_reconnect "Attempting to re-enable server..."

    for i in 1 2 3; do
        send_key_locked Escape
        sleep 0.2
    done
    sleep 1

    send_key_locked F9
    sleep 2
    send_key_locked F9

    log_reconnect "✅ F9 sent, waiting for confirmation..."
}

# ===========================================
# Main
# ===========================================

log_info "========================================"
log_info "  Unified Event Handler Starting..."
log_info "========================================"
log_info ""
log_info "Monitoring events:"
log_info "  - Passout (2AM)"
log_info "  - ReadyCheckDialog"
log_info "  - ServerOfflineMode"
log_info ""

log_info "Waiting for game to initialize..."
sleep 20

# Wait for SMAPI log file
WAIT_COUNT=0
while [ ! -f "$SMAPI_LOG" ]; do
    if [ $((WAIT_COUNT % 12)) -eq 0 ]; then
        log_info "Waiting for SMAPI log file..."
    fi
    sleep 5
    WAIT_COUNT=$((WAIT_COUNT + 1))
    if [ "$WAIT_COUNT" -gt 60 ]; then
        log_info "Still waiting for log file..."
        WAIT_COUNT=0
    fi
done

log_info "✅ SMAPI log ready: $SMAPI_LOG"

LINE_COUNT=0
HEARTBEAT_INTERVAL=3600

log_info "Starting real-time log monitoring (tail -F)..."

# -n 0: start from end of file
# -F: follow even if rotated/replaced
tail -n 0 -F "$SMAPI_LOG" 2>/dev/null | while IFS= read -r line; do
    LINE_COUNT=$((LINE_COUNT + 1))

    if [ $((LINE_COUNT % HEARTBEAT_INTERVAL)) -eq 0 ]; then
        log_info "Event handler running (processed $LINE_COUNT lines)"
    fi

    case "$line" in
        *"ServerOfflineMode"*|*"[ServerOfflineMode]"*)
            handle_offline
            ;;
        *"ReadyCheckDialog"*)
            handle_readycheck
            ;;
        *"passed out"*|*"Passed Out"*|*"exhausted"*|*"Exhausted"*|*"collapsed"*|*"Collapsed"*)
            handle_passout
            ;;
    esac
done

# Restart if tail -F exits unexpectedly
log_info "tail -F exited unexpectedly, restarting in 10s..."
sleep 10
exec "$0" "$@"