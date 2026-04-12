#!/bin/bash
# ===========================================
# StardropHost | scripts/uninstall.sh
# ===========================================
# Completely removes StardropHost from this
# machine. Reverses everything quick-start.sh
# did:
#   1. Stops and removes all containers
#   2. Removes StardropHost Docker images
#   3. Removes firewall rules added at install
#   4. Removes install directories + game files
#   5. Optionally removes saves and backups
#   6. Optionally removes Docker entirely
#
# Usage:
#   sudo bash scripts/uninstall.sh
# ===========================================

set +e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'
BOLD='\033[1m'

print_header()  {
    echo ""
    echo -e "${RED}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${RED}${BOLD}  StardropHost — Uninstall${NC}"
    echo -e "${RED}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
}
print_success() { echo -e "${GREEN}[OK]   $1${NC}"; }
print_error()   { echo -e "${RED}[ERR]  $1${NC}"; }
print_warning() { echo -e "${YELLOW}[WARN] $1${NC}"; }
print_info()    { echo -e "${BLUE}[>>]   $1${NC}"; }
print_step()    { echo ""; echo -e "${BOLD}$1${NC}"; }

confirm() {
    local answer
    echo -ne "${YELLOW}${BOLD}$1 [y/N]: ${NC}"
    read -r answer
    case "$answer" in
        y|Y|yes|YES) return 0 ;;
        *) return 1 ;;
    esac
}

# ===========================================
# Detect real user
# ===========================================
if [ -n "$SUDO_USER" ] && [ "$SUDO_USER" != "root" ]; then
    REAL_USER="$SUDO_USER"
    REAL_HOME=$(getent passwd "$SUDO_USER" 2>/dev/null | cut -d: -f6 || echo "/home/$SUDO_USER")
elif [ "$(id -u)" != "0" ]; then
    REAL_USER="$(id -un)"
    REAL_HOME="$HOME"
else
    REAL_USER="root"
    REAL_HOME="/root"
fi

# ===========================================
# Require root
# ===========================================
if [ "$(id -u)" != "0" ]; then
    echo -e "${RED}[ERR]  This script must be run as root.${NC}"
    echo "  Run: sudo bash uninstall.sh"
    exit 1
fi

# ===========================================
# Find all StardropHost instances
# ===========================================
BASE="$REAL_HOME/stardrophost"
ALL_INSTANCES=()

[ -f "$BASE/docker-compose.yml" ] && ALL_INSTANCES+=("$BASE")
for n in $(seq 2 10); do
    [ -f "$BASE-$n/docker-compose.yml" ] && ALL_INSTANCES+=("$BASE-$n")
done

# ===========================================
# Main
# ===========================================
print_header

