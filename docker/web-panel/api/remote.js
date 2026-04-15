/**
 * StardropHost | web-panel/api/remote.js
 * Generic remote tunnel management via docker-compose.override.yml.
 * Any service with a Docker Compose snippet can be configured here —
 * the YAML is written to the override file and started via the manager.
 */

const fs   = require('fs');
const path = require('path');
const http = require('http');

const config    = require('../server');
const ADDR_FILE = path.join(config.DATA_DIR, 'remote-addresses.json');
const ACTIVE_FILE = path.join(config.DATA_DIR, 'remote-active.json');

function writeRemoteActive(active) {
  try {
    fs.mkdirSync(path.dirname(ACTIVE_FILE), { recursive: true });
    fs.writeFileSync(ACTIVE_FILE, JSON.stringify({ active: !!active }));
  } catch {}
}

function readRemoteActive() {
  try {
    return JSON.parse(fs.readFileSync(ACTIVE_FILE, 'utf-8')).active === true;
  } catch { return false; }
}

// Exported for instances.js to include in self object
module.exports.readRemoteActive = readRemoteActive;

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
    const secret  = process.env.MANAGER_SECRET || '';
    const options = {
      hostname: url.hostname,
      port:     url.port || 80,
      path:     url.pathname,
      method,
      headers:  { 'Content-Type': 'application/json', ...(secret ? { 'Authorization': `Bearer ${secret}` } : {}) },
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
    res.json({ ...body, remoteActive: readRemoteActive() });
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
    if (status < 300) writeRemoteActive(true);
    res.status(status).json(body);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

async function startService(req, res) {
  try {
    const { status, body } = await callManager('POST', '/remote/start');
    if (status < 300) writeRemoteActive(true);
    res.status(status).json(body);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

async function stopService(req, res) {
  try {
    const { status, body } = await callManager('POST', '/remote/stop');
    if (status < 300) writeRemoteActive(false);  // user explicitly stopped
    res.status(status).json(body);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

async function removeService(req, res) {
  try {
    const { status, body } = await callManager('POST', '/remote/remove');
    if (status < 300) writeRemoteActive(false);
    res.status(status).json(body);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// Called on panel startup to sync file state with manager (handles pre-existing config).
// Only overwrites remoteActive when the truth is certain: not configured → false,
// services actually running → true. If configured but not running, preserve the
// existing value so an explicit stop isn't forgotten across panel restarts.
async function syncRemoteActive() {
  try {
    const { body } = await callManager('GET', '/remote/status');
    if (!body.configured) {
      writeRemoteActive(false);
    } else if (body.anyRunning) {
      writeRemoteActive(true);
    }
    // configured + not running: leave the persisted remoteActive as-is
  } catch {}
}

module.exports = Object.assign(module.exports, {
  getStatus, applyCompose, startService, stopService, removeService,
  getAddresses, saveAddresses, syncRemoteActive,
});
