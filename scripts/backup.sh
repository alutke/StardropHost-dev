#!/bin/bash
# ===========================================
# StardropHost | backup.sh
# ===========================================
# Backs up your Stardew Valley save files.
# Usage: bash scripts/backup.sh
# ===========================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# -- Colors --
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'
BOLD='\033[1m'

# -- Config --
SAVES_DIR="$PROJECT_DIR/data/saves"
BACKUP_DIR="$PROJECT_DIR/data/backups"
MAX_BACKUPS=7
TIMESTAMP=$(date -u '+%Y-%m-%dT%H-%M-%S')
BACKUP_FILE="stardrop-manual-backup-$TIMESTAMP.zip"

# -- Output Helpers --
print_success() { echo -e "${GREEN}✅ $1${NC}"; }
print_error()   { echo -e "${RED}❌ $1${NC}"; }
print_warning() { echo -e "${YELLOW}⚠️  $1${NC}"; }
print_info()    { echo -e "${BLUE}ℹ️  $1${NC}"; }
print_step()    { echo ""; echo -e "${BOLD}$1${NC}"; }

echo ""
echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${CYAN}${BOLD}  🌟 StardropHost - Backup${NC}"
echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# -- Check saves directory --
check_saves_dir() {
    if [ ! -d "$SAVES_DIR" ]; then
        print_error "Saves directory not found: $SAVES_DIR"
        echo ""
        echo "Make sure you're running this from the StardropHost directory."
        exit 1
    fi

    if [ -z "$(ls -A $SAVES_DIR 2>/dev/null)" ]; then
        print_warning "Saves directory is empty!"
        echo ""
        echo "No save files found. Has a game been started yet?"
        exit 1
    fi
}

# -- Create backup --
create_backup() {
    mkdir -p "$BACKUP_DIR"

    print_info "Creating backup: $BACKUP_FILE"

    (cd "$PROJECT_DIR/data" && zip -r "$BACKUP_DIR/$BACKUP_FILE" saves) 2>/dev/null

    backup_size=$(du -h "$BACKUP_DIR/$BACKUP_FILE" | cut -f1)
    print_success "Backup created: $BACKUP_FILE ($backup_size)"
}

# -- Cleanup old backups --
cleanup_old_backups() {
    backup_count=$(ls -1 "$BACKUP_DIR"/stardrop-manual-backup-*.zip 2>/dev/null | wc -l)

    if [ "$backup_count" -gt "$MAX_BACKUPS" ]; then
        print_info "Cleaning up old backups (keeping last $MAX_BACKUPS)..."
        ls -t "$BACKUP_DIR"/stardrop-manual-backup-*.zip | tail -n +$((MAX_BACKUPS + 1)) | xargs rm -f
        print_success "Old backups removed"
    fi
}

# -- List backups --
list_backups() {
    print_step "Available backups:"
    echo ""

    if [ ! -d "$BACKUP_DIR" ] || [ -z "$(ls -A $BACKUP_DIR 2>/dev/null)" ]; then
        print_info "No backups found yet."
        return
    fi

    ls -lth "$BACKUP_DIR"/stardrop-manual-backup-*.zip 2>/dev/null | awk '{
        size = $5
        date = $6 " " $7 " " $8
        file = $9
        gsub(/.*\//, "", file)
        printf "  📦 %-40s %8s  %s\n", file, size, date
    }'

    echo ""
    total_size=$(du -sh "$BACKUP_DIR" 2>/dev/null | cut -f1)
    echo -e "${BLUE}  Total backup size: $total_size${NC}"
}

# -- Restore instructions --
show_restore_instructions() {
    print_step "To restore a backup:"
    echo ""
    echo "  1. Stop the server:"
    echo -e "     ${CYAN}docker compose down${NC}"
    echo ""
    echo "  2. Backup current saves:"
    echo -e "     ${CYAN}mv data/saves data/saves.old${NC}"
    echo ""
    echo "  3. Extract backup:"
    echo -e "     ${CYAN}unzip data/backups/BACKUP_FILE -d data${NC}"
    echo ""
    echo "  4. Start the server:"
    echo -e "     ${CYAN}docker compose up -d${NC}"
    echo ""
}

# -- Run --
check_saves_dir
create_backup
cleanup_old_backups
list_backups
show_restore_instructions

echo -e "${GREEN}${BOLD}  🌟 Backup complete!${NC}"
echo ""
