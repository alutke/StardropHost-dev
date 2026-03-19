#!/bin/bash
# ===========================================
# StardropHost | scripts/entrypoint.sh
# ===========================================
# Main container startup script.
# Runs as root first, then switches to steam
# user for all game operations.
# ===========================================

# DO NOT use set -e - we need manual error handling

# -- Colors --
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# -- Panel env file --
PANEL_ENV_FILE=${ENV_FILE:-/home/steam/web-panel/data/runtime.env}
if [ ! -f "$PANEL_ENV_FILE" ] && [ -f "/home/steam/.env" ]; then
    PANEL_ENV_FILE="/home/steam/.env"
fi

load_panel_env_overrides() {
    local env_file=${1:-$PANEL_ENV_FILE}
    [ -f "$env_file" ] || return 0
    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in ''|\#*) continue ;; esac
        local key=${line%%=*}
        local value=${line#*=}
        case "$key" in ''|*[!A-Za-z0-9_]*) continue ;; esac
        export "$key=$value"
    done < "$env_file"
}

load_panel_env_overrides

# -- Resolution defaults --
DEFAULT_RESOLUTION_WIDTH=1280
DEFAULT_RESOLUTION_HEIGHT=720
DEFAULT_REFRESH_RATE=60
LOW_PERF_DEFAULT_WIDTH=800
LOW_PERF_DEFAULT_HEIGHT=600
LOW_PERF_DEFAULT_FPS=30
LOW_PERF_DEFAULT_COLOR_DEPTH=16

LOW_PERF_MODE=${LOW_PERF_MODE:-false}
TARGET_FPS_RAW=${TARGET_FPS:-}
RESOLUTION_WIDTH=${RESOLUTION_WIDTH:-$DEFAULT_RESOLUTION_WIDTH}
RESOLUTION_HEIGHT=${RESOLUTION_HEIGHT:-$DEFAULT_RESOLUTION_HEIGHT}
REFRESH_RATE=${REFRESH_RATE:-${TARGET_FPS_RAW:-$DEFAULT_REFRESH_RATE}}
TARGET_FPS=${TARGET_FPS_RAW:-$REFRESH_RATE}
XVFB_COLOR_DEPTH=24
XVFB_FB_DIR=""
XVFB_FB_ARGS=()

# -- Logging --
log_info()  { echo -e "${GREEN}[StardropHost]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[StardropHost]${NC} $1"; }
log_error() { echo -e "${RED}[StardropHost]${NC} $1"; }
log_step()  { echo -e "${BLUE}${1}${NC}"; }

# -- Audio driver config --
configure_audio_driver() {
    if [ -z "${SDL_AUDIODRIVER:-}" ]; then
        export SDL_AUDIODRIVER=dummy
        log_info "No audio driver configured, defaulting SDL_AUDIODRIVER=dummy"
    fi
    if [ -z "${ALSOFT_DRIVERS:-}" ]; then
        export ALSOFT_DRIVERS=null
        log_info "No OpenAL driver configured, defaulting ALSOFT_DRIVERS=null"
    fi
}

# -- Performance mode --
configure_performance_mode() {
    [ "$LOW_PERF_MODE" = "true" ] || return 0

    RESOLUTION_WIDTH=${LOW_PERF_RESOLUTION_WIDTH:-$LOW_PERF_DEFAULT_WIDTH}
    RESOLUTION_HEIGHT=${LOW_PERF_RESOLUTION_HEIGHT:-$LOW_PERF_DEFAULT_HEIGHT}

    if [ -z "$TARGET_FPS_RAW" ]; then
        TARGET_FPS=$LOW_PERF_DEFAULT_FPS
    fi
    REFRESH_RATE=${LOW_PERF_REFRESH_RATE:-$TARGET_FPS}
    XVFB_COLOR_DEPTH=${LOW_PERF_COLOR_DEPTH:-$LOW_PERF_DEFAULT_COLOR_DEPTH}

    export SDL_VIDEODRIVER=${SDL_VIDEODRIVER:-x11}
    export SDL_AUDIODRIVER=${SDL_AUDIODRIVER:-dummy}
    export MONO_GC_PARAMS=${MONO_GC_PARAMS:-nursery-size=8m}
    export DOTNET_GCHeapHardLimit=${DOTNET_GCHeapHardLimit:-0x30000000}

    if [ "${USE_GPU:-false}" != "true" ]; then
        export LIBGL_ALWAYS_SOFTWARE=${LIBGL_ALWAYS_SOFTWARE:-1}
    fi

    XVFB_FB_DIR=${XVFB_FB_DIR:-/dev/shm/xvfb}
    if mkdir -p "$XVFB_FB_DIR" 2>/dev/null; then
        XVFB_FB_ARGS=(-fbdir "$XVFB_FB_DIR")
    else
        XVFB_FB_DIR=""
        XVFB_FB_ARGS=()
    fi

    log_info "Low performance mode enabled"
    log_info "  Render: ${RESOLUTION_WIDTH}x${RESOLUTION_HEIGHT} @ ${REFRESH_RATE}fps"
    log_info "  Color depth: ${XVFB_COLOR_DEPTH}bit"
}

