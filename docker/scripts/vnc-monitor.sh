#!/bin/bash
# ===========================================
# StardropHost | scripts/vnc-monitor.sh
# ===========================================
# Monitors x11vnc and automatically restarts
# it if the process dies or becomes a zombie.
# ===========================================

# -- Colors --
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

# -- Health check --
is_vnc_healthy() {
    # Check process exists
    local vnc_pids=$(pgrep -f "x11vnc.*$VNC_PORT" 2>/dev/null)
    if [ -z "$vnc_pids" ]; then
        log_warn "No x11vnc process found"
        return 1
    fi

    # Check for zombie processes
    for pid in $vnc_pids; do
        local state=$(ps -p $pid -o stat=)
        if [[ "$state" == *"Z"* ]]; then
            log_error "x11vnc process $pid is zombie"
            return 1
        fi
    done

    # Check port is listening
    if ! netstat -tln 2>/dev/null | grep -q ":$VNC_PORT.*LISTEN"; then
        if ! ss -tln 2>/dev/null | grep -q ":$VNC_PORT.*LISTEN"; then
            log_error "Port $VNC_PORT is not listening"
            return 1
        fi
    fi

    return 0
}

# -- Start/restart x11vnc --
start_vnc() {
    log_info "Starting x11vnc..."

    pkill -9 -f "x11vnc.*$VNC_PORT" 2>/dev/null
    sleep 2

    DISPLAY=$VNC_DISPLAY x11vnc \
        -display $VNC_DISPLAY \
        -passwd "$VNC_PASSWORD" \
        -rfbport $VNC_PORT \
        -forever \
        -shared \
        -noxdamage \
        -bg \
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

# -- Main --
main() {
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
        sleep $CHECK_INTERVAL
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

case "${1:-}" in
  start)
    start_vnc
    exit $?
    ;;
  stop)
    log_info "Stopping VNC..."
    pkill -f "x11vnc.*$VNC_PORT" 2>/dev/null || true
    pkill -f "vnc-monitor.sh" 2>/dev/null || true
    exit 0
    ;;
  status)
    if is_vnc_healthy; then
      log_info "x11vnc is running on port $VNC_PORT"
      exit 0
    else
      log_warn "x11vnc is not running"
      exit 1
    fi
    ;;
  _on_connect)
    # Called by x11vnc -afteraccept hook — reset one-time password back to default
    log_info "Client connected — resetting VNC password to default"
    curl -s -X POST http://localhost:18642/api/vnc/connected 2>/dev/null || true
    exit 0
    ;;
  *)
    main
    ;;
esac