if [ ${#ALL_INSTANCES[@]} -eq 0 ]; then
    print_warning "No StardropHost installations found in $REAL_HOME"
    echo ""
    echo "  Expected at: $REAL_HOME/stardrophost"
    echo ""
    echo "  If installed elsewhere, remove it manually:"
    echo "    cd <install-dir> && docker compose down --rmi local"
    echo "    rm -rf <install-dir>"
    exit 0
fi

# ===========================================
# Instance selection (if multiple exist)
# ===========================================
INSTANCES=()

if [ ${#ALL_INSTANCES[@]} -eq 1 ]; then
    INSTANCES=("${ALL_INSTANCES[@]}")
else
    echo -e "  Found ${#ALL_INSTANCES[@]} StardropHost installations:"
    echo ""
    for i in "${!ALL_INSTANCES[@]}"; do
        dir="${ALL_INSTANCES[$i]}"
        prefix=$(grep "^CONTAINER_PREFIX=" "$dir/.env" 2>/dev/null | tail -1 | cut -d= -f2)
        [ -z "$prefix" ] && prefix="stardrop"
        echo -e "    $((i+1)). ${CYAN}$prefix${NC}   $dir"
    done
    echo -e "    $((${#ALL_INSTANCES[@]}+1)). Remove all"
    echo ""
    printf "${YELLOW}${BOLD}Which installation to uninstall? [1-$((${#ALL_INSTANCES[@]}+1))]: ${NC}"
    read -r choice

    if echo "$choice" | grep -qE '^[0-9]+$'; then
        if [ "$choice" -eq $((${#ALL_INSTANCES[@]}+1)) ]; then
            INSTANCES=("${ALL_INSTANCES[@]}")
        elif [ "$choice" -ge 1 ] && [ "$choice" -le "${#ALL_INSTANCES[@]}" ]; then
            INSTANCES=("${ALL_INSTANCES[$((choice-1))]}")
        else
            print_error "Invalid choice."
            exit 1
        fi
    else
        print_error "Invalid choice."
        exit 1
    fi
fi

# ===========================================
# Confirm what will be removed
# ===========================================
echo ""
echo -e "${RED}${BOLD}  The following will be permanently removed:${NC}"
echo ""
for dir in "${INSTANCES[@]}"; do
    prefix=$(grep "^CONTAINER_PREFIX=" "$dir/.env" 2>/dev/null | tail -1 | cut -d= -f2)
    [ -z "$prefix" ] && prefix="stardrop"
    echo -e "    ${CYAN}$prefix${NC}   $dir"
done
echo ""
echo -e "  Includes: containers, Docker images, game files, firewall rules"
echo ""

if ! confirm "Proceed with uninstall?"; then
    echo ""
    print_info "Uninstall cancelled."
    exit 0
fi

COMPOSE_CMD=""
if docker compose version &>/dev/null 2>&1; then
    COMPOSE_CMD="docker compose"
elif command -v docker-compose &>/dev/null; then
    COMPOSE_CMD="docker-compose"
fi

# ===========================================
# Step 1 — Stop and remove containers
# ===========================================
print_step "Step 1: Containers"
echo ""
if confirm "Stop and remove StardropHost containers?"; then
    for dir in "${INSTANCES[@]}"; do
        prefix=$(grep "^CONTAINER_PREFIX=" "$dir/.env" 2>/dev/null | tail -1 | cut -d= -f2)
        [ -z "$prefix" ] && prefix="stardrop"
        print_info "Stopping: $prefix"
        if [ -n "$COMPOSE_CMD" ] && [ -f "$dir/docker-compose.yml" ]; then
            (cd "$dir" && $COMPOSE_CMD down --remove-orphans 2>/dev/null) || true
        else
            for suffix in "" "-manager" "-init" "-steam-auth"; do
                name="${prefix}${suffix}"
                if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q "^${name}$"; then
                    docker stop "$name" 2>/dev/null || true
                    docker rm   "$name" 2>/dev/null || true
                fi
            done
        fi
        print_success "Containers removed: $prefix"
    done
else
    print_info "Skipped — containers left running."
fi

# ===========================================
# Step 2 — Remove Docker images
# ===========================================
print_step "Step 2: Docker images"
echo ""
if confirm "Remove StardropHost Docker images?"; then
    for img in "stardrop-server:local" "stardrop-manager:local" "stardrop-steam-auth:local"; do
        if docker image inspect "$img" &>/dev/null 2>&1; then
            docker rmi "$img" 2>/dev/null \
                && print_success "Removed: $img" \
                || print_warning "Could not remove $img (may be in use by another instance)"
        else
            print_info "Not present: $img"
        fi
    done
else
    print_info "Skipped — images kept."
fi

# ===========================================
# Step 3 — Remove firewall rules
# ===========================================
print_step "Step 3: Firewall rules"
echo ""
if command -v ufw &>/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
    if confirm "Remove firewall rules added at install?"; then
        REMOVED_ANY=0
        for n in $(seq 1 10); do
            G=$((24641 + n)); P=$((18641 + n)); V=$((5899 + n)); M=$((9089 + n))
            ufw status 2>/dev/null | grep -q "${G}/udp" && ufw delete allow "${G}/udp"  >/dev/null 2>&1 && REMOVED_ANY=1
            ufw status 2>/dev/null | grep -q "${P}/tcp" && ufw delete allow "${P}/tcp"  >/dev/null 2>&1 && REMOVED_ANY=1
            ufw status 2>/dev/null | grep -q "${V}/tcp" && ufw delete allow "${V}/tcp"  >/dev/null 2>&1 && REMOVED_ANY=1
            ufw status 2>/dev/null | grep -q "${M}/tcp" && ufw delete allow "${M}/tcp"  >/dev/null 2>&1 && REMOVED_ANY=1
        done
        [ "$REMOVED_ANY" = "1" ] \
            && print_success "Firewall rules removed" \
            || print_info "No StardropHost firewall rules found"
    else
        print_info "Skipped — firewall rules kept."
    fi
else
    print_info "ufw not active — skipping"
fi

# ===========================================
# Step 4 — Game files
# ===========================================
print_step "Step 4: Game files"
echo ""
print_info "Stardew Valley game files are in data/game/ — these can be re-downloaded."
echo ""
REMOVE_GAME=0
if confirm "Remove game files (data/game)?"; then
    REMOVE_GAME=1
fi

# ===========================================
# Step 5 — Saves and backups
# ===========================================
print_step "Step 5: Saves and backups"
echo ""
REMOVE_SAVES=0
HAS_SAVES=0
for dir in "${INSTANCES[@]}"; do
    SAVE_COUNT=$(ls "$dir/data/saves" 2>/dev/null | grep -v '^\.' | wc -l | tr -d ' ')
    [ "${SAVE_COUNT:-0}" -gt 0 ] && HAS_SAVES=1
done

if [ "$HAS_SAVES" = "1" ]; then
    echo -e "${YELLOW}  Save files found:${NC}"
    for dir in "${INSTANCES[@]}"; do
        SAVE_COUNT=$(ls "$dir/data/saves" 2>/dev/null | grep -v '^\.' | wc -l | tr -d ' ')
        if [ "${SAVE_COUNT:-0}" -gt 0 ]; then
            echo -e "${YELLOW}    $dir/data/saves  ($SAVE_COUNT save(s))${NC}"
            for s in "$dir/data/saves"/*/; do
                [ -d "$s" ] && echo -e "      - $(basename "$s")"
            done
        fi
    done
    echo ""
    if confirm "Delete saves, backups and custom mods? (CANNOT BE UNDONE)"; then
        REMOVE_SAVES=1
        print_warning "Saves, backups and custom mods will be deleted."
    else
        print_info "Saves, backups and custom mods will be kept."
    fi
else
    print_info "No saves found."
fi

# ===========================================
# Step 5b — Apply file removals
# ===========================================
echo ""
for dir in "${INSTANCES[@]}"; do
    prefix=$(grep "^CONTAINER_PREFIX=" "$dir/.env" 2>/dev/null | tail -1 | cut -d= -f2)
    [ -z "$prefix" ] && prefix="stardrop"
    print_info "Processing: $dir"

    if [ "$REMOVE_SAVES" = "1" ] && [ "$REMOVE_GAME" = "1" ]; then
        rm -rf "$dir"
        print_success "Fully removed: $dir"
    else
        # Remove code and config files
        for item in docker steam-auth docker-compose.yml .env .gitignore \
                     quick-start.sh update.sh scripts CLAUDE.md README.md \
                     MODS_LIST.md .git logs; do
            rm -rf "$dir/$item" 2>/dev/null || true
        done
        # Remove runtime dirs always
        for subdir in logs panel steam-session; do
            rm -rf "$dir/data/$subdir" 2>/dev/null || true
        done
        [ "$REMOVE_GAME"  = "1" ] && rm -rf "$dir/data/game"         2>/dev/null || true
        [ "$REMOVE_SAVES" = "1" ] && rm -rf "$dir/data/saves"        2>/dev/null || true
        [ "$REMOVE_SAVES" = "1" ] && rm -rf "$dir/data/backups"      2>/dev/null || true
        [ "$REMOVE_SAVES" = "1" ] && rm -rf "$dir/data/custom-mods"  2>/dev/null || true

        print_success "Done: $dir"
        [ "$REMOVE_GAME"  = "0" ] && print_info "  Kept: data/game"
        [ "$REMOVE_SAVES" = "0" ] && print_info "  Kept: data/saves  data/backups  data/custom-mods"
    fi
done

# ===========================================
# Step 5 — Docker group membership
# ===========================================
print_step "Step 5: Docker group permissions..."

if [ "$REAL_USER" != "root" ] && id "$REAL_USER" &>/dev/null; then
    if id -nG "$REAL_USER" 2>/dev/null | grep -qw docker; then
        echo ""
        print_info "User '$REAL_USER' is in the 'docker' group (added by quick-start.sh)."
        if confirm "Remove '$REAL_USER' from the docker group?"; then
            gpasswd -d "$REAL_USER" docker 2>/dev/null \
                && print_success "Removed '$REAL_USER' from docker group" \
                || print_warning "Could not remove — do it manually: sudo gpasswd -d $REAL_USER docker"
        else
            print_info "Keeping docker group membership."
        fi
    else
        print_info "No docker group changes to revert for '$REAL_USER'"
    fi
fi

# ===========================================
# Step 6 — Optionally remove Docker
# ===========================================
print_step "Step 6: Docker itself..."

if command -v docker &>/dev/null; then
    # Only offer removal if we removed all instances
    if [ ${#INSTANCES[@]} -lt ${#ALL_INSTANCES[@]} ]; then
        print_info "Other StardropHost instances still installed — skipping Docker removal"
    else
        echo ""
        print_warning "Only choose yes if StardropHost was the ONLY thing using Docker on this machine."
        echo ""
        if confirm "Uninstall Docker completely?"; then
            if [ -f /etc/os-release ]; then . /etc/os-release; fi

            if command -v systemctl &>/dev/null; then
                systemctl stop docker 2>/dev/null || true
                systemctl disable docker 2>/dev/null || true
            fi

            case "${ID:-}" in
                ubuntu|debian|raspbian|linuxmint|pop)
                    apt-get purge -y -qq \
                        docker-ce docker-ce-cli containerd.io \
                        docker-compose-plugin docker-buildx-plugin \
                        docker-ce-rootless-extras 2>/dev/null || true
                    apt-get autoremove -y -qq 2>/dev/null || true
                    rm -f /etc/apt/sources.list.d/docker.list
                    rm -f /etc/apt/keyrings/docker.gpg
                    print_success "Docker removed (apt)"
                    ;;
                centos|rhel|fedora|amzn|rocky|almalinux)
                    if command -v dnf &>/dev/null; then
                        dnf remove -y docker-ce docker-ce-cli containerd.io \
                            docker-compose-plugin docker-buildx-plugin 2>/dev/null || true
                    else
                        yum remove -y docker-ce docker-ce-cli containerd.io \
                            docker-compose-plugin 2>/dev/null || true
                    fi
                    print_success "Docker removed (dnf/yum)"
                    ;;
                *)
                    print_warning "Could not detect package manager — remove Docker manually."
                    print_info "See: https://docs.docker.com/engine/install/linux-postinstall/#uninstall-docker-engine"
                    ;;
            esac

            rm -rf /var/lib/docker 2>/dev/null || true
            rm -rf /var/lib/containerd 2>/dev/null || true
        else
            print_info "Keeping Docker."
        fi
    fi
else
    print_info "Docker not found — nothing to do."
fi

# ===========================================
# Done
# ===========================================
echo ""
echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}${BOLD}  StardropHost has been removed.${NC}"
echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

if [ "$REMOVE_SAVES" = "0" ] && [ "$HAS_SAVES" = "1" ]; then
    echo -e "  Your saves were kept at:"
    for dir in "${INSTANCES[@]}"; do
        echo -e "    ${CYAN}$dir/data/saves${NC}"
    done
    echo ""
    echo -e "  To delete them later:  ${CYAN}rm -rf $REAL_HOME/stardrophost/data${NC}"
    echo ""
fi

echo -e "  To reinstall StardropHost:"
echo -e "    ${CYAN}curl -fsSL https://raw.githubusercontent.com/Tomomoto10/StardropHost-dev/main/quick-start.sh | sudo bash${NC}"
echo ""