# -- Startup preferences tuning --
apply_startup_preferences_tuning() {
    local config_file=$1
    [ -f "$config_file" ] || return 0
    [ "$LOW_PERF_MODE" = "true" ] || return 0

    perl -0pi -e "
        s#<fullscreenResolutionX>.*?</fullscreenResolutionX>#<fullscreenResolutionX>${RESOLUTION_WIDTH}</fullscreenResolutionX>#s;
        s#<fullscreenResolutionY>.*?</fullscreenResolutionY>#<fullscreenResolutionY>${RESOLUTION_HEIGHT}</fullscreenResolutionY>#s;
        s#<preferredResolutionX>.*?</preferredResolutionX>#<preferredResolutionX>${RESOLUTION_WIDTH}</preferredResolutionX>#s;
        s#<preferredResolutionY>.*?</preferredResolutionY>#<preferredResolutionY>${RESOLUTION_HEIGHT}</preferredResolutionY>#s;
        s#<vsyncEnabled>.*?</vsyncEnabled>#<vsyncEnabled>true</vsyncEnabled>#s;
        s#<startMuted>.*?</startMuted>#<startMuted>true</startMuted>#s;
        s#<musicVolumeLevel>.*?</musicVolumeLevel>#<musicVolumeLevel>0</musicVolumeLevel>#s;
        s#<soundVolumeLevel>.*?</soundVolumeLevel>#<soundVolumeLevel>0</soundVolumeLevel>#s;
    " "$config_file"
}

# -- Game file setup --
# Handles three cases:
#   1. Local files already in /home/steam/stardewvalley (volume mount)
#   2. GAME_PATH set - copy from specified path
#   3. STEAM_DOWNLOAD=true - download via Steam (credentials via web UI)
setup_game_files() {
    # Case 1: Game already present
    if [ -f "/home/steam/stardewvalley/StardewValley" ]; then
        log_info "✅ Game files found, skipping setup"
        return 0
    fi

    # Case 2: Copy from GAME_PATH
    if [ -n "$GAME_PATH" ] && [ -d "$GAME_PATH" ]; then
        log_info "Copying game files from: $GAME_PATH"
        cp -r "$GAME_PATH/." /home/steam/stardewvalley/
        if [ -f "/home/steam/stardewvalley/StardewValley" ]; then
            log_info "✅ Game files copied successfully"
            return 0
        else
            log_error "❌ Game files copy failed - StardewValley binary not found"
            return 1
        fi
    fi

    # Case 3: Download via Steam
    if [ "$STEAM_DOWNLOAD" = "true" ]; then
        log_info "Steam download requested"
        download_game_via_steam
        return $?
    fi

    # No game files found and no setup method configured
    log_error "❌ No game files found!"
    log_error ""
    log_error "Complete setup via the web panel:"
    log_error "  http://your-server-ip:18642"
    log_error ""
    log_error "The setup wizard will guide you through:"
    log_error "  - Providing local game files"
    log_error "  - Or downloading via Steam"
    log_error ""
    log_warn "Server will wait for game files to be provided..."

    # Wait for game files to appear (web UI will handle this)
    while [ ! -f "/home/steam/stardewvalley/StardewValley" ]; do
        sleep 10
    done
    log_info "✅ Game files detected, continuing startup..."
    return 0
}

