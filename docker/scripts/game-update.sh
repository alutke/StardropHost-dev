#!/bin/bash
# ===========================================
# StardropHost | scripts/game-update.sh
# ===========================================
# Downloads/updates Stardew Valley via steamcmd.
# Called by the web panel API — never run directly.
#
# Credentials are read from:
#   /home/steam/web-panel/data/game-update-creds.json
# (written by the API, cleared immediately after use)
#
# Status written to:
#   /home/steam/web-panel/data/game-update-status.json
#
# Log written to:
#   /home/steam/web-panel/data/game-update.log
# ===========================================

CREDS_FILE="/home/steam/web-panel/data/game-update-creds.json"
STATUS_FILE="/home/steam/web-panel/data/game-update-status.json"
LOG_FILE="/home/steam/web-panel/data/game-update.log"
STEAMCMD="/home/steam/steamcmd/steamcmd.sh"
CHECK_FILE="/home/steam/web-panel/data/game-update-available.json"
SAVE_DIR="/home/steam/.config/StardewValley"
BACKUP_DIR="/home/steam/.local/share/stardrop/backups"

write_status() { echo "$1" > "$STATUS_FILE"; }
write_log()    { echo "[$(date '+%H:%M:%S')] $1" | tee -a "$LOG_FILE"; }

# -- Pre-update save backup --
pre_update_backup() {
    mkdir -p "$BACKUP_DIR"
    local saves_dir="$SAVE_DIR/Saves"
    [ -d "$saves_dir" ] || return 0

    local farm_slug
    farm_slug=$(node -e "
const fs = require('fs'), path = require('path');
const SAVES  = '${SAVE_DIR}/Saves';
const PREFS  = '${SAVE_DIR}/startup_preferences';
const MARKER = '${SAVE_DIR}/Saves/.selected_save';
try {
    let saveName = '';
    if (fs.existsSync(PREFS)) {
        const m = fs.readFileSync(PREFS, 'utf8').match(/<saveFolderName>([^<]+)<\/saveFolderName>/);
        if (m) saveName = m[1].trim();
    }
    if (!saveName && fs.existsSync(MARKER)) saveName = fs.readFileSync(MARKER, 'utf8').trim();
    if (!saveName) { process.stdout.write('stardrop'); return; }
    const xml = fs.readFileSync(path.join(SAVES, saveName, 'SaveGameInfo'), 'utf8');
    const n = xml.match(/<farmName>([^<]+)<\/farmName>/);
    const slug = (n ? n[1] : 'stardrop').toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_-]/g, '');
    process.stdout.write(slug || 'stardrop');
} catch { process.stdout.write('stardrop'); }
" 2>/dev/null || echo "stardrop")

    local timestamp
    timestamp=$(date -u '+D%d-%m-%Y-T%H-%M-%S')
    local backup_file="$BACKUP_DIR/${farm_slug}-update-backup-${timestamp}.zip"

    write_log "Creating pre-update save backup..."
    (cd "$(dirname "$saves_dir")" && zip -r "$backup_file" "$(basename "$saves_dir")" -x "*/ErrorLogs/*") 2>/dev/null \
        && write_log "  Backup saved: $(basename "$backup_file")" \
        || write_log "  Backup skipped (no saves found)"
}

# -- Read credentials from JSON --
if [ ! -f "$CREDS_FILE" ]; then
    write_status '{"state":"error","message":"No credentials file found"}'
    exit 1
fi

STEAM_USERNAME=$(python3 -c "import json; d=json.load(open('$CREDS_FILE')); print(d.get('username',''))" 2>/dev/null)
STEAM_PASSWORD=$(python3 -c "import json; d=json.load(open('$CREDS_FILE')); print(d.get('password',''))" 2>/dev/null)
STEAM_GUARD=$(python3 -c "import json; d=json.load(open('$CREDS_FILE')); print(d.get('guardCode',''))" 2>/dev/null)

if [ -z "$STEAM_USERNAME" ] || [ -z "$STEAM_PASSWORD" ]; then
    write_status '{"state":"error","message":"Missing Steam credentials"}'
    rm -f "$CREDS_FILE"
    exit 1
fi

# -- Reset log and set initial status --
> "$LOG_FILE"
write_log "Starting game update..."
write_status '{"state":"downloading","message":"Connecting to Steam..."}'

# -- Back up current saves before overwriting game files --
pre_update_backup

