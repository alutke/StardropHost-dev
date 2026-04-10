/**
 * StardropHost | web-panel/api/remote.js
 * Generic remote tunnel management via docker-compose.override.yml.
 * Any service with a Docker Compose snippet can be configured here —
 * the YAML is written to the override file and started via the manager.
 */

const fs   = require('fs');
const path = require('path');
const http = require('http');

const config       = require('../server');
const ADDR_FILE    = path.join(config.DATA_DIR, 'remote-addresses.json');
const PEERS_FILE   = path.join(config.DATA_DIR, 'instances.json');

function loadPeers() {
  try {
    if (!fs.existsSync(PEERS_FILE)) return [];
    return JSON.parse(fs.readFileSync(PEERS_FILE, 'utf-8'));
  } catch { return []; }
}

function readAddresses() {
  try {
    if (fs.existsSync(ADDR_FILE)) return JSON.parse(fs.readFileSync(ADDR_FILE, 'utf-8'));
  } catch {}
  return { game: '', dashboard: '' };
}

function writeAddresses(data) {
  const dir = path.dirname(ADDR_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(ADDR_FILE, JSON.stringify(data, null, 2));
}

function getAddresses(req, res) {
  res.json(readAddresses());
}

function saveAddresses(req, res) {
  try {
    const current = readAddresses();
    const updated = {
      game:      typeof req.body.game      === 'string' ? req.body.game.trim()      : current.game,
      dashboard: typeof req.body.dashboard === 'string' ? req.body.dashboard.trim() : current.dashboard,
    };
    writeAddresses(updated);
    res.json({ success: true, ...updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

const MANAGER_URL = process.env.MANAGER_URL || 'http://stardrop-manager:18700';

// -- Manager proxy --

function callManager(method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const url     = new URL(urlPath, MANAGER_URL);
    const options = {
      hostname: url.hostname,
      port:     url.port || 80,
      path:     url.pathname,
      method,
      headers:  { 'Content-Type': 'application/json' },
      timeout:  30000,
    };
    if (payload) options.headers['Content-Length'] = Buffer.byteLength(payload);

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try   { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: { error: data } }); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('manager timeout')));
    req.on('error',   reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// -- Route handlers --

async function getStatus(req, res) {
  try {
    const { body } = await callManager('GET', '/remote/status');
    res.json(body);
  } catch {
    res.json({ configured: false, services: [], error: 'Manager not reachable' });
  }
}

async function applyCompose(req, res) {
  const { yaml } = req.body || {};
  if (!yaml || typeof yaml !== 'string' || !yaml.trim()) {
    return res.status(400).json({ error: 'yaml is required' });
  }
  try {
    const { status, body } = await callManager('POST', '/remote/apply', { yaml: yaml.trim() });
    res.status(status).json(body);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

async function startService(req, res) {
  try {
    const { status, body } = await callManager('POST', '/remote/start');
    res.status(status).json(body);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

async function stopService(req, res) {
  try {
    const { status, body } = await callManager('POST', '/remote/stop');
    res.status(status).json(body);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

async function removeService(req, res) {
  try {
    const { status, body } = await callManager('POST', '/remote/remove');
    res.status(status).json(body);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// Public (no auth) — lets peer instances check if this instance has an active tunnel
async function getRunning(req, res) {
  try {
    const { body } = await callManager('GET', '/remote/status');
    res.json({ running: !!(body.configured && body.anyRunning) });
  } catch {
    res.json({ running: false });
  }
}

// Authenticated — checks all known peers for an active tunnel
async function getPeerStatus(req, res) {
  const peers = loadPeers();
  for (const peer of peers) {
    try {
      const data = await new Promise((resolve, reject) => {
        const r = http.request(
          { hostname: peer.host, port: peer.port, path: '/api/remote/running', method: 'GET', timeout: 3000 },
          (resp) => {
            let d = '';
            resp.on('data', c => { d += c; });
            resp.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(); } });
          }
        );
        r.on('error', reject);
        r.on('timeout', () => r.destroy());
        r.end();
      });
      if (data.running) return res.json({ running: true, peerName: peer.name || peer.host });
    } catch {}
  }
  res.json({ running: false });
}

module.exports = { getStatus, applyCompose, startService, stopService, removeService, getAddresses, saveAddresses, getRunning, getPeerStatus };