# -- Steam download --
download_game_via_steam() {
    log_info "Starting Steam download..."
    log_info "Steam credentials are handled via the web UI"
    log_info "This may take 5-10 minutes depending on your connection"

    STEAM_GUARD_ARGS=""
    if [ -n "$STEAM_GUARD_CODE" ]; then
        log_info "Using Steam Guard code from session"
        STEAM_GUARD_ARGS="+set_steam_guard_code $STEAM_GUARD_CODE"
    fi

    /home/steam/steamcmd/steamcmd.sh \
        +force_install_dir /home/steam/stardewvalley \
        $STEAM_GUARD_ARGS \
        +login "$STEAM_USERNAME" "$STEAM_PASSWORD" \
        +app_update 413150 validate \
        +quit

    local result=$?

    # Always clear credentials from env file after attempt — never persist them
    ENV_FILE="${ENV_FILE:-/home/steam/web-panel/data/runtime.env}"
    if [ -f "$ENV_FILE" ]; then
        sed -i '/^STEAM_USERNAME=/d' "$ENV_FILE" 2>/dev/null || true
        sed -i '/^STEAM_PASSWORD=/d' "$ENV_FILE" 2>/dev/null || true
        sed -i '/^STEAM_GUARD_CODE=/d' "$ENV_FILE" 2>/dev/null || true
        log_info "Steam credentials cleared from env file"
    fi

    if [ -f "/home/steam/stardewvalley/StardewValley" ]; then
        log_info "✅ Game downloaded successfully"
        # Also clear STEAM_DOWNLOAD flag so it doesn't re-download on next start
        if [ -f "$ENV_FILE" ]; then
            sed -i '/^STEAM_DOWNLOAD=/d' "$ENV_FILE" 2>/dev/null || true
        fi
        return 0
    else
        log_error "❌ Game download failed"
        log_error "Check your Steam credentials and try again via the web UI"
        return 1
    fi
}

# -- GPU Xorg startup --
start_gpu_xorg() {
    local context=${1:-"unknown"}
    [ "$USE_GPU" = "true" ] || return 3

    log_info "USE_GPU=true - Attempting Xorg startup (context: $context)"
    rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 2>/dev/null || true

    if [ -e /dev/dri/renderD128 ] || ls /dev/dri 2>/dev/null | grep -q .; then
        log_info "Detected /dev/dri, starting Xorg :99"

        mkdir -p /tmp/.X11-unix
        chmod 1777 /tmp/.X11-unix
        mkdir -p /home/steam/.local/share/xorg

        if [ "$(id -u)" = "0" ]; then
            chown root:root /home/steam/.local/share/xorg 2>/dev/null || true
        fi

        Xorg -noreset +extension GLX +extension RANDR :99 \
            -logfile /home/steam/.local/share/xorg/Xorg.0.log &
        sleep 2

        DISPLAY=:99 /home/steam/scripts/set-resolution.sh \
            "${RESOLUTION_WIDTH}" "${RESOLUTION_HEIGHT}" "${REFRESH_RATE}" || \
            log_warn "Failed to set resolution, using defaults"
        sleep 1

        if pgrep -x Xorg >/dev/null 2>&1; then
            export DISPLAY=${DISPLAY:-:99}
            log_info "✅ Xorg started on :99"
            return 0
        else
            log_warn "Xorg failed to start, will fallback to Xvfb"
            return 2
        fi
    else
        log_warn "/dev/dri not detected, skipping Xorg"
        return 1
    fi
}

# ===========================================
# Phase 1 - Root Initialization
# ===========================================

configure_audio_driver
configure_performance_mode

if [ "$(id -u)" = "0" ]; then
    log_step "================================================"
    log_step "  Phase 1: Root Initialization"
    log_step "================================================"

    # Try GPU Xorg if enabled (requires root for /dev/dri access)
    if [ "$USE_GPU" = "true" ]; then
        start_gpu_xorg "root" || log_warn "GPU startup failed, will fallback to Xvfb"
    fi

    # Create runtime directories
    mkdir -p /home/steam/.local/share/stardrop \
             /home/steam/.local/share/stardrop/logs \
             /home/steam/.local/share/stardrop/backups \
             /home/steam/web-panel/data
    chown -R 1000:1000 \
        /home/steam/.local/share/stardrop \
        /home/steam/web-panel/data 2>/dev/null || true

    log_info "Switching to steam user..."
    exec runuser -u steam -- env DISPLAY="$DISPLAY" "$0" "$@"