# -- Build steamcmd argument list --
ARGS=(+force_install_dir /home/steam/stardewvalley)
if [ -n "$STEAM_GUARD" ]; then
    write_log "Using Steam Guard code"
    ARGS+=(+set_steam_guard_code "$STEAM_GUARD")
fi
ARGS+=(+login "$STEAM_USERNAME" "$STEAM_PASSWORD" +app_update 413150 validate +quit)

STEAMCMD_TMP=$(mktemp)

# -- Run steamcmd, strip ANSI, write to log --
write_log "Connecting to Steam — this may take a few minutes..."
"$STEAMCMD" "${ARGS[@]}" 2>&1 | tee "$STEAMCMD_TMP" | while IFS= read -r line; do
    clean=$(printf '%s' "$line" | sed 's/\x1b\[[0-9;]*m//g' | tr -d '\r')
    [ -n "$clean" ] && write_log "$clean"
done

# -- Always clear credentials immediately after attempt --
rm -f "$CREDS_FILE"

# -- Interpret result --
if [ -f "/home/steam/stardewvalley/StardewValley" ]; then
    # Double-check: did steamcmd ask for a guard code and then somehow succeed anyway?
    if grep -qi "steam guard\|steamguard\|two.factor\|enter.*steam guard code\|Steam Guard code" \
            "$STEAMCMD_TMP" 2>/dev/null && \
       ! grep -qi "app_update.*fully.*installed\|success\|app already up to date" "$STEAMCMD_TMP" 2>/dev/null; then
        write_status '{"state":"guard_required","message":"Steam Guard code required — check your email or authenticator app"}'
        write_log "Steam Guard code required — enter the code from your email or authenticator"
        rm -f "$STEAMCMD_TMP"
        exit 0
    fi

    write_log "✅ Game updated successfully"
    write_status '{"state":"done","message":"Game updated successfully — restart the server to apply"}'

    # Clear the update notification by recording the Steam API latestBuild as installed.
    # We deliberately use the Steam API build (not the ACF buildid) because on Linux
    # the ACF buildid may never match the cross-platform Steam API number even after
    # a successful update. Recording what Steam reported as "latest" ensures the
    # notification stays cleared until a genuinely newer build appears.
    STEAM_LATEST=$(python3 -c "
import json, sys
try:
    d = json.load(open('$CHECK_FILE'))
    print(d.get('latestBuild') or d.get('currentBuild') or '')
except Exception:
    print('')
" 2>/dev/null || true)
    INSTALLED_BUILD="${STEAM_LATEST}"
    # Fall back to ACF if we have nothing better
    if [ -z "$INSTALLED_BUILD" ]; then
        INSTALLED_BUILD=$(grep '"buildid"' "/home/steam/stardewvalley/steamapps/appmanifest_413150.acf" \
            2>/dev/null | grep -oE '[0-9]+' | head -1 || true)
    fi
    if [ -n "$INSTALLED_BUILD" ]; then
        echo '{"available":false,"installedBuild":"'"$INSTALLED_BUILD"'","latestBuild":"'"$INSTALLED_BUILD"'","checkedAt":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}' > "$CHECK_FILE"
    fi

    rm -f "$STEAMCMD_TMP"
    exit 0
fi

# -- Download failed — diagnose why --
if grep -qi "steam guard\|steamguard\|two.factor\|enter.*steam guard code\|Steam Guard code" \
        "$STEAMCMD_TMP" 2>/dev/null; then
    write_status '{"state":"guard_required","message":"Steam Guard code required — check your email or authenticator app"}'
    write_log "Steam Guard code required — enter the code from your email or authenticator"
elif grep -qi "Invalid Password\|INVALID_PASSWORD\|incorrect password" "$STEAMCMD_TMP" 2>/dev/null; then
    write_status '{"state":"error","message":"Invalid Steam password — check your credentials"}'
    write_log "❌ Invalid Steam password"
elif grep -qi "rate.limit\|too many\|RATE_LIMIT" "$STEAMCMD_TMP" 2>/dev/null; then
    write_status '{"state":"error","message":"Steam rate limit — wait a few minutes and try again"}'
    write_log "❌ Steam rate limit hit — wait a few minutes"
else
    write_status '{"state":"error","message":"Update failed — check the log for details"}'
    write_log "❌ Update failed"
fi

rm -f "$STEAMCMD_TMP"
exit 1
