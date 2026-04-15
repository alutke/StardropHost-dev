/**
 * StardropHost | web-panel/api/players.js
 * Player information, management and history
 */

const fs   = require('fs');
const path = require('path');
const config = require('../server');

// -- Security config (blocklist + allowlist + mode) --
const SECURITY_FILE    = path.join(config.DATA_DIR, 'security.json');
const NAME_IP_MAP_FILE = path.join(config.DATA_DIR, 'name-ip-map.json');
const IP_LOCKS_FILE    = path.join(config.DATA_DIR, 'ip-locks.json');
// Legacy file — migrated on first write to security.json
const LEGACY_BLOCKLIST = path.join(config.DATA_DIR, 'ip-blocklist.json');

function normaliseEntry(e) {
  return {
    type:        e.type || 'name',
    value:       (e.value || e.ip || '').trim(),
    description: (e.description || '').trim(),
    addedAt:     e.addedAt || new Date().toISOString(),
  };
}

function loadSecurity() {
  try {
    if (fs.existsSync(SECURITY_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SECURITY_FILE, 'utf-8'));
      const sec = {
        mode:      raw.mode || 'block',
        blocklist: (raw.blocklist || []).map(normaliseEntry).filter(e => e.value),
        allowlist: (raw.allowlist || []).map(normaliseEntry).filter(e => e.value),
      };
      return sec;
    }
    // Migrate from legacy ip-blocklist.json
    if (fs.existsSync(LEGACY_BLOCKLIST)) {
      const old = JSON.parse(fs.readFileSync(LEGACY_BLOCKLIST, 'utf-8'));
      if (Array.isArray(old)) {
        const sec = { mode: 'block', blocklist: old.map(normaliseEntry).filter(e => e.value), allowlist: [] };
        saveSecurity(sec);
        return sec;
      }
    }
  } catch {}
  return { mode: 'block', blocklist: [], allowlist: [] };
}

function saveSecurity(sec) {
  try { fs.writeFileSync(SECURITY_FILE, JSON.stringify(sec, null, 2), 'utf-8'); } catch {}
}

function loadNameIpMap() {
  try {
    if (fs.existsSync(NAME_IP_MAP_FILE))
      return JSON.parse(fs.readFileSync(NAME_IP_MAP_FILE, 'utf-8'));
  } catch {}
  return {};
}

function saveNameIpMap(map) {
  try { fs.writeFileSync(NAME_IP_MAP_FILE, JSON.stringify(map, null, 2), 'utf-8'); } catch {}
}

function loadIpLocks() {
  try {
    if (fs.existsSync(IP_LOCKS_FILE))
      return new Set(JSON.parse(fs.readFileSync(IP_LOCKS_FILE, 'utf-8')));
  } catch {}
  return new Set();
}

function saveIpLocks(set) {
  try { fs.writeFileSync(IP_LOCKS_FILE, JSON.stringify([...set], null, 2), 'utf-8'); } catch {}
}

// Build name→IP map from chat.log join messages (written by the mod)
const CHAT_LOG = '/home/steam/.local/share/stardrop/chat.log';

function syncNameIpMapFromChat(onlineNames, lockedNames) {
  try {
    if (!fs.existsSync(CHAT_LOG)) return;
    const lines = fs.readFileSync(CHAT_LOG, 'utf-8').trim().split('\n').filter(Boolean);
    const map = loadNameIpMap();
    let changed = false;
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        const m = msg.message && msg.message.match(/^(.+?) \((\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\) has joined/);
        if (m) {
          const name = m[1].trim(), ip = m[2];
          // Skip unresolved SDV placeholder names
          if (name === 'Unnamed Farmhand' || name.startsWith('Unnamed')) continue;
          // Only update if this player is currently online — avoids re-adding removed entries
          if (name && ip && onlineNames.has(name) && !lockedNames.has(name)) {
            const existing = Array.isArray(map[name]) ? map[name] : (map[name] ? [map[name]] : []);
            if (!existing.includes(ip)) { map[name] = [...existing, ip]; changed = true; }
          }
        }
      } catch {}
    }
    if (changed) saveNameIpMap(map);
  } catch {}
}

