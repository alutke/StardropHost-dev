/**
 * StardropHost | web-panel/api/instances.js
 * Multi-instance peer registry
 *
 * GET  /api/instances          — public, no auth — returns self info + peer list
 * POST /api/instances/register — public, no auth — cross-instance announce (quick-start.sh)
 * POST /api/instances/peer     — authenticated  — add/update a peer from UI
 * DELETE /api/instances/peer/:idx — authenticated — remove a peer
 */

const fs   = require('fs');
const http = require('http');
const path = require('path');
const { execSync } = require('child_process');
const config = require('../server');
const { readRemoteActive } = require('./remote');

const CHAT_TS_FILE = path.join(config.DATA_DIR, 'chat-ts.json');

function readChatTs() {
  try { return JSON.parse(fs.readFileSync(CHAT_TS_FILE, 'utf-8')).ts || 0; } catch { return 0; }
}

function writeChatTs(req, res) {
  try {
    const ts = parseInt(req.body?.ts, 10) || Math.floor(Date.now() / 1000);
    fs.mkdirSync(path.dirname(CHAT_TS_FILE), { recursive: true });
    fs.writeFileSync(CHAT_TS_FILE, JSON.stringify({ ts }));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

function callManager(method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const url     = new URL(urlPath, config.MANAGER_URL);
    const options = {
      hostname: url.hostname, port: url.port || 80,
      path: url.pathname, method,
      headers: { 'Content-Type': 'application/json', ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}) },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Simple rate limit for the public /register endpoint — max 10 registrations per IP per minute
const _registerAttempts = new Map();
function registerRateLimit(req) {
  const ip  = req.ip || req.socket?.remoteAddress || 'unknown';
  const now  = Date.now();
  const entry = _registerAttempts.get(ip) || { count: 0, window: now };
  if (now - entry.window > 60000) { entry.count = 0; entry.window = now; }
  entry.count += 1;
  _registerAttempts.set(ip, entry);
  return entry.count > 10;
}

const PEERS_FILE = path.join(config.DATA_DIR, 'instances.json');

function loadPeers() {
  try {
    if (!fs.existsSync(PEERS_FILE)) return [];
    const peers = JSON.parse(fs.readFileSync(PEERS_FILE, 'utf-8'));
    // Deduplicate by port — keep last entry per port (most recently registered wins)
    const seen = new Map();
    for (const p of peers) seen.set(p.port, p);
    return Array.from(seen.values());
  } catch { return []; }
}

function savePeers(peers) {
  fs.mkdirSync(path.dirname(PEERS_FILE), { recursive: true });
  fs.writeFileSync(PEERS_FILE, JSON.stringify(peers, null, 2), 'utf-8');
}

function getLiveStatus() {
  try { return JSON.parse(fs.readFileSync(config.LIVE_FILE, 'utf-8')); } catch { return null; }
}

function getFarmName() {
  return getLiveStatus()?.farmName || '';
}

function getSelfHost() {
  try {
    const ips = execSync('hostname -I 2>/dev/null', { encoding: 'utf-8' })
      .trim().split(/\s+/).filter(ip => ip && ip !== '127.0.0.1');
    return ips[0] || '';
  } catch { return ''; }
}

// Detect whether this is running alongside other StardropHost instances.
// /host-parent maps to the parent directory of all instance dirs (e.g. ~/);
// if more than one stardrophost* directory exists there, we are multi-instance.
function detectMultiInstance() {
  try {
    const hostParent = '/host-parent';
    if (!fs.existsSync(hostParent)) return false;
    const entries = fs.readdirSync(hostParent, { withFileTypes: true });
    const count = entries.filter(e => e.isDirectory() && e.name.startsWith('stardrophost')).length;
    return count > 1;
  } catch { return false; }
}

// GET /api/instances — no auth, intentionally public for cross-instance discovery
function getInstances(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const live = getLiveStatus();
  res.json({
    self: {
      host:         getSelfHost(),
      port:         config.PORT,
      name:         live?.farmName || '',
      serverState:  live?.serverState || '',
      playerCount:  Array.isArray(live?.players) ? live.players.filter(p => !p.isHost).length : 0,
      remoteActive: readRemoteActive(),
      lastChatTs:   readChatTs(),
    },
    peers:           loadPeers().filter(p => p.port !== config.PORT),
    multiInstance:   detectMultiInstance(),
  });
}

// POST /api/instances/register — public, no auth — used by quick-start.sh and
// cross-instance announces to add themselves without needing a token
function registerPeer(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (registerRateLimit(req)) {
    return res.status(429).json({ error: 'Too many registration attempts' });
  }
  return addPeerInternal(req.body, res);
}

// POST /api/instances/peer — authenticated — add/update a peer from UI
function addPeer(req, res) {
  return addPeerInternal(req.body, res);
}

function addPeerInternal(body, res) {
  const { name, host, port, remoteAlias, remoteActive, autoDiscovered } = body || {};
  if (!host || !port) return res.status(400).json({ error: 'host and port required' });
  const peers = loadPeers();
  const p     = parseInt(port, 10);

  // All instances share the same machine — port is the unique identifier.
  // Deduplicate by port so a re-registration with a different IP (e.g.
  // container IP vs LAN IP) merges into the existing entry rather than
  // creating a duplicate card.
  const idx = peers.findIndex(i => i.port === p);
  if (idx >= 0) {
    peers[idx] = {
      ...peers[idx],
      name: name || peers[idx].name || host,
      host,
      port: p,
      ...(remoteAlias    !== undefined && { remoteAlias }),
      ...(remoteActive   !== undefined && { remoteActive: !!remoteActive }),
      ...(autoDiscovered !== undefined && { autoDiscovered: !!autoDiscovered }),
    };
  } else {
    peers.push({
      name: name || host, host, port: p,
      ...(remoteAlias    !== undefined && { remoteAlias }),
      ...(remoteActive   !== undefined && { remoteActive: !!remoteActive }),
      ...(autoDiscovered !== undefined && { autoDiscovered: !!autoDiscovered }),
    });
  }
  savePeers(peers);
  res.json({ success: true, peers });
}

// DELETE /api/instances/peer/:idx
function removePeer(req, res) {
  const idx  = parseInt(req.params.idx, 10);
  const peers = loadPeers();
  if (isNaN(idx) || idx < 0 || idx >= peers.length) {
    return res.status(404).json({ error: 'Not found' });
  }
  peers.splice(idx, 1);
  savePeers(peers);
  res.json({ success: true, peers });
}

// POST /api/install-instance — proxy to manager
async function startInstall(req, res) {
  try {
    const data = await callManager('POST', '/install-instance');
    res.status(data.error ? 409 : 202).json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
}

// GET /api/install-instance/log — proxy to manager
async function getInstallLog(req, res) {
  try {
    const data = await callManager('GET', '/install-instance/log');
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
}

module.exports = { getInstances, registerPeer, addPeer, removePeer, startInstall, getInstallLog, writeChatTs };
