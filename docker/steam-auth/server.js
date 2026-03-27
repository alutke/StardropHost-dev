// steam-auth/server.js
/**
 * StardropHost | steam-auth/server.js
 * Lightweight Steam authentication service.
 * Handles login and Steam Guard only.
 * Session is memory-only — no credentials or tokens are written to disk.
 * Invite codes come from the game mod (live-status.json), not this service.
 */

const express   = require('express');
const SteamUser = require('steam-user');

const app  = express();
const PORT = parseInt(process.env.STEAM_AUTH_PORT || '18700', 10);

app.use(express.json());

// -- Session state (in-memory only) --
let client        = null;
let authState     = 'offline'; // offline | logging_in | guard_required | online | error
let lastError     = '';
let guardResolver = null;

// -- Create a fresh SteamUser client --
function createClient() {
  if (client) {
    try { client.logOff(); } catch {}
    client = null;
  }

  client = new SteamUser({ autoRelogin: false });

  client.on('loggedOn', () => {
    console.log('[steam-auth] Logged in to Steam');
    authState = 'online';
    lastError = '';
  });

  client.on('steamGuard', (domain, callback, lastCodeWrong) => {
    console.log(`[steam-auth] Steam Guard required (domain: ${domain || 'mobile'})`);
    authState     = 'guard_required';
    lastError     = lastCodeWrong ? 'Incorrect Steam Guard code' : '';
    guardResolver = callback;
  });

  client.on('error', (err) => {
    console.error('[steam-auth] Error:', err.message);
    authState = 'error';
    lastError = err.message;
  });

  client.on('disconnected', (eresult, msg) => {
    console.log(`[steam-auth] Disconnected: ${msg}`);
    if (authState === 'online') authState = 'offline';
  });

  return client;
}

// ===========================================
// API Routes
// ===========================================

// GET /status
app.get('/status', (req, res) => {
  res.json({
    state:    authState,
    loggedIn: authState === 'online',
    hasToken: false, // no token storage
    lastError,
  });
});

// POST /login  { username, password }
app.post('/login', (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  if (authState === 'online') {
    return res.json({ success: true, message: 'Already logged in', state: authState });
  }

  console.log(`[steam-auth] Login attempt for: ${username}`);
  authState = 'logging_in';
  lastError = '';

  createClient();
  client.logOn({ accountName: username, password });

  res.json({ success: true, message: 'Login initiated', state: authState });
});

// POST /guard  { code }
app.post('/guard', (req, res) => {
  const { code } = req.body || {};

  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: 'Steam Guard code is required' });
  }

  if (authState !== 'guard_required' || !guardResolver) {
    return res.status(400).json({ error: 'No Steam Guard prompt is active' });
  }

  console.log('[steam-auth] Submitting Steam Guard code...');
  authState = 'logging_in';
  lastError = '';

  const resolver = guardResolver;
  guardResolver  = null;
  resolver(code);

  res.json({ success: true, message: 'Steam Guard code submitted' });
});

// POST /logout
app.post('/logout', (req, res) => {
  if (client) {
    try { client.logOff(); } catch {}
    client = null;
  }

  authState = 'offline';
  lastError = '';

  console.log('[steam-auth] Logged out');
  res.json({ success: true, message: 'Logged out' });
});

// GET /steam/app-ticket  — encrypted app ticket for GOG Galaxy cross-platform auth
// Only works when logged in. Ticket is ephemeral — not stored anywhere.
app.get('/steam/app-ticket', (req, res) => {
  if (authState !== 'online' || !client) {
    return res.status(503).json({ error: 'Not logged in to Steam' });
  }

  client.getEncryptedAppTicket(413150, Buffer.alloc(0), (err, encrypted) => {
    if (err) {
      console.error('[steam-auth] App ticket error:', err.message);
      return res.status(500).json({ error: `Failed to get app ticket: ${err.message}` });
    }

    if (!encrypted || encrypted.length === 0) {
      return res.status(500).json({ error: 'Empty app ticket received' });
    }

    console.log(`[steam-auth] App ticket issued (${encrypted.length} bytes)`);
    res.json({
      app_ticket: encrypted.toString('base64'),
      steam_id:   client.steamID ? client.steamID.toString() : null,
    });
  });
});

// GET /health  — used by docker healthcheck
app.get('/health', (req, res) => {
  res.json({ ok: true });
});

// ===========================================
// Start
// ===========================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[steam-auth] ✅ Running on port ${PORT} (session is memory-only)`);
});
