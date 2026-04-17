#!/bin/bash
# ===========================================
# StardropHost | health-check.sh
# ===========================================
# Checks if your server is running correctly.
# Usage: bash scripts/health-check.sh
# ===========================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# -- Colors --
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'
BOLD='\033[1m'

# -- Config --
CONTAINER_NAME="stardrop"

# -- Counters --
TESTS_PASSED=0
TESTS_FAILED=0
WARNINGS=0

# -- Output Helpers --
print_success() { echo -e "${GREEN}✅ $1${NC}"; ((TESTS_PASSED++)); }
print_error()   { echo -e "${RED}❌ $1${NC}"; ((TESTS_FAILED++)); }
print_warning() { echo -e "${YELLOW}⚠️  $1${NC}"; ((WARNINGS++)); }
print_info()    { echo -e "${BLUE}ℹ️  $1${NC}"; }
print_test()    { echo ""; echo -e "${BOLD}$1${NC}"; }

echo ""
echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${CYAN}${BOLD}  🌟 StardropHost - Health Check${NC}"
echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# -- 1. Docker --
check_docker() {
    print_test "1. Checking Docker..."

    if ! command -v docker &> /dev/null; then
        print_error "Docker is not installed"
        return 1
    fi

    if ! docker ps &> /dev/null; then
        print_error "Docker is not running or requires sudo"
        return 1
    fi

    docker_version=$(docker --version | cut -d' ' -f3 | tr -d ',')
    print_success "Docker is running (v$docker_version)"
}

# -- 2. Container status --
check_container_running() {
    print_test "2. Checking container status..."

    if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        print_error "Container is not running"

        if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
            print_info "Container exists but is stopped"
            echo -e "  Start it: ${CYAN}docker compose up -d${NC}"
        else
            print_info "Container does not exist"
            echo -e "  Run: ${CYAN}bash quick-start.sh${NC}"
        fi
        return 1
    fi

    uptime=$(docker inspect -f '{{.State.StartedAt}}' $CONTAINER_NAME)
    print_success "Container is running (started: $uptime)"
}

# -- 3. Container health --
check_container_health() {
    print_test "3. Checking container health..."

    health_status=$(docker inspect -f '{{.State.Health.Status}}' $CONTAINER_NAME 2>/dev/null || echo "none")

    case "$health_status" in
        healthy)   print_success "Container health: healthy" ;;
        starting)  print_warning "Container health: starting (still initializing)" ;;
        unhealthy)
            print_error "Container health: unhealthy"
            print_info "Check logs: docker logs $CONTAINER_NAME"
            return 1
            ;;
        *)         print_warning "No health check configured" ;;
    esac
}

# -- 4. SMAPI process --
check_smapi_running() {
    print_test "4. Checking SMAPI..."

    if docker exec $CONTAINER_NAME pgrep -f StardewModdingAPI &> /dev/null; then
        pid=$(docker exec $CONTAINER_NAME pgrep -f StardewModdingAPI)
        print_success "SMAPI is running (PID: $pid)"
    else
        print_error "SMAPI is not running"
        print_info "Game may still be initializing"
        print_info "Check logs: docker logs -f $CONTAINER_NAME"
        return 1
    fi
}

# -- 5. Mods --
check_mods_loaded() {
    print_test "5. Checking mods..."

    mod_count=$(docker logs --tail 100 $CONTAINER_NAME 2>&1 | grep -c "Loaded.*mod" || true)

    if [ "$mod_count" -ge 3 ]; then
        print_success "Mods loaded ($mod_count detected)"
        print_info "Checking for core mods..."
        docker logs --tail 200 $CONTAINER_NAME 2>&1 | grep "Loaded.*mod" | \
            grep -i "AlwaysOnServer\|AutoHideHost\|ServerAutoLoad\|SkillLevelGuard\|StardropDashboard" | \
            while read -r line; do
                echo -e "  ${CYAN}→${NC} $(echo "$line" | grep -oP 'Loaded \K.*')"
            done
    elif [ "$mod_count" -gt 0 ]; then
        print_warning "Some mods loaded ($mod_count), expected at least 3"
    else
        print_warning "No mods detected yet (server may still be starting)"
    fi
}