// Returns the most recent join IP for each name in onlineNames (last match wins)
function getLatestIpsFromChat(onlineNames) {
  const result = {};
  try {
    if (!fs.existsSync(CHAT_LOG)) return result;
    const lines = fs.readFileSync(CHAT_LOG, 'utf-8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        const m = msg.message?.match(/^(.+?) \((\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\) has joined/);
        if (m) {
          const name = m[1].trim(), ip = m[2];
          if (onlineNames.has(name)) result[name] = ip;
        }
      } catch {}
    }
  } catch {}
  return result;
}

// -- Player history (24h at 5min intervals) --
const playerHistory = [];
const MAX_PLAYER_HISTORY = 288;

// -- Connected players cache --
let connectedPlayers = [];
let lastLogParse = 0;

// -- Recent players tracking --
const playerSnapshots = new Map(); // id → rich player data from live-status.json

const RECENT_PLAYERS_FILE = path.join(config.DATA_DIR, 'recent-players.json');

function loadRecentPlayers() {
  try {
    if (fs.existsSync(RECENT_PLAYERS_FILE))
      return new Map(Object.entries(JSON.parse(fs.readFileSync(RECENT_PLAYERS_FILE, 'utf-8'))));
  } catch {}
  return new Map();
}

function saveRecentPlayers() {
  try {
    fs.writeFileSync(RECENT_PLAYERS_FILE, JSON.stringify(Object.fromEntries(recentPlayers)), 'utf-8');
  } catch {}
}

const recentPlayers = loadRecentPlayers();

// -- Security check cache — only check new arrivals, not every poll --
const securityCheckedIds = new Set(); // IDs that have already passed the security check
function invalidateSecurityCache() { securityCheckedIds.clear(); } // call when blocklist/allowlist changes

// -- Ban list --
const BAN_LIST_FILE = path.join(config.DATA_DIR, 'bans.json');

function loadBans() {
  try {
    if (fs.existsSync(BAN_LIST_FILE))
      return JSON.parse(fs.readFileSync(BAN_LIST_FILE, 'utf-8'));
  } catch {}
  return [];
}

function saveBans(bans) {
  try { fs.writeFileSync(BAN_LIST_FILE, JSON.stringify(bans, null, 2), 'utf-8'); } catch {}
}

// -- Parse players from SMAPI log --
// BUG FIX: Player IDs are large negative numbers (e.g. -3472295406447050512)
// Regex uses [-0-9]+ to match actual numeric IDs
function parsePlayersFromLogs() {
  const now = Date.now();
  if (now - lastLogParse < 2000) return connectedPlayers;

  try {
    if (!fs.existsSync(config.SMAPI_LOG)) return connectedPlayers;

    const content = fs.readFileSync(config.SMAPI_LOG, 'utf-8');
    const lines   = content.split('\n');
    const players = new Map();

    for (const line of lines) {
      const joinMatch =
        line.match(/Received connection for vanilla player ([-0-9]+)/i) ||
        line.match(/Approved request for farmhand ([-0-9]+)/i) ||
        line.match(/farmhand ([-0-9]+) connected/i) ||
        line.match(/client ([-0-9]+) connected/i) ||
        line.match(/peer ([-0-9]+) joined/i);

      if (joinMatch) {
        const id = joinMatch[1];
        players.set(id, { id, name: formatPlayerId(id), joinedAt: new Date().toISOString(), isOnline: true });
        continue;
      }

      const leaveMatch =
        line.match(/farmhand ([-0-9]+) disconnected/i) ||
        line.match(/client ([-0-9]+) disconnected/i) ||
        line.match(/peer ([-0-9]+) left/i) ||
        line.match(/connection ([-0-9]+) disconnected/i) ||
        line.match(/player ([-0-9]+) disconnected/i);

      if (leaveMatch) players.delete(leaveMatch[1]);
    }

    connectedPlayers = Array.from(players.values());
    lastLogParse = now;
  } catch {}

  return connectedPlayers;
}

