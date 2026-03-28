/**
 * StardropHost | web-panel/api/remote.js
 * Remote play tunnel management (playit.gg).
 * The secret key is saved to disk and persists until the user explicitly removes it.
 * On panel startup, if a saved key exists the playit container is restored automatically.
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');

const MANAGER_URL = process.env.MANAGER_URL || 'http://stardrop-manager:18700';
const DATA_DIR    = process.env.PANEL_DATA_DIR || path.join(__dirname, '..', 'data');
const KEY_FILE    = path.join(DATA_DIR, 'playit-key.dat');

// -- Key persistence --

function loadSavedKey() {
  try {
    const key = fs.readFileSync(KEY_FILE, 'utf8').trim();
    return key || null;
  } catch {
    return null;
  }
}

function saveKey(key) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(KEY_FILE, key, { mode: 0o600 });
  } catch (e) {
    console.error('[Remote] Failed to save key:', e.message);
  }
}

function deleteKeyFile() {
  try { fs.unlinkSync(KEY_FILE); } catch {}
}

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
      timeout:  10000,
    };

    if (payload) {
      options.headers['Content-Length'] = Buffer.byteLength(payload);
    }

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

// -- Startup restore --
// If a key was saved previously, restart the playit container after a short
// delay to let the manager come up first.

const _savedKeyOnLoad = loadSavedKey();
if (_savedKeyOnLoad) {
  setTimeout(() => {
    callManager('POST', '/playit/start', { secretKey: _savedKeyOnLoad })
      .then(() => console.log('[Remote] Restored playit tunnel from saved key'))
      .catch(e => console.warn('[Remote] Could not restore playit tunnel:', e.message));
  }, 5000);
}

// -- Route Handlers --

async function getStatus(req, res) {
  const hasKey = !!loadSavedKey();
  try {
    const { body } = await callManager('GET', '/playit/status');
    res.json({ ...body, hasKey });
  } catch {
    res.json({ running: false, hasKey, error: 'Manager not reachable' });
  }
}

async function setKey(req, res) {
  const { secretKey } = req.body || {};

  if (!secretKey || typeof secretKey !== 'string' || !secretKey.trim()) {
    return res.status(400).json({ error: 'secretKey is required' });
  }

  const key = secretKey.trim();
  saveKey(key);

  try {
    const { status, body } = await callManager('POST', '/playit/start', { secretKey: key });
    res.status(status).json(body);
  } catch (e) {
    res.status(500).json({ error: `Failed to start playit: ${e.message}` });
  }
}

async function pauseTunnel(req, res) {
  // Stop the container but keep the saved key
  try {
    const { status, body } = await callManager('POST', '/playit/stop');
    res.status(status).json(body);
  } catch (e) {
    res.status(500).json({ error: `Failed to pause playit: ${e.message}` });
  }
}

async function resumeTunnel(req, res) {
  const key = loadSavedKey();
  if (!key) return res.status(400).json({ error: 'No saved key to resume with' });

  try {
    const { status, body } = await callManager('POST', '/playit/start', { secretKey: key });
    res.status(status).json(body);
  } catch (e) {
    res.status(500).json({ error: `Failed to resume playit: ${e.message}` });
  }
}

async function clearKey(req, res) {
  deleteKeyFile();

  try {
    const { status, body } = await callManager('POST', '/playit/stop');
    res.status(status).json(body);
  } catch (e) {
    res.status(500).json({ error: `Failed to stop playit: ${e.message}` });
  }
}

module.exports = { getStatus, setKey, pauseTunnel, resumeTunnel, clearKey };
