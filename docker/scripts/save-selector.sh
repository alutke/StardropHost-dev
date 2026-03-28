#!/bin/bash
# ===========================================
# StardropHost | scripts/save-selector.sh
# ===========================================
# Selects which save file to auto-load.
# If SAVE_NAME is set, creates a marker file
# for the StardropHost.Dependencies mod to pick up.
# ===========================================

SAVE_DIR="/home/steam/.config/StardewValley/Saves"
SAVE_NAME="${SAVE_NAME:-}"

log() { echo -e "\033[0;32m[Save-Selector]\033[0m $1"; }

if [ -n "$SAVE_NAME" ]; then
    log "Save name specified: $SAVE_NAME"

    if [ -d "$SAVE_DIR/$SAVE_NAME" ]; then
        log "✅ Save found: $SAVE_NAME"
        mkdir -p "$SAVE_DIR"
        echo "$SAVE_NAME" > "$SAVE_DIR/.selected_save"
        log "✅ Auto-load set: $SAVE_NAME"
    else
        log "Save not found: $SAVE_NAME"
        log "Available saves:"
        if [ -d "$SAVE_DIR" ]; then
            ls -1 "$SAVE_DIR" 2>/dev/null | grep -v "^\." | while read save; do
                log "  - $save"
            done
        else
            log "  No saves directory found"
        fi
        log "Falling back to default save load logic"
    fi
else
    log "No save name specified, using default save load logic"
fi