#!/bin/bash
# ===========================================
# StardropHost | scripts/auto-backup.sh
# ===========================================
# Automatic save file backup service.
# Runs daily at the configured hour and keeps
# a configurable number of backups.
# ===========================================

SAVE_DIR="/home/steam/.config/StardewValley"
BACKUP_DIR="/home/steam/.local/share/stardrop/backups"
MAX_BACKUPS=${MAX_BACKUPS:-7}
BACKUP_INTERVAL_HOURS=${BACKUP_INTERVAL_HOURS:-24}
BACKUP_COMPRESSION_LEVEL=${BACKUP_COMPRESSION_LEVEL:-1}
CHECK_INTERVAL=300

GREEN='\033[0;32m'
NC='\033[0m'
log() { echo -e "${GREEN}[Auto-Backup]${NC} $1"; }

log "========================================"
log "  Auto-Backup Service Starting..."
log "========================================"
log "  Backup directory:  $BACKUP_DIR"
log "  Max backups:       $MAX_BACKUPS"
log "  Backup interval:   every ${BACKUP_INTERVAL_HOURS}h"
log "  Compression level: $BACKUP_COMPRESSION_LEVEL"
log ""

mkdir -p "$BACKUP_DIR"

LAST_BACKUP_STAMP="$BACKUP_DIR/.last-backup-time"

# Seed from persisted timestamp so restarts don't reset the interval
if [ -f "$LAST_BACKUP_STAMP" ]; then
    LAST_BACKUP_TIME=$(cat "$LAST_BACKUP_STAMP" 2>/dev/null || date +%s)
else
    # No record — treat as if backup ran at epoch 0 so it triggers promptly
    LAST_BACKUP_TIME=0
fi

get_farm_slug() {
    node -e "
const fs = require('fs'), path = require('path');
const SAVE_DIR   = '${SAVE_DIR}';
const SAVES      = path.join(SAVE_DIR, 'Saves');
const LIVE       = '/home/steam/.local/share/stardrop/live-status.json';
const PREFS      = path.join(SAVE_DIR, 'startup_preferences');
const SEL_MARKER = path.join(SAVES, '.selected_save');

function slugify(name) {
    const s = name.toLowerCase().replace(/\s+/g,'_').replace(/[^a-z0-9_-]/g,'');
    return s || null;
}

function farmNameFromSaveDir(saveDir) {
    try {
        const info = path.join(SAVES, saveDir, 'SaveGameInfo');
        if (!fs.existsSync(info)) return null;
        const m = fs.readFileSync(info, 'utf8').match(/<farmName>([^<]+)<\/farmName>/);
        return m ? m[1] : null;
    } catch { return null; }
}

try {
    // 1. startup_preferences <saveFolderName>
    if (fs.existsSync(PREFS)) {
        const m = fs.readFileSync(PREFS, 'utf8').match(/<saveFolderName>([^<]+)<\/saveFolderName>/);
        if (m && m[1].trim()) {
            const name = farmNameFromSaveDir(m[1].trim());
            if (name) { const s = slugify(name); if (s) { process.stdout.write(s); process.exit(0); } }
        }
    }
    // 2. .selected_save marker
    if (fs.existsSync(SEL_MARKER)) {
        const sel = fs.readFileSync(SEL_MARKER, 'utf8').trim();
        if (sel) {
            const name = farmNameFromSaveDir(sel);
            if (name) { const s = slugify(name); if (s) { process.stdout.write(s); process.exit(0); } }
        }
    }
    // 3. live-status.json farmName
    if (fs.existsSync(LIVE)) {
        const live = JSON.parse(fs.readFileSync(LIVE, 'utf8'));
        if (live.farmName) { const s = slugify(live.farmName); if (s) { process.stdout.write(s); process.exit(0); } }
    }
    // 4. Scan all SaveGameInfo files
    if (fs.existsSync(SAVES)) {
        for (const dir of fs.readdirSync(SAVES)) {
            const name = farmNameFromSaveDir(dir);
            if (name) { const s = slugify(name); if (s) { process.stdout.write(s); process.exit(0); } }
        }
    }
} catch(e) {}
process.stdout.write('stardrop');
" 2>/dev/null || echo "stardrop"
}

do_backup() {
    local timestamp farm_slug backup_file
    timestamp=$(date -u '+D%d-%m-%Y-T%H-%M-%S')
    farm_slug=$(get_farm_slug)
    backup_file="$BACKUP_DIR/${farm_slug}-auto-backup-$timestamp.zip"

    log "Starting backup..."

    if [ ! -d "$SAVE_DIR/Saves" ] && [ ! -d "$SAVE_DIR" ]; then
        log "No save files found, skipping backup"
        return 1
    fi

    local file_count
    file_count=$(find "$SAVE_DIR" -type f 2>/dev/null | wc -l)
    log "  Files to backup: $file_count"

    (cd "$(dirname "$SAVE_DIR")" && zip -r "$backup_file" "$(basename "$SAVE_DIR")" -x "*/ErrorLogs/*") 2>/dev/null

    if [ $? -ne 0 ]; then
        log "❌ Backup failed"
        rm -f "$backup_file" 2>/dev/null
        return 1
    fi

    local size
    size=$(du -h "$backup_file" 2>/dev/null | cut -f1)
    log "✅ Backup complete: $backup_file ($size)"

    # Cleanup old backups (all .zip/.tar.gz in backup dir, oldest first)
    local backup_count
    backup_count=$(ls -1t "$BACKUP_DIR"/*.zip "$BACKUP_DIR"/*.tar.gz 2>/dev/null | wc -l)
    if [ "$backup_count" -gt "$MAX_BACKUPS" ]; then
        local to_delete=$((backup_count - MAX_BACKUPS))
        log "  Removing $to_delete old backup(s)..."
        ls -1t "$BACKUP_DIR"/*.zip "$BACKUP_DIR"/*.tar.gz 2>/dev/null | tail -n "$to_delete" | xargs rm -f
        log "  ✅ Old backups removed"
    fi

    log "  Backups: $backup_count / $MAX_BACKUPS"

    LAST_BACKUP_TIME=$(date +%s)
    echo "$LAST_BACKUP_TIME" > "$LAST_BACKUP_STAMP"
    return 0
}

# Main loop - check every 5 minutes
while true; do
    NOW=$(date +%s)
    ELAPSED_HOURS=$(( (NOW - LAST_BACKUP_TIME) / 3600 ))

    if [ "$ELAPSED_HOURS" -ge "$BACKUP_INTERVAL_HOURS" ]; then
        log "Scheduled backup (interval: ${BACKUP_INTERVAL_HOURS}h, elapsed: ${ELAPSED_HOURS}h)"
        do_backup
    fi

    sleep $CHECK_INTERVAL
done