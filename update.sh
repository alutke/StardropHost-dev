#!/bin/bash
# ===========================================
# StardropHost | update.sh
# ===========================================
# Pulls the latest code from GitHub and does
# an incremental Docker rebuild — only layers
# that changed are rebuilt, so this is fast
# for most updates (typically 1–3 minutes).
#
# Run this whenever you want to apply the
# latest StardropHost changes to your server.
#
# Usage:
#   sudo bash update.sh
#
# Note: Your server will be offline briefly
# while containers are stopped and restarted.
# Game saves are not affected.
# ===========================================

set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"

# -- Colors --
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'
BOLD='\033[1m'

print_header() {
    echo ""
    echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${CYAN}${BOLD}  StardropHost — Update${NC}"
    echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
}
print_success() { echo -e "${GREEN}[OK]   $1${NC}"; }
print_error()   { echo -e "${RED}[ERR]  $1${NC}"; }
print_warning() { echo -e "${YELLOW}[WARN] $1${NC}"; }
print_info()    { echo -e "${BLUE}[>>]   $1${NC}"; }
print_step()    { echo ""; echo -e "${BOLD}$1${NC}"; }

# -- Require root --
if [ "$(id -u)" != "0" ]; then
    exec sudo bash "$0" "$@"
fi

# -- Resolve compose command --
if docker compose version &>/dev/null 2>&1; then
    COMPOSE_CMD="docker compose"
elif command -v docker-compose &>/dev/null; then
    COMPOSE_CMD="docker-compose"
else
    echo -e "${RED}[ERR]  Docker Compose not found. Is Docker installed?${NC}"
    exit 1
fi

# -- Detect container prefix from .env --
CONTAINER_PREFIX="stardrop"
if [ -f "$SCRIPT_DIR/.env" ]; then
    _prefix=$(grep -E '^CONTAINER_PREFIX=' "$SCRIPT_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d '"' | tr -d "'")
    [ -n "$_prefix" ] && CONTAINER_PREFIX="$_prefix"
fi

cd "$SCRIPT_DIR" || { echo -e "${RED}[ERR]  Cannot cd to $SCRIPT_DIR${NC}"; exit 1; }

print_header
print_info "Directory:  $SCRIPT_DIR"
print_info "Container:  ${CONTAINER_PREFIX}-server"
echo ""

# -- Step 1: Pull latest code from GitHub --
print_step "Step 1: Pulling latest code from GitHub..."
print_info "Fetching any new commits from the main branch..."
if command -v git &>/dev/null && [ -d "$SCRIPT_DIR/.git" ]; then
    BEFORE=$(git -C "$SCRIPT_DIR" rev-parse --short HEAD 2>/dev/null)
    if git -C "$SCRIPT_DIR" pull; then
        AFTER=$(git -C "$SCRIPT_DIR" rev-parse --short HEAD 2>/dev/null)
        if [ "$BEFORE" != "$AFTER" ]; then
            print_success "Updated  $BEFORE → $AFTER"
            git -C "$SCRIPT_DIR" log --oneline "${BEFORE}..${AFTER}" 2>/dev/null \
                | while read -r line; do print_info "  $line"; done
        else
            print_success "Already up to date ($AFTER)"
        fi
    else
        print_warning "Git pull failed — building from current local files"
        print_info "Check your network connection or resolve any merge conflicts"
    fi
else
    print_info "Not a git repository or git not installed — skipping pull"
    print_info "Files on disk will be used as-is"
fi

# -- Step 2: Stop containers --
print_step "Step 2: Stopping containers..."
print_info "Gracefully shutting down the server and web panel..."
$COMPOSE_CMD down
print_success "Containers stopped"

# -- Step 3: Rebuild image (incremental) --
print_step "Step 3: Rebuilding Docker image..."
print_info "Docker will reuse cached layers for anything that hasn't changed."
print_info "Only modified files (scripts, web panel, config) are rebuilt — this is fast."
echo ""

if ! $COMPOSE_CMD build stardrop-server; then
    echo ""
    print_error "Build failed — check the output above for the cause."
    echo ""
    echo "  Common causes:"
    echo "    - No internet connection during build"
    echo "    - Not enough disk space (need ~500 MB free for rebuild)"
    echo "    - A syntax error in a recently changed file"
    echo ""
    echo "  Fix the error and re-run:  sudo bash update.sh"
    exit 1
fi

print_success "Image rebuilt successfully"

# -- Step 4: Start containers --
print_step "Step 4: Starting containers..."
print_info "Bringing the server and web panel back online..."

if ! $COMPOSE_CMD up -d; then
    print_error "Failed to start containers!"
    echo ""
    echo "  Check what went wrong:"
    echo -e "    ${CYAN}$COMPOSE_CMD logs${NC}"
    exit 1
fi

print_success "Containers started"

# -- Resolve IP and panel port for the done message --
LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
if [ -z "$LOCAL_IP" ] && command -v ip &>/dev/null; then
    LOCAL_IP=$(ip route get 1.1.1.1 2>/dev/null | awk '/src/{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1);exit}}')
fi
SERVER_IP="${LOCAL_IP:-your-server-ip}"

PANEL_PORT="18642"
if [ -f "$SCRIPT_DIR/.env" ]; then
    _port=$(grep -E '^PANEL_PORT=' "$SCRIPT_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d '"' | tr -d "'")
    [ -n "$_port" ] && PANEL_PORT="$_port"
fi

# -- Done --
echo ""
echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}${BOLD}  Update complete!${NC}"
echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  Web panel:"
echo ""
echo -e "    ${CYAN}${BOLD}http://${SERVER_IP}:${PANEL_PORT}${NC}"
echo ""
echo -e "  Streaming live server logs below."
echo -e "  ${YELLOW}Press Ctrl+C to stop watching — the server keeps running.${NC}"
echo ""

sleep 2
docker logs -f "${CONTAINER_PREFIX}-server" 2>/dev/null \
    || docker logs -f "${CONTAINER_PREFIX}" 2>/dev/null \
    || $COMPOSE_CMD logs -f stardrop-server || true

echo ""
echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "    ${CYAN}${BOLD}cd ./$(basename "$SCRIPT_DIR")${NC}"
echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
