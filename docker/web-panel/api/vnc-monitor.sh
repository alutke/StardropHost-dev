#!/bin/bash
# ===========================================
# StardropHost | scripts/vnc-monitor.sh
# ===========================================
# Monitors x11vnc and automatically restarts
# it if the process dies or becomes a zombie.
#
# Also supports direct commands:
#   vnc-monitor.sh start   — start x11vnc
#   vnc-monitor.sh stop    — stop x11vnc
#   vnc-monitor.sh status  — print health
#
# Notifies the web panel on client connect
# so one-time passwords reset correctly.
# ===========================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[VNC-Monitor]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[VNC-Monitor]${NC} $1"; }
log_error() { echo -e "${RED}[VNC-Monitor]${NC} $1"; }
log_debug() { echo -e "${BLUE}[VNC-Monitor]${NC} [DEBUG] $1"; }

# -- Config --
VNC_PORT="${VNC_PORT:-5900}"
VNC_DISPLAY="${DISPLAY:-:99}"
VNC_PASSWORD="${VNC_PASSWORD:-stardew1}"
CHECK_INTERVAL="${VNC_CHECK_INTERVAL:-30}"
WEB_PANEL_URL="${WEB_PANEL_URL:-http://localhost:18642}"

# -- Health check --
is_vnc_healthy() {
    local vnc_pids
    vnc_pids=$(pgrep -f "x11vnc.*$VNC_PORT" 2>/dev/null)
    if [ -z "$vnc_pids" ]; then
        log_warn "No x11vnc process found"
        return 1
    fi

    # Check for zombie processes
    for pid in $vnc_pids; do
        local state
        state=$(ps -p "$pid" -o stat= 2>/dev/null)
        if [[ "$state" == *"Z"* ]]; then
            log_error "x11vnc process $pid is zombie"
            return 1
        fi
    done

    # Check port is listening
    if ! ss -tln 2>/dev/null | grep -q ":$VNC_PORT.*LISTEN"; then
        if ! netstat -tln 2>/dev/null | grep -q ":$VNC_PORT.*LISTEN"; then
            log_error "Port $VNC_PORT is not listening"
            return 1
        fi
    fi

    return 0
}

# -- Start x11vnc --
start_vnc() {
    log_info "Starting x11vnc..."

    pkill -9 -f "x11vnc.*$VNC_PORT" 2>/dev/null
    sleep 2

    # If a VNC password file exists (set by the web panel), use it.
    # Otherwise fall back to the env var password.
    local passwd_args=()
    if [ -f /tmp/vncpasswd ]; then
        passwd_args=(-rfbauth /tmp/vncpasswd)
    else
        passwd_args=(-passwd "$VNC_PASSWORD")
    fi

    DISPLAY=$VNC_DISPLAY x11vnc \
        -display "$VNC_DISPLAY" \
        "${passwd_args[@]}" \
        -rfbport "$VNC_PORT" \
        -forever \
        -shared \
        -noxdamage \
        -bg \
        -afteraccept "$(realpath "$0") _on_connect" \
        -o /tmp/x11vnc.log \
        2>&1 | grep -v "Have you tried" | head -5

    sleep 3

    if is_vnc_healthy; then
        log_info "✅ x11vnc started on port $VNC_PORT"
        return 0
    else
        log_error "Failed to start x11vnc"
        return 1
    fi
}

# -- Stop x11vnc --
stop_vnc() {
    log_info "Stopping x11vnc..."
    pkill -f "x11vnc.*$VNC_PORT" 2>/dev/null
    sleep 2
    if ! pgrep -f "x11vnc.*$VNC_PORT" >/dev/null 2>&1; then
        log_info "✅ x11vnc stopped"
        return 0
    else
        pkill -9 -f "x11vnc.*$VNC_PORT" 2>/dev/null
        log_warn "Force killed x11vnc"
        return 0
    fi
}

# -- Client connect hook --
# Called by x11vnc -afteraccept when a client connects.
# Notifies the web panel so it can reset a one-time password.
on_client_connect() {
    log_info "VNC client connected — notifying web panel"
    curl -sf -X POST "${WEB_PANEL_URL}/api/vnc/connected" \
        -H "Content-Type: application/json" \
        --max-time 5 \
        >/dev/null 2>&1 || log_warn "Failed to notify web panel of VNC connection"
}

# -- Status --
print_status() {
    if is_vnc_healthy; then
        log_info "x11vnc is running and healthy on port $VNC_PORT"
        return 0
    else
        log_warn "x11vnc is not running or unhealthy"
        return 1
    fi
}

# -- Monitor loop --
run_monitor() {
    log_info "VNC Monitor started (check interval: ${CHECK_INTERVAL}s)"
    log_info "Monitoring x11vnc on port $VNC_PORT"

    if is_vnc_healthy; then
        log_info "✅ x11vnc is already running and healthy"
    else
        log_warn "Initial health check failed, starting x11vnc..."
        start_vnc
    fi

    local check_count=0
    local restart_count=0

    while true; do
        sleep "$CHECK_INTERVAL"
        check_count=$((check_count + 1))

        if ! is_vnc_healthy; then
            log_warn "Health check #$check_count failed, restarting..."
            if start_vnc; then
                restart_count=$((restart_count + 1))
                log_info "✅ x11vnc restarted (restart count: $restart_count)"
            else
                log_error "Failed to restart x11vnc (restart count: $restart_count)"
            fi
        else
            if [ $((check_count % 10)) -eq 0 ]; then
                log_debug "Health check #$check_count passed (restarts: $restart_count)"
            fi
        fi
    done
}

trap 'log_info "VNC monitor shutting down..."; exit 0' SIGTERM SIGINT

# -- Entry point --
case "${1:-}" in
    start)      start_vnc ;;
    stop)       stop_vnc ;;
    status)     print_status ;;
    _on_connect) on_client_connect ;;
    *)          run_monitor ;;
esac