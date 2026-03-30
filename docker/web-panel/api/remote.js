/**
 * StardropHost | web-panel/api/remote.js
 * Generic remote tunnel management via docker-compose.override.yml.
 * Any service with a Docker Compose snippet can be configured here —
 * the YAML is written to the override file and started via the manager.
 */

const http = require('http');

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

module.exports = { getStatus, applyCompose, startService, stopService, removeService };