// -- Try to get richer player data from live-status.json --
let _separateWallets = false;

function getPlayersFromLiveStatus() {
  try {
    if (fs.existsSync(config.LIVE_FILE)) {
      const live = JSON.parse(fs.readFileSync(config.LIVE_FILE, 'utf-8'));
      _separateWallets = live.separateWallets === true;
      if (live.players?.length > 0) {
        const online = live.players
          .filter(p => p.isOnline && !p.isHost)
          .map(p => ({
            id:          p.uniqueId,
            name:        p.name || formatPlayerId(p.uniqueId),
            joinedAt:    null,
            isOnline:    true,
            health:      p.health,
            maxHealth:   p.maxHealth,
            stamina:     Math.floor(p.stamina ?? 0),
            maxStamina:  Math.floor(p.maxStamina ?? 0),
            money:       p.money,
            totalEarned: p.totalEarned,
            daysPlayed:         p.daysPlayed,
            totalPlaytimeHours: p.totalPlaytimeHours ?? null,
            location:    p.locationName,
            skills:      p.skills,
            tileX:       p.tileX,
            tileY:       p.tileY,
          }));
        for (const p of online) playerSnapshots.set(p.id, p);
        if (online.length > 0) return online;
      }
      // Live-status exists and server is running — trust it, don't fall back to log parsing
      // (prevents half-connected farmhand IDs from appearing during player load)
      if (live.serverState === 'running') return [];
    }
  } catch {}
  return null;
}

function formatPlayerId(id) {
  if (!id) return 'Player';
  const str = String(id).replace('-', '');
  return `Farmhand #${str.slice(-6)}`;
}

function getOnlineCount() {
  try {
    if (fs.existsSync(config.STATUS_FILE)) {
      const data = JSON.parse(fs.readFileSync(config.STATUS_FILE, 'utf-8'));
      if (data.game?.players_online !== undefined) return data.game.players_online || 0;
      return data.players_online || 0;
    }
  } catch {}
  return connectedPlayers.length;
}

// -- Record player count history every 5 minutes --
setInterval(() => {
  playerHistory.push({ timestamp: new Date().toISOString(), count: getOnlineCount() });
  if (playerHistory.length > MAX_PLAYER_HISTORY) playerHistory.shift();
}, 5 * 60 * 1000);

// -- Send SMAPI console command --
const SMAPI_STDIN = '/home/steam/web-panel/data/smapi-stdin';

function sendConsoleCommand(command) {
  try {
    if (!fs.existsSync(SMAPI_STDIN)) return false;
    const input = command.endsWith('\n') ? command : `${command}\n`;
    fs.appendFileSync(SMAPI_STDIN, input);
    return true;
  } catch { return false; }
}

// -- Route Handlers --