fi

# ===========================================
# Phase 2 - Steam User Operations
# ===========================================

log_step "================================================"
log_step "  StardropHost v1.0.0 Starting..."
log_step "================================================"

# Verify steam user
if [ "$(id -u)" != "1000" ]; then
    log_error "Script must run as steam user (UID 1000)"
    exit 1
fi

# -- Step 0: Start web panel early --
# Must start before game file setup so the setup wizard is reachable
# even when no game files are present (the while-loop in setup_game_files
# would otherwise block the panel from ever starting).
log_step "Step 0: Starting web panel..."
cd /home/steam/web-panel
node server.js &
WEB_PANEL_PID=$!
log_info "✅ Web panel started (PID: $WEB_PANEL_PID, port: ${PANEL_PORT:-18642})"
cd /home/steam

# -- Step 1: Validate configuration --
log_step "Step 1: Validating configuration..."

# Load any runtime env overrides from web panel
load_panel_env_overrides

log_info "Configuration loaded"

# -- Step 2: Setup game files --
log_step "Step 2: Setting up game files..."
if ! setup_game_files; then
    log_error "Game setup failed. Container will exit."
    exit 1
fi

# -- Step 3: Install SMAPI --
log_step "Step 3: Installing SMAPI mod loader..."

if [ ! -f "/home/steam/stardewvalley/StardewModdingAPI" ]; then
    log_info "Installing SMAPI..."
    cd /home/steam
    echo "1" | dotnet smapi/SMAPI*/internal/linux/SMAPI.Installer.dll \
        --install \
        --game-path /home/steam/stardewvalley

    if [ $? -ne 0 ]; then
        log_error "Failed to install SMAPI!"
        exit 1
    fi
    log_info "✅ SMAPI installed successfully"
else
    log_info "✅ SMAPI already installed"
fi

# -- Step 3.5: Build ServerDashboard mod --
# Runs here because game files + SMAPI are now in place, providing the
# DLLs (StardewValley.dll, StardewModdingAPI.dll) that ModBuildConfig
# needs. NuGet packages were pre-restored into the image during docker build
# so this works without internet access.
log_step "Step 3.5: Building ServerDashboard mod..."

SD_SRC="/home/steam/mod-source/ServerDashboard"
SD_DEST="/home/steam/preinstalled-mods/ServerDashboard"

if [ -f "$SD_DEST/ServerDashboard.dll" ]; then
    log_info "✅ ServerDashboard already built"
elif [ -d "$SD_SRC" ]; then
    log_info "Building ServerDashboard against game files..."
    dotnet build "$SD_SRC" -c Release \
        /p:GamePath=/home/steam/stardewvalley \
        /p:EnableModDeploy=false \
        /p:EnableModZip=false \
        2>&1

    SD_OUT="$SD_SRC/bin/Release/net6.0"
    if [ -f "$SD_OUT/ServerDashboard.dll" ]; then
        mkdir -p "$SD_DEST"
        cp "$SD_OUT/ServerDashboard.dll" "$SD_DEST/"
        cp "$SD_SRC/manifest.json"       "$SD_DEST/"
        chown -R steam:steam "$SD_DEST" 2>/dev/null || true
        log_info "✅ ServerDashboard built and staged"
    else
        log_warn "⚠️  ServerDashboard build failed — live dashboard data won't update"
        log_warn "    The server will still run normally"
    fi
else
    log_warn "⚠️  ServerDashboard source not found at $SD_SRC — skipping"
fi

# -- Step 3.6: Build FarmAutoCreate mod --
# Headless new-farm creation: reads new-farm.json and uses Stardew's own
# C# API to create the farm programmatically (no xdotool, no VNC needed).
log_step "Step 3.6: Building FarmAutoCreate mod..."

FAC_SRC="/home/steam/mod-source/FarmAutoCreate"
FAC_DEST="/home/steam/preinstalled-mods/FarmAutoCreate"

if [ -f "$FAC_DEST/FarmAutoCreate.dll" ]; then
    log_info "✅ FarmAutoCreate already built"
