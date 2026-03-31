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

LAST_BACKUP_TIME=0

get_farm_slug() {
    node -e "
const fs = require('fs'), path = require('path');
const SAVES  = '${SAVE_DIR}/Saves';
const PREFS  = '${SAVE_DIR}/startup_preferences';
const MARKER = '${SAVE_DIR}/.selected_save';
try {
    // Primary: startup_preferences XML
    let saveName = '';
    if (fs.existsSync(PREFS)) {
        const m = fs.readFileSync(PREFS, 'utf8').match(/<saveFolderName>([^<]+)<\/saveFolderName>/);
        if (m) saveName = m[1].trim();
    }
    // Fallback: .selected_save marker (game strips saveFolderName on launch)
    if (!saveName && fs.existsSync(MARKER)) {
        saveName = fs.readFileSync(MARKER, 'utf8').trim();
    }
    if (!saveName) { process.stdout.write('stardrop'); return; }
    // Read SaveGameInfo — small metadata file, much faster than the main save
    const infoPath = path.join(SAVES, saveName, 'SaveGameInfo');
    const xml = fs.readFileSync(infoPath, 'utf8');
    const n = xml.match(/<farmName>([^<]+)<\/farmName>/);
    const slug = (n ? n[1] : 'stardrop').toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_-]/g, '');
    process.stdout.write(slug || 'stardrop');
} catch(e) { process.stdout.write('stardrop'); }
" 2>/dev/null || echo "stardrop"
}

do_backup() {
    local timestamp farm_slug backup_file
    timestamp=$(date '+D-%-d-%-m-%Y-T-%H-%M-%S')
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

    # Cleanup old backups (match any *-auto-backup-*.zip pattern)
    local backup_count
    backup_count=$(ls -1t "$BACKUP_DIR"/*-auto-backup-*.zip 2>/dev/null | wc -l)
    if [ "$backup_count" -gt "$MAX_BACKUPS" ]; then
        local to_delete=$((backup_count - MAX_BACKUPS))
        log "  Removing $to_delete old backup(s)..."
        ls -1t "$BACKUP_DIR"/*-auto-backup-*.zip | tail -n "$to_delete" | xargs rm -f
        log "  ✅ Old backups removed"
    fi

    log "  Backups: $(ls -1 "$BACKUP_DIR"/*-auto-backup-*.zip 2>/dev/null | wc -l) / $MAX_BACKUPS"

    LAST_BACKUP_TIME=$(date +%s)
    return 0
}

# Wait for game to initialise
log "Waiting for game to initialize..."
sleep 60

# Initial backup on startup
log "Running startup backup..."
do_backup

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