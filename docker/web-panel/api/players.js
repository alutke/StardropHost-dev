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
      return {
        mode:      raw.mode || 'block',
        blocklist: (raw.blocklist || []).map(normaliseEntry).filter(e => e.value),
        allowlist: (raw.allowlist || []).map(normaliseEntry).filter(e => e.value),
      };
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

// -- Player history (24h at 5min intervals) --
const playerHistory = [];
const MAX_PLAYER_HISTORY = 288;

// -- Connected players cache --
let connectedPlayers = [];
let lastLogParse = 0;

// -- Recent players tracking --
const playerSnapshots = new Map(); // id → rich player data from live-status.json
const recentPlayers   = new Map(); // id → { ...playerData, lastSeen } — persists until manually deleted

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
  if (now - lastLogParse < 10000) return connectedPlayers;

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
        return online;
      }
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
  for (const [id, snapshot] of playerSnapshots) {
    if (!onlineIds.has(id)) {
      recentPlayers.set(id, { ...snapshot, lastSeen: Date.now() });
      playerSnapshots.delete(id);
    }
  }

  const bans       = loadBans();
  const bannedIds   = new Set(bans.map(b => b.id).filter(Boolean));
  const bannedNames = new Set(bans.map(b => b.name).filter(Boolean));
  const security   = loadSecurity();
  const nameIpMap  = loadNameIpMap();

  // Attach known IP to each online player
  const playersWithIp = players.map(p => ({
    ...p,
    knownIp: nameIpMap[p.name] || null,
  }));

  res.json({
    online: Math.max(online, players.length),
    max: 8,
    players: playersWithIp,
    recentPlayers:   Array.from(recentPlayers.values()).sort((a, b) => b.lastSeen - a.lastSeen),
    history:         playerHistory,
    bannedIds:       Array.from(bannedIds),
    bannedNames:     Array.from(bannedNames),
    separateWallets: _separateWallets,
    security,
    nameIpMap,
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

  // Best-effort: kick if player is currently online by that name
  if (entryType === 'name') sendConsoleCommand(`kick "${trimmed}"`);

  res.json({ success: true, security: sec });
}

function removeBlocklistEntry(req, res) {
  const val = decodeURIComponent(req.params.value);
  const sec = loadSecurity();
  sec.blocklist = sec.blocklist.filter(e => e.value !== val);
  saveSecurity(sec);
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
  res.json({ success: true, security: sec });
}

function removeAllowlistEntry(req, res) {
  const val = decodeURIComponent(req.params.value);
  const sec = loadSecurity();
  sec.allowlist = sec.allowlist.filter(e => e.value !== val);
  saveSecurity(sec);
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
  const map  = loadNameIpMap();
  delete map[name];
  saveNameIpMap(map);
  res.json({ success: true, nameIpMap: map });
}

// -- Admin command (host-targeted SMAPI commands) --

const ALLOWED_ADMIN_COMMANDS = new Set([
  'player_setmoney', 'player_sethealth', 'player_setmaxhealth',
  'player_setstamina', 'player_setmaxstamina', 'player_add',
  'world_settime', 'world_setday', 'world_setseason', 'world_setyear',
  'world_setweather', 'world_freezetime', 'hurry_all', 'world_clear', 'debug', 'kick',
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
};
