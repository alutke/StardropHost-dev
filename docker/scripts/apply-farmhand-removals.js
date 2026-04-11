#!/usr/bin/env node
/**
 * StardropHost | apply-farmhand-removals.js
 * Runs at server startup (via entrypoint.sh) BEFORE SMAPI loads.
 * Reads pending-farmhand-removals.json and deletes the matching <Farmer>
 * block from <farmhands> in the active save file, freeing the cabin slot.
 */

const fs   = require('fs');
const path = require('path');

const PENDING    = '/home/steam/web-panel/data/pending-farmhand-removals.json';
const PREFS      = '/home/steam/.config/StardewValley/startup_preferences';
const SAVES_DIR  = '/home/steam/.config/StardewValley/Saves';
const BACKUP_DIR = '/home/steam/.local/share/stardrop/backups';

function log(msg) { process.stdout.write(`[FarmhandRemoval] ${msg}\n`); }

if (!fs.existsSync(PENDING)) process.exit(0);

let pending;
try { pending = JSON.parse(fs.readFileSync(PENDING, 'utf-8')); } catch {
  log('Could not parse pending file — skipping'); process.exit(0);
}
if (!Array.isArray(pending) || !pending.length) {
  try { fs.unlinkSync(PENDING); } catch {}
  process.exit(0);
}

// Find the active save folder name
function getSelectedSave() {
  try {
    const prefs = fs.readFileSync(PREFS, 'utf-8');
    const m = prefs.match(/<saveFolderName>([^<]+)<\/saveFolderName>/);
    if (m?.[1]?.trim()) return m[1].trim();
  } catch {}
  try {
    const dirs = fs.readdirSync(SAVES_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => d.name);
    return dirs[0] || null;
  } catch { return null; }
}

const saveName = getSelectedSave();
if (!saveName) { log('No active save found — skipping'); process.exit(0); }

const saveFile = path.join(SAVES_DIR, saveName, saveName);
if (!fs.existsSync(saveFile)) {
  log(`Save file not found: ${saveFile} — skipping`); process.exit(0);
}

// Backup before modifying
try {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const now = new Date();
  const dd = String(now.getUTCDate()).padStart(2,'0');
  const mm = String(now.getUTCMonth()+1).padStart(2,'0');
  const ts = `D${dd}-${mm}-${now.getUTCFullYear()}-T${String(now.getUTCHours()).padStart(2,'0')}-${String(now.getUTCMinutes()).padStart(2,'0')}-${String(now.getUTCSeconds()).padStart(2,'0')}`;
  const backupPath = path.join(BACKUP_DIR, `${saveName}-pre-farmhand-removal-${ts}.bak`);
  fs.copyFileSync(saveFile, backupPath);
  log(`Backup: ${backupPath}`);
} catch (e) { log(`Warning: backup failed — ${e.message}`); }

let xml = fs.readFileSync(saveFile, 'utf-8');
let anyModified = false;

for (const { ownerName } of pending) {
  if (!ownerName) { log('Skipping entry with no ownerName'); continue; }
  log(`Removing farmhand "${ownerName}"…`);

  // The save stores farmhands as <farmhands><Farmer><name>PlayerName</name>...</Farmer></farmhands>
  // Find and delete the entire <Farmer>...</Farmer> block whose <name> matches ownerName.
  const escapedName = ownerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`<Farmer><name>${escapedName}<\\/name>[\\s\\S]*?<\\/Farmer>`, 'g');

  const before = xml;
  xml = xml.replace(pattern, '');

  if (xml !== before) {
    log(`✅ "${ownerName}" removed`);
    anyModified = true;
  } else {
    log(`⚠️  No <Farmer> block found for "${ownerName}" — skipping`);
  }
}

if (anyModified) {
  fs.writeFileSync(saveFile, xml, 'utf-8');
  log('✅ Save file written');
}

try { fs.unlinkSync(PENDING); } catch {}
log('Done');