function getPlayers(req, res) {
  const livePlayers = getPlayersFromLiveStatus();
  const logPlayers  = parsePlayersFromLogs();
  const players     = livePlayers || logPlayers;
  const online      = getOnlineCount();

  const onlineIds = new Set(players.map(p => p.id));
  let recentChanged = false;
  for (const [id, snapshot] of playerSnapshots) {
    if (!onlineIds.has(id)) {
      recentPlayers.set(id, { ...snapshot, lastSeen: Date.now() });
      playerSnapshots.delete(id);
      securityCheckedIds.delete(id); // allow re-check if they rejoin
      recentChanged = true;
    }
  }
  if (recentChanged) saveRecentPlayers();

  const bans       = loadBans();
  const bannedIds   = new Set(bans.map(b => b.id).filter(Boolean));
  const bannedNames = new Set(bans.map(b => b.name).filter(Boolean));
  const security      = loadSecurity();
  const ipLocks       = loadIpLocks();
  const onlineNameSet = new Set(players.map(p => p.name).filter(Boolean));
  syncNameIpMapFromChat(onlineNameSet, ipLocks);
  const nameIpMap  = loadNameIpMap();
  const latestIps  = getLatestIpsFromChat(onlineNameSet);

  // Enforce blocklist / allowlist — only checks players not yet cleared this session
  for (const p of players) {
    if (securityCheckedIds.has(p.id)) continue;

    // IP lock: kick if joining from an IP not in their known list
    if (ipLocks.has(p.name)) {
      const currentIp = latestIps[p.name];
      const knownIps  = Array.isArray(nameIpMap[p.name]) ? nameIpMap[p.name] : (nameIpMap[p.name] ? [nameIpMap[p.name]] : []);
      if (currentIp && !knownIps.includes(currentIp)) {
        sendConsoleCommand(`kick "${p.name}"`);
        continue;
      }
    }

    const raw = nameIpMap[p.name];
    const playerIps = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    const blocked = security.blocklist.some(e =>
      (e.type === 'name' && e.value.toLowerCase() === (p.name || '').toLowerCase()) ||
      (e.type === 'ip'   && playerIps.includes(e.value))
    );
    if (blocked) { sendConsoleCommand(`ban "${p.name}"`); continue; }

    if (security.mode === 'allow') {
      const allowed = security.allowlist.some(e =>
        (e.type === 'name' && e.value.toLowerCase() === (p.name || '').toLowerCase()) ||
        (e.type === 'ip'   && playerIps.includes(e.value))
      );
      if (!allowed) { sendConsoleCommand(`kick "${p.name}"`); continue; }
    }

    securityCheckedIds.add(p.id); // passed — don't re-check until they rejoin or list changes
  }

  // Attach known IP to each online player
  const playersWithIp = players.map(p => ({
    ...p,
    knownIps: (() => { const v = nameIpMap[p.name]; return Array.isArray(v) ? v : (v ? [v] : []); })(),
  }));

  // Strip any stale placeholder entries before sending to frontend
  const cleanNameIpMap = Object.fromEntries(
    Object.entries(nameIpMap).filter(([k]) => !k.startsWith('Unnamed'))
  );

  let cabinMax = 8;
  try {
    if (fs.existsSync(config.LIVE_FILE)) {
      const live = JSON.parse(fs.readFileSync(config.LIVE_FILE, 'utf-8'));
      if (live.cabins?.length > 0) cabinMax = live.cabins.length;
    }
  } catch {}

  res.json({
    online: Math.max(online, players.length),
    max: cabinMax,
    players: playersWithIp,
    recentPlayers:   Array.from(recentPlayers.values()).sort((a, b) => b.lastSeen - a.lastSeen),
    history:         playerHistory,
    bannedIds:       Array.from(bannedIds),
    bannedNames:     Array.from(bannedNames),
    separateWallets: _separateWallets,
    security,
    nameIpMap: cleanNameIpMap,
    ipLocks: [...ipLocks],
  });
}

function kickPlayer(req, res) {
  const { id, name } = req.body;
  if (!id && !name) return res.status(400).json({ error: 'Player id or name is required' });
  const target  = name || id;
  const success = sendConsoleCommand(`kick ${target}`);
  if (success) res.json({ success: true, message: `Kicked ${target}` });
  else res.status(500).json({ error: 'Failed to send kick command — is the server running?' });
}

function banPlayer(req, res) {
  const { id, name } = req.body;
  if (!id && !name) return res.status(400).json({ error: 'Player id or name is required' });
  const target = name || id;
  const bans   = loadBans();
  if (!bans.find(b => b.id === id || b.name === name)) {
    bans.push({ id, name, bannedAt: new Date().toISOString() });
    saveBans(bans);
  }
  const success = sendConsoleCommand(`ban ${target}`);
  if (success) res.json({ success: true, message: `Banned ${target}` });
  else res.status(500).json({ error: 'Failed to send ban command — is the server running?' });
}

function unbanPlayer(req, res) {
  const { id, name } = req.body;
  if (!id && !name) return res.status(400).json({ error: 'Player id or name is required' });
  const bans = loadBans().filter(b => b.id !== id && b.name !== name);
  saveBans(bans);
  const target = name || id;
  sendConsoleCommand(`unban ${target}`);
  res.json({ success: true, message: `Unbanned ${target}` });
}

