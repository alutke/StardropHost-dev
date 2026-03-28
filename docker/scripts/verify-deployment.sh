#!/bin/bash
# ===========================================
# StardropHost | scripts/verify-deployment.sh
# ===========================================
# Verifies the full StardropHost stack is
# correctly deployed inside the container.
#
# Checks:
#   - Game files present
#   - SMAPI installed
#   - Required mods present (built from source)
#   - Startup preferences configured
#   - Web panel dependencies installed
#   - Data directory structure
#   - Scripts executable
# ===========================================

set -e

# -- Colors --
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
NC='\033[0m'

PASS=0
WARN=0
FAIL=0

pass() { echo -e "  ${GREEN}✅${NC} $1"; PASS=$((PASS+1)); }
warn() { echo -e "  ${YELLOW}⚠️ ${NC} $1"; WARN=$((WARN+1)); }
fail() { echo -e "  ${RED}❌${NC} $1"; FAIL=$((FAIL+1)); }

header() { echo -e "\n${BOLD}$1${NC}"; }

# ===========================================
header "Game Files"
# ===========================================

GAME_DIR="/home/steam/stardewvalley"

if [ -f "$GAME_DIR/Stardew Valley.dll" ]; then
    pass "Stardew Valley.dll present"
elif [ -f "$GAME_DIR/StardewValley.dll" ]; then
    pass "StardewValley.dll present"
else
    fail "Game files not found in $GAME_DIR — mount ./data/game or run wizard"
fi

if [ -f "$GAME_DIR/StardewModdingAPI" ]; then
    pass "SMAPI binary present"
else
    fail "SMAPI not installed — will be installed on next container start"
fi

if [ -d "$GAME_DIR/Mods" ]; then
    pass "Mods directory present"
else
    warn "Mods directory missing (created on first SMAPI run)"
fi

# ===========================================
header "SMAPI Mods"
# ===========================================

MODS_DIR="$GAME_DIR/Mods"

check_mod() {
    local name="$1"
    local dir="$2"
    if [ -d "$MODS_DIR/$dir" ]; then
        pass "$name mod present"
    else
        fail "$name mod missing ($MODS_DIR/$dir)"
    fi
}

check_mod "StardropDashboard"         "StardropDashboard"
check_mod "StardropHost.Dependencies" "StardropHost.Dependencies"

# ===========================================
header "Startup Configuration"
# ===========================================

PREFS_FILE="/home/steam/.config/StardewValley/startup_preferences"
if [ -f "$PREFS_FILE" ]; then
    pass "startup_preferences present"
    if grep -q "playerLimit=8" "$PREFS_FILE" 2>/dev/null; then
        pass "playerLimit=8 set"
    else
        warn "playerLimit not set to 8"
    fi
    if grep -q "musicVolume=0" "$PREFS_FILE" 2>/dev/null; then
        pass "musicVolume=0 (headless)"
    else
        warn "musicVolume not zeroed"
    fi
else
    warn "startup_preferences not found (will be created on first run)"
fi

# ===========================================
header "Web Panel"
# ===========================================

PANEL_DIR="/home/steam/web-panel"

if [ -f "$PANEL_DIR/server.js" ]; then
    pass "Web panel server.js present"
else
    fail "Web panel server.js missing"
fi

if [ -d "$PANEL_DIR/node_modules" ]; then
    pass "node_modules installed"
else
    fail "node_modules missing — run: npm install in $PANEL_DIR"
fi

if [ -f "$PANEL_DIR/public/js/app.js" ]; then
    pass "Frontend app.js present"
else
    fail "Frontend app.js missing"
fi

# ===========================================
header "Data Directory Structure"
# ===========================================

DATA_DIR="/home/steam/.local/share/stardrop"
PANEL_DATA="/home/steam/web-panel/data"

for dir in "$DATA_DIR" "$DATA_DIR/logs" "$DATA_DIR/logs/categorized" "$DATA_DIR/backups"; do
    if [ -d "$dir" ]; then
        pass "$dir present"
    else
        warn "$dir missing (created at runtime)"
    fi
done

if [ -d "$PANEL_DATA" ]; then
    pass "Panel data directory present"
else
    warn "Panel data directory missing — wizard not yet run"
fi

if [ -f "$PANEL_DATA/auth.json" ]; then
    pass "auth.json present (panel password set)"
else
    warn "auth.json missing — wizard not yet completed"
fi

# ===========================================
header "Scripts"
# ===========================================

SCRIPTS_DIR="/home/steam/scripts"
REQUIRED_SCRIPTS=(
    entrypoint.sh
    event-handler.sh
    log-monitor.sh
    log-manager.sh
    status-reporter.sh
    auto-backup.sh
    crash-monitor.sh
    vnc-monitor.sh
    save-selector.sh
    init-container.sh
    health-check.sh
)

for script in "${REQUIRED_SCRIPTS[@]}"; do
    path="$SCRIPTS_DIR/$script"
    if [ ! -f "$path" ]; then
        fail "$script missing"
    elif [ ! -x "$path" ]; then
        warn "$script not executable (run: chmod +x $path)"
    else
        pass "$script present and executable"
    fi
done

# ===========================================
header "Summary"
# ===========================================

echo ""
echo -e "  ${GREEN}Passed:${NC} $PASS"
[ $WARN -gt 0 ] && echo -e "  ${YELLOW}Warnings:${NC} $WARN"
[ $FAIL -gt 0 ] && echo -e "  ${RED}Failed:${NC} $FAIL"
echo ""

if [ $FAIL -gt 0 ]; then
    echo -e "${RED}Deployment verification FAILED — fix issues above before starting server${NC}"
    echo ""
    exit 1
elif [ $WARN -gt 0 ]; then
    echo -e "${YELLOW}Deployment verification passed with warnings${NC}"
    echo ""
    exit 0
else
    echo -e "${GREEN}Deployment verified — all checks passed${NC}"
    echo ""
    exit 0
fi