elif [ -d "$FAC_SRC" ]; then
    log_info "Building FarmAutoCreate against game files..."
    dotnet build "$FAC_SRC" -c Release \
        /p:GamePath=/home/steam/stardewvalley \
        /p:EnableModDeploy=false \
        /p:EnableModZip=false \
        2>&1

    FAC_OUT="$FAC_SRC/bin/Release/net6.0"
    if [ -f "$FAC_OUT/FarmAutoCreate.dll" ]; then
        mkdir -p "$FAC_DEST"
        cp "$FAC_OUT/FarmAutoCreate.dll" "$FAC_DEST/"
        cp "$FAC_SRC/manifest.json"      "$FAC_DEST/"
        chown -R steam:steam "$FAC_DEST" 2>/dev/null || true
        log_info "✅ FarmAutoCreate built and staged"
    else
        log_warn "⚠️  FarmAutoCreate build failed — new farm wizard step won't auto-create"
        log_warn "    You can still set up the farm manually once the game starts"
    fi
else
    log_warn "⚠️  FarmAutoCreate source not found at $FAC_SRC — skipping"
fi

# -- Step 4: Install mods --
log_step "Step 4: Installing mods..."

mkdir -p /home/steam/stardewvalley/Mods

if [ -d "/home/steam/preinstalled-mods" ]; then
    if [ -d "/home/steam/stardewvalley/Mods/AutoHideHost" ]; then
        log_info "✅ Mods already installed"
    else
        log_info "Installing mods..."
        cp -r /home/steam/preinstalled-mods/* /home/steam/stardewvalley/Mods/
        log_info "✅ Mods installed"
    fi

    log_info "Installed mods:"
    ls -1 /home/steam/stardewvalley/Mods/ | while read mod; do
        log_info "  ✅ $mod"
    done
fi

# -- Step 4.5: Install custom mods --
CUSTOM_MODS_DIR="/home/steam/custom-mods"
if [ -d "$CUSTOM_MODS_DIR" ] && [ "$(ls -A "$CUSTOM_MODS_DIR" 2>/dev/null)" ]; then
    log_step "Step 4.5: Installing custom mods..."

    for mod_entry in "$CUSTOM_MODS_DIR"/*; do
        mod_name=$(basename "$mod_entry")
        [[ "$mod_name" == .* ]] && continue

        if [ -d "$mod_entry" ]; then
            log_info "  Installing: $mod_name"
            cp -r "$mod_entry" "/home/steam/stardewvalley/Mods/$mod_name"
        elif [[ "$mod_entry" == *.zip ]]; then
            log_info "  Extracting: $mod_name"
            unzip -q -o "$mod_entry" -d "/home/steam/stardewvalley/Mods/" 2>/dev/null || \
                log_warn "  Failed to extract: $mod_name"
        fi
    done
    log_info "✅ Custom mods installed"
fi

# -- Step 5: Virtual display --
log_step "Step 5: Starting virtual display..."

START_XVFB_FALLBACK=false

if pgrep -x Xorg >/dev/null 2>&1; then
    export DISPLAY=${DISPLAY:-:99}
    log_info "Xorg already running, using DISPLAY=${DISPLAY}"
else
    if [ "$USE_GPU" = "true" ]; then
        log_warn "Xorg not running, falling back to Xvfb"
    fi
    START_XVFB_FALLBACK=true
fi

if [ "$START_XVFB_FALLBACK" = "true" ]; then
    log_info "Starting Xvfb (software rendering)..."
    rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 2>/dev/null || true
    Xvfb :99 \
        -screen 0 "${RESOLUTION_WIDTH}x${RESOLUTION_HEIGHT}x${XVFB_COLOR_DEPTH}" \
        -ac +extension GLX +render -noreset \
        "${XVFB_FB_ARGS[@]}" &
    export DISPLAY=${DISPLAY:-:99}
    sleep 3
    log_info "✅ Virtual display started on ${DISPLAY} (${RESOLUTION_WIDTH}x${RESOLUTION_HEIGHT}x${XVFB_COLOR_DEPTH})"
fi

# -- Step 6: VNC server (optional) --
if [ "$ENABLE_VNC" = "true" ]; then
    log_step "Step 6: Starting VNC server..."

    VNC_PASSWORD=${VNC_PASSWORD:-"stardew1"}
    if [ ${#VNC_PASSWORD} -gt 8 ]; then
        log_warn "VNC password > 8 chars, truncating"
        VNC_PASSWORD="${VNC_PASSWORD:0:8}"
    fi

    sleep 2
    log_info "Starting x11vnc on display ${DISPLAY} (port 5900)..."
    x11vnc -display "${DISPLAY}" -forever -shared \
        -passwd "$VNC_PASSWORD" -rfbport 5900 \
        -noxdamage -bg 2>&1 | grep -v "^$"
    sleep 2

    if pgrep -x "x11vnc" >/dev/null; then
        log_info "✅ VNC server started on port 5900"
        log_info "  Toggle via web UI to enable/disable"

        if [ -f "/home/steam/scripts/vnc-monitor.sh" ]; then
            log_info "Starting VNC health monitor..."
            /home/steam/scripts/vnc-monitor.sh &
            log_info "✅ VNC monitor started"
        fi
    else
        log_error "VNC server failed to start"
    fi
else
    log_step "Step 6: VNC disabled (toggle via web UI)"
fi

# -- Step 7: Game display config --
log_step "Step 7: Configuring game display settings..."

CONFIG_DIR="/home/steam/.config/StardewValley"
CONFIG_FILE="$CONFIG_DIR/startup_preferences"
TEMPLATE="/home/steam/startup_preferences.template"

mkdir -p "$CONFIG_DIR"

if [ ! -f "$CONFIG_FILE" ]; then
    if [ -f "$TEMPLATE" ]; then
        cp "$TEMPLATE" "$CONFIG_FILE"
        log_info "✅ Applied display config"
    else
        log_warn "Template not found, using game defaults"
    fi
else
    log_info "✅ Game config exists, keeping user settings"
fi

apply_startup_preferences_tuning "$CONFIG_FILE"

# -- Step 7.5: Save selection --
if [ -n "$SAVE_NAME" ]; then
    log_step "Step 7.5: Selecting save file..."
    /home/steam/scripts/save-selector.sh
fi

# -- Step 8: Log monitoring --
if [ "$ENABLE_LOG_MONITOR" = "true" ]; then
    log_step "Step 8: Starting log monitoring..."
    if [ -f "/home/steam/scripts/log-monitor.sh" ]; then
        /home/steam/scripts/log-monitor.sh &
        log_info "✅ Log monitoring started"
    fi
else
    log_step "Step 8: Log monitoring disabled"
fi

# -- Step 9: Start game server --
log_step "Step 9: Starting game server..."
log_info "================================================"
log_info "  StardropHost is starting!"
log_info "================================================"
log_info ""
log_info "  Web panel:  http://localhost:18642"
log_info "  Game port:  24642/UDP"
log_info ""
log_info "  Players connect via:"
log_info "    Open Stardew Valley → CO-OP → Join LAN Game"
log_info "    Or enter server IP directly"
log_info ""
log_info "================================================"
log_info ""

cd /home/steam/stardewvalley

# Start event handler
log_info "Starting event handler..."
/home/steam/scripts/event-handler.sh &

# New farm config — FarmAutoCreate SMAPI mod handles creation automatically.
# The mod reads new-farm.json once the title screen appears and creates
# the farm using Stardew's own C# API (no xdotool required).
NEW_FARM_CONFIG="/home/steam/web-panel/data/new-farm.json"
SAVES_DIR="/home/steam/.config/StardewValley/Saves"
if [ -f "$NEW_FARM_CONFIG" ]; then
    if [ ! "$(ls -A "$SAVES_DIR" 2>/dev/null)" ]; then
        log_info "New farm config detected — FarmAutoCreate mod will create it on title screen"
    else
        log_info "Save files already exist — removing new-farm.json"
        rm -f "$NEW_FARM_CONFIG"
    fi
fi

# Start auto-backup if enabled
if [ "$ENABLE_AUTO_BACKUP" = "true" ]; then
    log_info "Starting auto-backup service..."
    /home/steam/scripts/auto-backup.sh &
fi

# Start status reporter
log_info "Starting status reporter (port: ${METRICS_PORT:-9090})..."
/home/steam/scripts/status-reporter.sh &

# Start with or without crash monitor
if [ "$ENABLE_CRASH_RESTART" = "true" ]; then
    log_info "Starting game with crash auto-restart..."
    exec /home/steam/scripts/crash-monitor.sh
else
    exec ./StardewModdingAPI --server
fi