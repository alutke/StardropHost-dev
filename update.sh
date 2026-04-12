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

_UPDATE_STARTED_AT=$(date +%s)
_UPDATE_STATUS_FILE=""   # set after SCRIPT_DIR is confirmed

write_status() {
    local step="$1" msg="$2"
    [ -z "$_UPDATE_STATUS_FILE" ] && return
    mkdir -p "$(dirname "$_UPDATE_STATUS_FILE")"
    printf '{"step":"%s","message":"%s","startedAt":%s,"updatedAt":%s}\n' \
        "$step" "$msg" "$_UPDATE_STARTED_AT" "$(date +%s)" \
        > "$_UPDATE_STATUS_FILE"
}

check_cancel() {
    local cancel_file="$SCRIPT_DIR/data/panel/update-cancel"
    if [ -f "$cancel_file" ]; then
        rm -f "$cancel_file" "$_UPDATE_STATUS_FILE"
        print_warning "Update cancelled by user — restoring containers"
        $COMPOSE_CMD up -d 2>/dev/null || true
        exit 0
    fi
}

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

# -- Flags --
_IS_SIBLING=false   # set when called from another instance's update (skip re-prompting)
_UPDATE_ALL=false   # set when dashboard requests update of all instances (no interactive prompt)
_SHOW_LOGS=false    # set with --log to tail startup logs after update
for _arg in "$@"; do
    [ "$_arg" = "--sibling" ] && _IS_SIBLING=true
    [ "$_arg" = "--all"     ] && _UPDATE_ALL=true
    [ "$_arg" = "--log"     ] && _SHOW_LOGS=true
done

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
_UPDATE_STATUS_FILE="$SCRIPT_DIR/data/panel/update-status.json"

# -- Extract specific variables from .env without sourcing it as shell code --
# Sourcing .env with set -a would execute any shell code inside it as root.
# Docker Compose reads .env natively, so we only need to extract the variables
# the script itself uses for display and sibling detection.
_env_get() {
    grep -E "^${1}=" "$SCRIPT_DIR/.env" 2>/dev/null \
        | head -1 | cut -d= -f2- | tr -d '"' | sed "s/^'//;s/'$//"
}
if [ -f "$SCRIPT_DIR/.env" ]; then
    _env_panel_port=$(_env_get PANEL_PORT)
    [ -n "$_env_panel_port" ] && PANEL_PORT="$_env_panel_port"
fi

print_header
print_info "Directory:  $SCRIPT_DIR"
print_info "Container:  ${CONTAINER_PREFIX}-server"
echo ""

# -- Detect sibling instances and ask whether to update them all --
_UPDATE_SIBLINGS=()
_PARENT_DIR="$(dirname "$SCRIPT_DIR")"
if [ "$_IS_SIBLING" = "false" ]; then
    for _dir in "$_PARENT_DIR"/stardrophost*/; do
        _dir="${_dir%/}"
        [ "$_dir" = "$SCRIPT_DIR" ] && continue
        [ -f "$_dir/update.sh" ] || continue
        _UPDATE_SIBLINGS+=("$_dir")
    done
    if [ ${#_UPDATE_SIBLINGS[@]} -gt 0 ]; then
        echo -e "${CYAN}${BOLD}  Multi-instance detected${NC}"
        for _s in "${_UPDATE_SIBLINGS[@]}"; do
            print_info "  Found: $(basename "$_s")"
        done
        echo ""
        if [ "$_UPDATE_ALL" = "true" ]; then
            # Dashboard passed --all flag — no prompt needed
            print_info "Updating all instances (requested from dashboard)"
        elif [ -t 0 ]; then
            # Interactive terminal available — ask the user
            printf "  Update all %d instance(s) together? [Y/n] " "$((${#_UPDATE_SIBLINGS[@]} + 1))"
            read -r _UPDATE_ALL_INPUT </dev/tty
            case "$_UPDATE_ALL_INPUT" in
                [Nn]*) _UPDATE_SIBLINGS=() ; print_info "Updating this instance only" ;;
                *)     print_info "Will update all instances after this one" ;;
            esac
        else
            # No TTY (running from dashboard) — always update all siblings automatically
            print_info "Non-interactive run — updating all instances"
        fi
        echo ""
    fi
fi

write_status "started" "Pulling latest code from GitHub..."