function deleteRecentPlayer(req, res) {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id is required' });
  recentPlayers.delete(String(id));
  saveRecentPlayers();
  res.json({ success: true });
}

function grantAdmin(req, res) {
  const { id, name } = req.body;
  if (!id && !name) return res.status(400).json({ error: 'Player id or name is required' });
  const target  = name || id;
  const success = sendConsoleCommand(`admin ${target}`);
  if (success) res.json({ success: true, message: `Admin granted to ${target}` });
  else res.status(500).json({ error: 'Failed to send admin command' });
}

// -- Security routes --

function getSecurity(req, res) {
  res.json({ security: loadSecurity(), nameIpMap: loadNameIpMap() });
}

function setSecurityMode(req, res) {
  const { mode } = req.body || {};
  if (mode !== 'block' && mode !== 'allow')
    return res.status(400).json({ error: 'mode must be "block" or "allow"' });
  const sec  = loadSecurity();
  sec.mode   = mode;
  saveSecurity(sec);
  invalidateSecurityCache();
  res.json({ success: true, security: sec });
}

// -- Blocklist routes --

function getBlocklist(req, res) {
  const sec = loadSecurity();
  res.json({ blocklist: sec.blocklist, mode: sec.mode });
}

function addBlocklistEntry(req, res) {
  const { type, value, description } = req.body || {};
  if (!value || typeof value !== 'string')
    return res.status(400).json({ error: 'Name or IP is required' });

  const entryType = (type === 'ip') ? 'ip' : 'name';
  const trimmed   = value.trim();
  if (entryType === 'ip' && !/^[\d.:a-fA-F/]+$/.test(trimmed))
    return res.status(400).json({ error: 'Invalid IP format' });

  const sec = loadSecurity();
  if (sec.blocklist.find(e => e.value === trimmed))
    return res.status(409).json({ error: 'Already in block list' });

  sec.blocklist.push({ type: entryType, value: trimmed, description: (description || '').trim(), addedAt: new Date().toISOString() });
  saveSecurity(sec);
  invalidateSecurityCache(); // re-check all online players on next poll

  // Best-effort: kick if player is currently online by that name
  if (entryType === 'name') sendConsoleCommand(`kick "${trimmed}"`);

  res.json({ success: true, security: sec });
}

function removeBlocklistEntry(req, res) {
  const val = decodeURIComponent(req.params.value);
  const sec = loadSecurity();
  sec.blocklist = sec.blocklist.filter(e => e.value !== val);
  saveSecurity(sec);
  invalidateSecurityCache();
  res.json({ success: true, security: sec });
}

// -- Allowlist routes --

function addAllowlistEntry(req, res) {
  const { type, value, description } = req.body || {};
  if (!value || typeof value !== 'string')
    return res.status(400).json({ error: 'Name or IP is required' });

  const entryType = (type === 'ip') ? 'ip' : 'name';
  const trimmed   = value.trim();

  const sec = loadSecurity();
  if (sec.allowlist.find(e => e.value === trimmed))
    return res.status(409).json({ error: 'Already in allow list' });

  sec.allowlist.push({ type: entryType, value: trimmed, description: (description || '').trim(), addedAt: new Date().toISOString() });
  saveSecurity(sec);
  invalidateSecurityCache();
  res.json({ success: true, security: sec });
}

function removeAllowlistEntry(req, res) {
  const val = decodeURIComponent(req.params.value);
  const sec = loadSecurity();
  sec.allowlist = sec.allowlist.filter(e => e.value !== val);
  saveSecurity(sec);
  invalidateSecurityCache();
  res.json({ success: true, security: sec });
}

// -- Name→IP map routes (written by mod on player join, readable/editable by panel) --

function getNameIpMap(req, res) {
  res.json({ nameIpMap: loadNameIpMap() });
}