# -- 6. Ports --
check_ports() {
    print_test "6. Checking ports..."

    if docker port $CONTAINER_NAME 24642/udp &> /dev/null; then
        game_port=$(docker port $CONTAINER_NAME 24642/udp)
        print_success "Game port mapped: $game_port"
    else
        print_error "Game port (24642/udp) is not mapped"
        return 1
    fi

    if docker port $CONTAINER_NAME 18642/tcp &> /dev/null; then
        panel_port=$(docker port $CONTAINER_NAME 18642/tcp)
        print_success "Web panel port mapped: $panel_port"
    else
        print_warning "Web panel port (18642/tcp) is not mapped"
    fi

    if docker port $CONTAINER_NAME 5900/tcp &> /dev/null; then
        vnc_port=$(docker port $CONTAINER_NAME 5900/tcp)
        print_info "VNC port mapped: $vnc_port"
    else
        print_info "VNC port not mapped (disabled by default)"
    fi
}

# -- 7. Resources --
check_resources() {
    print_test "7. Checking resource usage..."

    stats=$(docker stats $CONTAINER_NAME --no-stream --format "{{.CPUPerc}},{{.MemUsage}}")
    cpu=$(echo $stats | cut -d',' -f1)
    mem=$(echo $stats | cut -d',' -f2)

    echo -e "  ${CYAN}CPU:${NC}    $cpu"
    echo -e "  ${CYAN}Memory:${NC} $mem"

    mem_percent=$(echo $mem | grep -oP '\d+\.\d+%' | head -1 | tr -d '%')
    if (( $(echo "$mem_percent > 90" | bc -l 2>/dev/null || echo 0) )); then
        print_warning "Memory usage is high (${mem_percent}%)"
        print_info "Consider increasing MEMORY_LIMIT in .env"
    else
        print_success "Resource usage is normal"
    fi
}

# -- 8. Disk space --
check_disk_space() {
    print_test "8. Checking disk space..."

    if [ ! -d "$PROJECT_DIR/data" ]; then
        print_warning "Data directory not found"
        return 1
    fi

    data_size=$(du -sh "$PROJECT_DIR/data" 2>/dev/null | cut -f1 || echo "unknown")
    available_space=$(df -h "$PROJECT_DIR" | tail -1 | awk '{print $4}')

    echo -e "  ${CYAN}Data size:${NC}       $data_size"
    echo -e "  ${CYAN}Available space:${NC} $available_space"

    print_success "Disk space checked"
}

# -- 9. Firewall --
check_firewall() {
    print_test "9. Firewall reminder..."

    print_info "Ensure port 24642/udp is open in your firewall:"
    echo ""
    echo "  Ubuntu/Debian:"
    echo -e "    ${CYAN}sudo ufw allow 24642/udp${NC}"
    echo ""
    echo "  CentOS/RHEL:"
    echo -e "    ${CYAN}sudo firewall-cmd --add-port=24642/udp --permanent${NC}"
    echo -e "    ${CYAN}sudo firewall-cmd --reload${NC}"
    echo ""
}

# -- Summary --
show_summary() {
    echo ""
    echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BOLD}  Summary${NC}"
    echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo -e "${GREEN}  ✅ Passed:   $TESTS_PASSED${NC}"
    [ $TESTS_FAILED -gt 0 ] && echo -e "${RED}  ❌ Failed:   $TESTS_FAILED${NC}"
    [ $WARNINGS -gt 0 ]     && echo -e "${YELLOW}  ⚠️  Warnings: $WARNINGS${NC}"
    echo ""

    if [ $TESTS_FAILED -eq 0 ]; then
        echo -e "${GREEN}${BOLD}  🌟 Server is healthy!${NC}"
        echo ""
        echo -e "  Web panel:  ${CYAN}http://$(get_server_ip):18642${NC}"
        echo -e "  Game port:  ${CYAN}$(get_server_ip):24642${NC}"
    else
        echo -e "${YELLOW}${BOLD}  ⚠️  Some issues detected!${NC}"
        echo ""
        echo "  Check the errors above and:"
        echo -e "    View logs:  ${CYAN}docker logs -f $CONTAINER_NAME${NC}"
        echo -e "    Restart:    ${CYAN}docker compose restart${NC}"
    fi
    echo ""
}

get_server_ip() {
    if command -v curl &> /dev/null; then
        public_ip=$(curl -s ifconfig.me 2>/dev/null || echo "")
        [ -n "$public_ip" ] && echo "$public_ip" && return
    fi
    command -v hostname &> /dev/null && \
        hostname -I 2>/dev/null | awk '{print $1}' || echo "your-server-ip"
}

# -- Run --
check_docker           || true
check_container_running || true
check_container_health  || true
check_smapi_running     || true
check_mods_loaded       || true
check_ports             || true
check_resources         || true
check_disk_space        || true
check_firewall          || true

show_summary
