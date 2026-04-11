// ===========================================
// StardropHost | gog-downloader/server.js
// ===========================================
// Minimal HTTP wrapper around the gog-downloader PHP CLI.
// Mirrors the steam-auth sidecar pattern — restart: no,
// credentials are ephemeral (stored in /Configs only while
// this container runs, never mounted to host).
// ===========================================

'use strict';

const http     = require('http');
const { spawn, spawnSync } = require('child_process');
const fs       = require('fs');

const PORT      = parseInt(process.env.GOG_AUTH_PORT || '18701', 10);
const PHP_APP   = '/app/bin/app.php';
const LOG_FILE  = '/tmp/gog.log';
const DOWNLOADS = process.env.DOWNLOAD_DIRECTORY || '/Downloads';

// Stable GOG Galaxy OAuth endpoint — same URL the desktop client uses
const GOG_AUTH_URL =
  'https://auth.gog.com/auth?client_id=46899977096215655' +
  '&redirect_uri=https%3A%2F%2Fembed.gog.com%2Fon_login_success%3Forigin%3Dclient' +
  '&response_type=code&layout=client2';

// State machine: idle → logging-in → logged-in → downloading → done | error
let state     = 'idle';
let lastError = '';

// -- Helpers --

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function appendLog(text) {
  try { fs.appendFileSync(LOG_FILE, text + '\n'); } catch {}
}

// Run PHP CLI synchronously (login, games list)
function runPhpSync(args, timeoutMs = 30000) {
  return spawnSync('php', [PHP_APP, '--no-interaction', ...args], {
    encoding: 'utf-8',
    timeout:  timeoutMs,
  });
}

// Run PHP CLI async, piping stdout+stderr into the log file
function runPhpAsync(args) {
  const child = spawn('php', [PHP_APP, '--no-interaction', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', d => appendLog(d.toString()));
  child.stderr.on('data', d => appendLog(d.toString()));
  return child;
}

// After update, ask the local DB for the exact game title to use in --only
function resolveGameTitle() {
  const result = runPhpSync(['games'], 10000);
  if (result.status === 0 && result.stdout) {
    const line = result.stdout.split('\n').find(l => /stardew valley/i.test(l));
    if (line) return line.trim();
  }
  return 'Stardew Valley';
}

// -- Download sequence (runs async after /download is called) --

async function runDownload() {
  appendLog('[GOG] Updating metadata for Stardew Valley…');

  // Step 1 — refresh local metadata
  await new Promise(resolve => {
    const proc = runPhpAsync([
      'update', '--search', 'Stardew Valley',
      '--os', 'linux', '--language', 'en',
    ]);
    proc.on('close', resolve);
    proc.on('error', resolve);
  });

  // Step 2 — resolve exact game title from local DB
  const title = resolveGameTitle();
  appendLog(`[GOG] Resolved game title: "${title}"`);
  appendLog(`[GOG] Starting download to ${DOWNLOADS}…`);

  // Step 3 — download
  await new Promise(resolve => {
    const proc = runPhpAsync([
      'download',
      '--only', title,
      '--os', 'linux',
      '--language', 'en',
      '--language-fallback-english',
      DOWNLOADS,
    ]);
    proc.on('close', (code) => {
      if (code === 0) {
        state = 'done';
        appendLog('[GOG] ✅ Download complete.');
      } else {
        state = 'error';
        lastError = `Download process exited with code ${code}`;
        appendLog(`[GOG] ❌ ${lastError}`);
      }
      resolve();
    });
    proc.on('error', (err) => {
      state = 'error';
      lastError = err.message;
      appendLog(`[GOG] ❌ Process error: ${err.message}`);
      resolve();
    });
  });
}

// -- HTTP server --

const server = http.createServer(async (req, res) => {

  // GET /status
  if (req.method === 'GET' && req.url === '/status') {
    sendJson(res, 200, { state, lastError });
    return;
  }

  // GET /auth-url
  if (req.method === 'GET' && req.url === '/auth-url') {
    sendJson(res, 200, { url: GOG_AUTH_URL });
    return;
  }

  // POST /login  { redirectUrl: "https://embed.gog.com/on_login_success?..." }
  if (req.method === 'POST' && req.url === '/login') {
    if (state === 'downloading') {
      sendJson(res, 409, { error: 'Download already in progress' });
      return;
    }

    let body;
    try { body = await readBody(req); }
    catch { sendJson(res, 400, { error: 'Invalid JSON' }); return; }

    const { redirectUrl } = body;
    if (!redirectUrl || typeof redirectUrl !== 'string' || !redirectUrl.trim()) {
      sendJson(res, 400, { error: 'redirectUrl is required' });
      return;
    }

    state     = 'logging-in';
    lastError = '';

    // code-login accepts the redirect URL as a direct argument — non-interactive
    const result = runPhpSync(['code-login', redirectUrl.trim()], 30000);
    const output = ((result.stdout || '') + (result.stderr || '')).trim();

    if (result.status === 0 && /logged in successfully/i.test(output)) {
      state = 'logged-in';
      sendJson(res, 200, { success: true, message: 'Logged in to GOG successfully' });
    } else {
      // Strip any URLs from the error output before exposing it —
      // the redirect URL contains a one-time OAuth code we don't need to log.
      const sanitized = (output || 'Login failed — check the redirect URL and try again')
        .replace(/https?:\/\/\S+/gi, '[url]')
        .trim();
      state     = 'error';
      lastError = sanitized;
      sendJson(res, 400, { success: false, error: sanitized });
    }
    return;
  }

  // POST /download  — fire-and-forget; poll /log for progress
  if (req.method === 'POST' && req.url === '/download') {
    if (state !== 'logged-in') {
      sendJson(res, 400, { error: 'Must be logged in before downloading' });
      return;
    }
    if (state === 'downloading') {
      sendJson(res, 409, { error: 'Download already in progress' });
      return;
    }

    state     = 'downloading';
    lastError = '';
    try { fs.writeFileSync(LOG_FILE, ''); } catch {}

    // Respond immediately; download runs in background
    sendJson(res, 200, { success: true, message: 'Download started' });
    runDownload().catch(() => {});
    return;
  }

  // GET /log  — returns recent lines + current state
  if (req.method === 'GET' && req.url === '/log') {
    let lines = [];
    try {
      const content = fs.readFileSync(LOG_FILE, 'utf-8');
      lines = content.split('\n').filter(Boolean).slice(-300);
    } catch {}
    sendJson(res, 200, { lines, state, lastError });
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[StardropHost GOG] Listening on http://0.0.0.0:${PORT}`);
});