function updateNameIpEntry(req, res) {
  const name = decodeURIComponent(req.params.name);
  const { ip } = req.body || {};
  if (!ip || typeof ip !== 'string') return res.status(400).json({ error: 'ip is required' });
  if (!/^[\d.]+$/.test(ip.trim())) return res.status(400).json({ error: 'Invalid IP format' });
  const map = loadNameIpMap();
  map[name] = ip.trim();
  saveNameIpMap(map);
  res.json({ success: true, nameIpMap: map });
}

function deleteNameIpEntry(req, res) {
  const name = decodeURIComponent(req.params.name);
  const ip   = req.query.ip ? decodeURIComponent(req.query.ip) : null;
  const map  = loadNameIpMap();
  if (ip) {
    // Remove just this IP — if no IPs left, remove the player entry entirely
    const existing = Array.isArray(map[name]) ? map[name] : (map[name] ? [map[name]] : []);
    const remaining = existing.filter(i => i !== ip);
    if (remaining.length) map[name] = remaining;
    else delete map[name];
  } else {
    delete map[name];
  }
  saveNameIpMap(map);
  res.json({ success: true, nameIpMap: map });
}

// -- Admin command (host-targeted SMAPI commands) --

const ALLOWED_ADMIN_COMMANDS = new Set([
  'player_setmoney', 'player_sethealth', 'player_setmaxhealth',
  'player_setstamina', 'player_setmaxstamina', 'player_add',
  'world_settime', 'world_setday', 'world_setseason', 'world_setyear',
  'world_freezetime', 'hurry_all', 'world_clear', 'debug', 'kick',
  'set_farm_type',
  'say',
  'stardrop_deletefarmhand', 'stardrop_upgradehouse', 'stardrop_watercrops',
  'stardrop_growcrops', 'stardrop_growgrass', 'stardrop_growwildtrees', 'stardrop_fruittrees',
  'stardrop_upgradecabin', 'stardrop_movecabin',
  'stardrop_cropsaver', 'stardrop_giveitem', 'stardrop_removegiftchest',
  'stardrop_listfarmhands',
]);

function adminCommand(req, res) {
  const { command } = req.body || {};
  if (!command || typeof command !== 'string') return res.status(400).json({ error: 'command is required' });
  const cmd  = command.trim();
  const base = cmd.split(/\s+/)[0].toLowerCase();
  if (!ALLOWED_ADMIN_COMMANDS.has(base))
    return res.status(403).json({ error: `Command '${base}' is not permitted` });
  const success = sendConsoleCommand(cmd);
  if (success) res.json({ success: true });
  else res.status(500).json({ error: 'Failed to send command — is the server running?' });
}

function getIpLocks(req, res) {
  res.json({ ipLocks: [...loadIpLocks()] });
}

function addIpLock(req, res) {
  const { name } = req.body || {};
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name is required' });
  const locks = loadIpLocks();
  locks.add(name.trim());
  saveIpLocks(locks);
  invalidateSecurityCache();
  res.json({ success: true, ipLocks: [...locks] });
}

function removeIpLock(req, res) {
  const name = decodeURIComponent(req.params.name);
  const locks = loadIpLocks();
  locks.delete(name);
  saveIpLocks(locks);
  invalidateSecurityCache();
  res.json({ success: true, ipLocks: [...locks] });
}

// ─── Farmhands ───────────────────────────────────────────────────

