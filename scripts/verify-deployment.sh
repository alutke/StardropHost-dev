#!/bin/bash
# ===========================================
# StardropHost | verify-deployment.sh
# ===========================================
# Verifies all components are working after
# deployment.
# Usage: bash scripts/verify-deployment.sh
# ===========================================

# -- Colors --
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# -- Counters --
PASS=0
FAIL=0
WARN=0

# -- Output Helpers --
check_pass() { echo -e "${GREEN}✅ PASS${NC} - $1"; PASS=$((PASS + 1)); }
check_fail() { echo -e "${RED}❌ FAIL${NC} - $1"; FAIL=$((FAIL + 1)); }
check_warn() { echo -e "${YELLOW}⚠️  WARN${NC} - $1"; WARN=$((WARN + 1)); }

echo ""
echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${CYAN}${BOLD}  🌟 StardropHost - Deployment Verification${NC}"
echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# -- Get logs once --
LOG=$(docker logs stardrop 2>&1)

# -- 1. Container status --
echo -e "${BOLD}[1/10] Container Status${NC}"
if docker ps | grep -q stardrop; then
    check_pass "Container is running"
else
    check_fail "Container is not running"
    echo -e "  Start it: ${CYAN}docker compose up -d${NC}"
    exit 1
fi
echo ""

# -- 2. Game files --
echo -e "${BOLD}[2/10] Game Files${NC}"
if echo "$LOG" | grep -q "Game files found\|already downloaded"; then
    check_pass "Game files present"
elif echo "$LOG" | grep -q "Copying game files"; then
    check_warn "Game files are being copied (check logs)"
elif echo "$LOG" | grep -q "downloading"; then
    check_warn "Game is downloading via Steam (check logs)"
else
    check_fail "Game files not found"
    echo -e "  Complete setup at: ${CYAN}http://your-server-ip:18642${NC}"
fi
echo ""

# -- 3. SMAPI --
echo -e "${BOLD}[3/10] SMAPI${NC}"
if echo "$LOG" | grep -q "SMAPI already installed\|SMAPI installed"; then
    check_pass "SMAPI installed"
else
    check_warn "SMAPI installation status unclear"
fi
echo ""

# -- 4. Mods --
echo -e "${BOLD}[4/10] Mods${NC}"
if echo "$LOG" | grep -q "Mods already installed\|Mods installed"; then
    check_pass "Mods installed"
else
    check_warn "Mod installation status unclear"
fi
echo ""

# -- 5. Always On Server --
echo -e "${BOLD}[5/10] Mod: Always On Server${NC}"
if echo "$LOG" | grep -q "AlwaysOnServer\|Always On Server"; then
    check_pass "Always On Server loaded"
else
    check_warn "Always On Server not detected in logs"
fi
echo ""

# -- 6. AutoHideHost --
echo -e "${BOLD}[6/10] Mod: AutoHideHost${NC}"
if echo "$LOG" | grep -q "AutoHideHost"; then
    check_pass "AutoHideHost loaded"
else
    check_warn "AutoHideHost not detected in logs"
fi
echo ""

# -- 7. ServerAutoLoad --
echo -e "${BOLD}[7/10] Mod: ServerAutoLoad${NC}"
if echo "$LOG" | grep -q "ServerAutoLoad"; then
    check_pass "ServerAutoLoad loaded"
else
    check_warn "ServerAutoLoad not detected in logs"
fi
echo ""

# -- 8. StardropDashboard --
echo -e "${BOLD}[8/10] Mod: StardropDashboard${NC}"
if echo "$LOG" | grep -q "StardropDashboard"; then
    check_pass "StardropDashboard loaded"
else
    check_warn "StardropDashboard not detected in logs"
fi
echo ""

# -- 9. Virtual display --
echo -e "${BOLD}[9/10] Virtual Display${NC}"
if echo "$LOG" | grep -q "Virtual display started"; then
    check_pass "Xvfb virtual display running"
else
    check_fail "Virtual display not started"
fi
echo ""

# -- 10. Game server --
echo -e "${BOLD}[10/10] Game Server${NC}"
if echo "$LOG" | grep -q "Server is starting\|StardewModdingAPI"; then
    check_pass "Game server is running"
else
    check_warn "Game server status unclear (may still be initializing)"
fi
echo ""

# -- Error check --
echo -e "${BOLD}[Error Check] Scanning logs for errors...${NC}"
ERROR_LINES=$(echo "$LOG" | grep -i "error" | grep -v "Rate Limit" | tail -3)
if [ -n "$ERROR_LINES" ]; then
    check_warn "Error messages found in logs"
    echo -e "${YELLOW}  Recent errors:${NC}"
    echo "$ERROR_LINES"
else
    check_pass "No errors found in logs"
fi
echo ""

# -- Port check --
echo -e "${BOLD}[Port Check] Checking ports...${NC}"
if netstat -tuln 2>/dev/null | grep -q ":24642"; then
    check_pass "Game port 24642/udp is listening"
else
    check_warn "Port 24642 not detected (netstat may not be available)"
fi

if netstat -tuln 2>/dev/null | grep -q ":18642"; then
    check_pass "Web panel port 18642/tcp is listening"
else
    check_warn "Web panel port 18642 not detected"
fi

if netstat -tuln 2>/dev/null | grep -q ":5900"; then
    check_pass "VNC port 5900/tcp is listening"
else
    check_warn "VNC port not detected (disabled by default)"
fi
echo ""

# -- Summary --
echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}  Summary${NC}"
echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${GREEN}  ✅ Passed:   $PASS${NC}"
[ $WARN -gt 0 ] && echo -e "${YELLOW}  ⚠️  Warnings: $WARN${NC}"
[ $FAIL -gt 0 ] && echo -e "${RED}  ❌ Failed:   $FAIL${NC}"
echo ""

if [ $FAIL -eq 0 ]; then
    echo -e "${GREEN}${BOLD}  🌟 Deployment looks good!${NC}"
    echo ""
    echo "  Next steps:"
    echo -e "    Open web panel: ${CYAN}http://your-server-ip:18642${NC}"
    echo -e "    View logs:      ${CYAN}docker logs -f stardrop${NC}"
    exit 0
else
    echo -e "${RED}${BOLD}  ❌ Deployment has issues${NC}"
    echo ""
    echo -e "  View logs: ${CYAN}docker logs stardrop${NC}"
    exit 1
fi