# -- Step 1: Pull latest code from GitHub --
print_step "Step 1: Pulling latest code from GitHub..."
print_info "Fetching any new commits from the main branch..."
if command -v git &>/dev/null && [ -d "$SCRIPT_DIR/.git" ]; then
    # Ensure remote points to the correct repo
    _CORRECT_REMOTE="https://github.com/Tomomoto10/StardropHost-dev.git"
    _CURRENT_REMOTE=$(git -C "$SCRIPT_DIR" remote get-url origin 2>/dev/null || true)
    if [ "$_CURRENT_REMOTE" != "$_CORRECT_REMOTE" ]; then
        print_info "Fixing remote URL: $_CURRENT_REMOTE → $_CORRECT_REMOTE"
        git -C "$SCRIPT_DIR" remote set-url origin "$_CORRECT_REMOTE"
    fi
    BEFORE=$(git -C "$SCRIPT_DIR" rev-parse --short HEAD 2>/dev/null)
    if GIT_TERMINAL_PROMPT=0 git -C "$SCRIPT_DIR" pull; then
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
        print_info "Check your network connection or run: sudo git -C $SCRIPT_DIR pull"
    fi
else
    print_info "Not a git repository or git not installed — skipping pull"
    print_info "Files on disk will be used as-is"
fi

# -- Step 1.5: SMAPI version check --
print_step "Step 1.5: Checking SMAPI version..."

SMAPI_LOG_PATH="$SCRIPT_DIR/data/saves/ErrorLogs/SMAPI-latest.txt"
_SMAPI_NEEDS_UPDATE=false