function readCabinUpgradeLevels() {
  // Primary: mod-written file (DATA_DIR/cabin-upgrade-levels.json) — updated immediately on upgrade
  try {
    const modFile = path.join(config.DATA_DIR, 'cabin-upgrade-levels.json');
    if (fs.existsSync(modFile)) {
      const data = JSON.parse(fs.readFileSync(modFile, 'utf-8'));
      if (data && typeof data === 'object') return data;
    }
  } catch {}

  // Fallback: save file XML (only accurate after game saves at end of day)
  try {
    const STARTUP_PREFS = path.join(config.CONFIG_DIR, 'startup_preferences');
    const SELECTED_SAVE = path.join(config.SAVES_DIR, '.selected_save');
    let saveName = '';
    if (fs.existsSync(STARTUP_PREFS)) {
      const m = fs.readFileSync(STARTUP_PREFS, 'utf-8').match(/<saveFolderName>([^<]+)<\/saveFolderName>/);
      if (m) saveName = m[1].trim();
    }
    if (!saveName && fs.existsSync(SELECTED_SAVE))
      saveName = fs.readFileSync(SELECTED_SAVE, 'utf-8').trim();
    if (!saveName) return {};

    const actualSaveFile = path.join(config.SAVES_DIR, saveName, saveName);
    if (!fs.existsSync(actualSaveFile)) return {};

    const xml = fs.readFileSync(actualSaveFile, 'utf-8');
    const levels = {};
    const farmhandSection = xml.match(/<farmhands>([\s\S]*?)<\/farmhands>/);
    if (!farmhandSection) return {};
    for (const block of farmhandSection[1].matchAll(/<Farmer>([\s\S]*?)<\/Farmer>/g)) {
      const nameMatch  = block[1].match(/<name>([^<]+)<\/name>/);
      const levelMatch = block[1].match(/<houseUpgradeLevel>(\d+)<\/houseUpgradeLevel>/);
      if (nameMatch) levels[nameMatch[1].trim()] = levelMatch ? parseInt(levelMatch[1]) : 0;
    }
    return levels;
  } catch { return {}; }
}

function getFarmhands(req, res) {
  try {
    if (!fs.existsSync(config.LIVE_FILE)) return res.json({ cabins: [], serverState: null });
    const live   = JSON.parse(fs.readFileSync(config.LIVE_FILE, 'utf-8'));
    const levels = readCabinUpgradeLevels();
    const cabins = (live.cabins || []).map(c => ({
      ...c,
      upgradeLevel: levels[c.ownerName] ?? 0,
    }));
    res.json({ cabins, serverState: live.serverState || null });
  } catch {
    res.json({ cabins: [], serverState: null });
  }
}

function deleteFarmhand(req, res) {
  const { ownerName } = req.body || {};
  if (!ownerName || typeof ownerName !== 'string') return res.status(400).json({ error: 'ownerName required' });

  // Refuse if player is currently online (live-status check)
  try {
    if (fs.existsSync(config.LIVE_FILE)) {
      const live = JSON.parse(fs.readFileSync(config.LIVE_FILE, 'utf-8'));
      const isOnline = (live.cabins || []).some(
        c => c.ownerName === ownerName && (c.isOwnerOnline ?? false)
      );
      if (isOnline) return res.status(400).json({ error: `Cannot delete '${ownerName}' — they are currently online.` });
    }
  } catch {}

  const success = sendConsoleCommand(`stardrop_deletefarmhand ${ownerName}`);
  if (success) res.json({ success: true });
  else res.status(500).json({ error: 'Failed to send command — is the server running?' });
}

function upgradeCabin(req, res) {
  const { ownerName, targetLevel } = req.body || {};
  if (!ownerName || typeof ownerName !== 'string') return res.status(400).json({ error: 'ownerName required' });
  const lvl = Number(targetLevel);
  if (!Number.isInteger(lvl) || lvl < 1 || lvl > 3) return res.status(400).json({ error: 'targetLevel must be 1, 2, or 3' });
  const success = sendConsoleCommand(`stardrop_upgradecabin ${ownerName} ${lvl}`);
  if (success) res.json({ success: true });
  else res.status(500).json({ error: 'Failed to send command — is the server running?' });
}

module.exports = {
  getPlayers,
  kickPlayer,
  banPlayer,
  unbanPlayer,
  grantAdmin,
  deleteRecentPlayer,
  getSecurity,
  setSecurityMode,
  getBlocklist,
  addBlocklistEntry,
  removeBlocklistEntry,
  addAllowlistEntry,
  removeAllowlistEntry,
  getNameIpMap,
  updateNameIpEntry,
  deleteNameIpEntry,
  adminCommand,
  getIpLocks,
  addIpLock,
  removeIpLock,
  getFarmhands,
  deleteFarmhand,
  upgradeCabin,
  readCabinUpgradeLevels,
};
