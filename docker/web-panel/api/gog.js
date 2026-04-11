/**
 * StardropHost | web-panel/api/gog.js
 * Proxy to the gog-downloader container for GOG game download/update.
 * Mirrors the steam.js pattern — panel never touches credentials directly.
 */

'use strict';

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const config = require('../server');

const GOG_URL     = process.env.GOG_AUTH_URL || 'http://stardrop-gog-downloader:18701';
const MANAGER_URL = process.env.MANAGER_URL  || 'http://stardrop-manager:18700';
const CHECK_FILE  = path.join(config.DATA_DIR, 'game-update-available.json');

// Stable GOG Galaxy OAuth URL — returned without requiring the container
const GOG_AUTH_URL_VALUE =
  'https://auth.gog.com/auth?client_id=46899977096215655' +
  '&redirect_uri=https%3A%2F%2Fembed.gog.com%2Fon_login_success%3Forigin%3Dclient' +
  '&response_type=code&layout=client2';

// -- Internal helpers --

function callGog(method, apiPath, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const url     = new URL(apiPath, GOG_URL);
    const options = {
      hostname: url.hostname,
      port:     url.port || 80,
      path:     url.pathname,
      method,
      headers:  { 'Content-Type': 'application/json' },
      timeout:  35000,
    };
    if (payload) options.headers['Content-Length'] = Buffer.byteLength(payload);
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try   { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: { error: data } }); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('gog-downloader timeout')));
    req.on('error',   reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function callManager(apiPath, body = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const url     = new URL(apiPath, MANAGER_URL);
    const req     = http.request({
      hostname: url.hostname, port: url.port || 80, path: url.pathname,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout:  10000,
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try   { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: { error: data } }); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('manager timeout')));
    req.on('error',   reject);
    req.write(payload);
    req.end();
  });
}

// Fetch the current Steam build ID — used as a version oracle for GOG users
// after a successful download so future update checks have a baseline.
function fetchSteamBuildId() {
  return new Promise((resolve) => {
    const req = https.get(
      'https://api.steamcmd.net/v1/info/413150',
      { headers: { 'User-Agent': 'StardropHost/1.0' }, timeout: 12000 },
      (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve(json?.data?.['413150']?.appinfo?.depots?.branches?.public?.buildid || null);
          } catch { resolve(null); }
        });
      }
    );
    req.on('error',   () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// -- Route handlers --

// GET /api/gog/status
async function getStatus(req, res) {
  try {
    const { status, body } = await callGog('GET', '/status');
    res.status(status).json(body);
  } catch {
    res.json({ state: 'unavailable', lastError: 'GOG downloader service is not running' });
  }
}

// GET /api/gog/auth-url  — returns without requiring the container to be up
function getAuthUrl(req, res) {
  res.json({ url: GOG_AUTH_URL_VALUE });
}

// POST /api/gog/login  { redirectUrl }
async function login(req, res) {
  const { redirectUrl } = req.body || {};
  if (!redirectUrl || typeof redirectUrl !== 'string' || !redirectUrl.trim()) {
    return res.status(400).json({ error: 'redirectUrl is required' });
  }
  try {
    const { status, body } = await callGog('POST', '/login', { redirectUrl });
    res.status(status).json(body);
  } catch (e) {
    res.status(503).json({ error: 'GOG downloader service unavailable', details: e.message });
  }
}

// POST /api/gog/download
async function startDownload(req, res) {
  try {
    const { status, body } = await callGog('POST', '/download');
    res.status(status).json(body);
  } catch (e) {
    res.status(503).json({ error: 'GOG downloader service unavailable', details: e.message });
  }
}

// GET /api/gog/log
async function getLog(req, res) {
  try {
    const { status, body } = await callGog('GET', '/log');
    res.status(status).json(body);
  } catch {
    res.json({ lines: [], state: 'unavailable', lastError: '' });
  }
}

// POST /api/gog/record-version
// Called by the frontend after a successful GOG download.
// Fetches the current Steam build ID and stores it as the installed version
// so the daily game-update-check.sh can detect future updates via the Steam API.
async function recordVersion(req, res) {
  const buildId = await fetchSteamBuildId();
  if (!buildId) {
    return res.status(502).json({ error: 'Could not fetch version from Steam API — try again later' });
  }
  const result = {
    available:      false,
    installedBuild: buildId,
    latestBuild:    buildId,
    gogInstalled:   true,
    checkedAt:      new Date().toISOString(),
  };
  try { fs.writeFileSync(CHECK_FILE, JSON.stringify(result)); } catch {}
  res.json({ success: true, buildId });
}

// POST /api/gog/container/start
async function startContainer(req, res) {
  try {
    const { body } = await callManager('/start', { service: 'stardrop-gog-downloader' });
    res.json({ success: true, ...body });
  } catch (e) {
    res.status(503).json({ error: 'Manager unavailable', details: e.message });
  }
}

// POST /api/gog/container/stop
async function stopContainer(req, res) {
  try {
    const { body } = await callManager('/stop', { service: 'stardrop-gog-downloader' });
    res.json({ success: true, ...body });
  } catch (e) {
    res.status(503).json({ error: 'Manager unavailable', details: e.message });
  }
}

module.exports = {
  getStatus,
  getAuthUrl,
  login,
  startDownload,
  getLog,
  recordVersion,
  startContainer,
  stopContainer,
};