# Read current installed version from the last SMAPI session log
_CURRENT_SMAPI=""
if [ -f "$SMAPI_LOG_PATH" ]; then
    _CURRENT_SMAPI=$(grep -oE 'SMAPI [0-9]+\.[0-9]+\.[0-9]+' "$SMAPI_LOG_PATH" 2>/dev/null \
        | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
fi

# Fetch latest release tag from GitHub
_LATEST_SMAPI=$(curl -s --max-time 10 \
    https://api.github.com/repos/Pathoschild/SMAPI/releases/latest 2>/dev/null \
    | grep -o '"tag_name": "[^"]*"' | head -1 | cut -d'"' -f4)

if [ -z "$_LATEST_SMAPI" ]; then
    print_warning "Could not check latest SMAPI version (network unavailable?)"
elif [ -z "$_CURRENT_SMAPI" ]; then
    print_info "SMAPI not yet installed — will install v$_LATEST_SMAPI on first start"
elif [ "$_CURRENT_SMAPI" = "$_LATEST_SMAPI" ]; then
    print_success "SMAPI is up to date (v$_CURRENT_SMAPI)"
else
    print_info "SMAPI update: v$_CURRENT_SMAPI → v$_LATEST_SMAPI"
    _SMAPI_NEEDS_UPDATE=true
    print_success "SMAPI will be updated when the server restarts"
fi

# -- Step 2: Rebuild image (incremental) --
write_status "build" "Building Docker image — dashboard stays online..."
# Build FIRST while the panel is still running — this is the slow step.
# The panel stays accessible during the entire build phase.
print_step "Step 2: Rebuilding Docker image..."
print_info "Docker will reuse cached layers for anything that hasn't changed."
print_info "Only modified files (scripts, web panel, config) are rebuilt."
print_info "The dashboard stays online during this step."
echo ""

if ! $COMPOSE_CMD build stardrop-server stardrop-manager stardrop-steam-auth; then
    echo ""
    print_error "Build failed — dashboard is still running, no downtime occurred."
    echo ""
    echo "  Common causes:"
    echo "    - No internet connection during build (Steam CDN timeout)"
    echo "    - Not enough disk space (need ~500 MB free for rebuild)"
    echo "    - A syntax error in a recently changed file"
    echo ""
    echo "  Fix the error and re-run:  sudo bash update.sh"
    exit 1
fi

print_success "Image rebuilt successfully"

check_cancel   # Last chance to cancel before containers go down

# -- Step 3: Stop containers --
write_status "stopping" "Stopping containers — dashboard going offline..."
print_step "Step 3: Stopping containers..."

# Remember whether the server was explicitly stopped via the web panel.
_STOP_FLAG="$SCRIPT_DIR/data/panel/server-stopped"
_WAS_EXPLICITLY_STOPPED=false
[ -f "$_STOP_FLAG" ] && _WAS_EXPLICITLY_STOPPED=true

if [ "$_WAS_EXPLICITLY_STOPPED" = "true" ]; then
    print_info "Game server was stopped — will remain stopped after update"
else
    print_info "Game server was running — will start after update"
fi

print_info "Gracefully shutting down the server and web panel..."
$COMPOSE_CMD down
# Force-remove any containers that survived (restart:unless-stopped race condition)
$COMPOSE_CMD rm -sf >/dev/null 2>&1 || true
print_success "Containers stopped"

# Schedule SMAPI update — remove old binary and write a marker file so the
# entrypoint downloads the correct version at startup instead of re-using the
# version that was baked into the Docker image at build time.
if [ "$_SMAPI_NEEDS_UPDATE" = "true" ]; then
    rm -f "$SCRIPT_DIR/data/game/StardewModdingAPI"
    mkdir -p "$SCRIPT_DIR/data/panel"
    echo "${_LATEST_SMAPI}" > "$SCRIPT_DIR/data/panel/smapi-update-needed"
    if [ -n "$_LATEST_SMAPI" ]; then
        print_success "SMAPI update queued — v$_LATEST_SMAPI will be downloaded on next start"
    else
        print_success "SMAPI update queued — latest version will be downloaded on next start"
    fi
fi

# -- Step 4: Start containers --
write_status "starting" "Starting updated containers..."
print_step "Step 4: Starting containers..."
print_info "Bringing the server and web panel back online..."

if ! $COMPOSE_CMD up -d; then
    print_error "Failed to start containers!"
    echo ""
    echo "  Check what went wrong:"
    echo -e "    ${CYAN}$COMPOSE_CMD logs${NC}"
    exit 1
fi

rm -f "$_UPDATE_STATUS_FILE"   # Clear status — update complete, panel is back up

# Record installed commit SHA so panel-update.js can compare SHAs (not timestamps)
if command -v git &>/dev/null && [ -d "$SCRIPT_DIR/.git" ]; then
    _INSTALLED_SHA=$(git -C "$SCRIPT_DIR" rev-parse HEAD 2>/dev/null || true)
    if [ -n "$_INSTALLED_SHA" ]; then
        mkdir -p "$SCRIPT_DIR/data/panel"
        echo "$_INSTALLED_SHA" > "$SCRIPT_DIR/data/panel/installed-commit.txt"
    fi
fi

# Restore server state — if it wasn't explicitly stopped, clear any stale stop flag
if [ "$_WAS_EXPLICITLY_STOPPED" = "false" ]; then
    rm -f "$_STOP_FLAG"
fi

print_success "Containers started"

# -- Resolve IP and panel port for the done message --
LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
if [ -z "$LOCAL_IP" ] && command -v ip &>/dev/null; then
    LOCAL_IP=$(ip route get 1.1.1.1 2>/dev/null | awk '/src/{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1);exit}}')
fi
SERVER_IP="${LOCAL_IP:-your-server-ip}"
PANEL_PORT="${PANEL_PORT:-18642}"

# -- Done --
echo ""
echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}${BOLD}  Update complete!${NC}"
echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
if [ "$_SHOW_LOGS" = "true" ]; then
echo -e "  Showing startup logs for 15 seconds..."
echo ""
sleep 2
timeout 15 docker logs -f "${CONTAINER_PREFIX}" 2>/dev/null || true
fi

echo ""
echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}${BOLD}  Server is running in the background.${NC}"
echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  Web panel:     ${CYAN}${BOLD}http://${SERVER_IP}:${PANEL_PORT}${NC}"
echo -e "  Watch logs:    ${CYAN}docker logs -f ${CONTAINER_PREFIX}${NC}"
echo ""

# -- Update sibling instances --
if [ ${#_UPDATE_SIBLINGS[@]} -gt 0 ]; then
    _SIBLING_IDX=0
    for _sib in "${_UPDATE_SIBLINGS[@]}"; do
        _SIBLING_IDX=$((_SIBLING_IDX + 1))
        echo ""
        echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo -e "${CYAN}${BOLD}  Updating sibling: $(basename "$_sib") (${_SIBLING_IDX}/${#_UPDATE_SIBLINGS[@]})${NC}"
        echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo ""
        bash "$_sib/update.sh" --sibling
    done
    echo ""
    echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${GREEN}${BOLD}  All instances updated.${NC}"
    echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
fi
