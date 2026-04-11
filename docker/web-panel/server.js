/**
 * StardropHost | web-panel/server.js
 * Main web panel server entry point
 */

const express = require('express');
const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const { WebSocketServer } = require('ws');
const auth = require('./auth');

// -- Configuration --
const PORT = parseInt(process.env.PANEL_PORT || '18642', 10);

const DATA_DIR    = process.env.PANEL_DATA_DIR || path.join(__dirname, 'data');
const STATUS_FILE = process.env.STATUS_FILE    || '/home/steam/.local/share/stardrop/status.json';
const LIVE_FILE   = process.env.LIVE_FILE      || '/home/steam/.local/share/stardrop/live-status.json';
const LOG_DIR     = process.env.LOG_DIR        || '/home/steam/.local/share/stardrop/logs';
const SAVES_DIR   = process.env.SAVES_DIR      || '/home/steam/.config/StardewValley/Saves';
const BACKUPS_DIR = process.env.BACKUPS_DIR    || '/home/steam/.local/share/stardrop/backups';
const GAME_DIR    = process.env.GAME_DIR       || '/home/steam/stardewvalley';
const CONFIG_DIR  = process.env.CONFIG_DIR     || '/home/steam/.config/StardewValley';
const SMAPI_LOG   = process.env.SMAPI_LOG      || '/home/steam/.config/StardewValley/ErrorLogs/SMAPI-latest.txt';
const ENV_FILE    = process.env.ENV_FILE       || '/home/steam/web-panel/data/runtime.env';
const MANAGER_URL = process.env.MANAGER_URL    || 'http://stardrop-manager:18700';

const config = {
  PORT,
  DATA_DIR,
  STATUS_FILE,
  LIVE_FILE,
  LOG_DIR,
  SAVES_DIR,
  BACKUPS_DIR,
  GAME_DIR,
  CONFIG_DIR,
  SMAPI_LOG,
  ENV_FILE,
  MANAGER_URL,
};
module.exports = config;

// -- Express app --
const app = express();

const server = http.createServer(app);

app.use(express.json({ limit: '75mb' }));
app.use(express.urlencoded({ extended: false, limit: '75mb' }));

// ─── Routes ──────────────────────────────────────────────────────

// -- Auth (no token required) --
app.get( '/api/auth/status',   auth.getStatus);
app.post('/api/auth/setup',    auth.setup);
app.post('/api/auth/login',    auth.login);
app.get( '/api/auth/verify',            auth.verifyMiddleware, auth.verify);
app.post('/api/auth/password',          auth.verifyMiddleware, auth.changePassword);
app.post('/api/auth/verify-password',   auth.verifyMiddleware, auth.verifyPassword);

// -- Status --
const statusAPI = require('./api/status');
app.get( '/api/status',              auth.verifyMiddleware, statusAPI.getStatus);

// -- Server control --
app.post('/api/server/start',        auth.verifyMiddleware, statusAPI.startServer);
app.post('/api/server/stop',         auth.verifyMiddleware, statusAPI.stopServer);
app.post('/api/server/restart',      auth.verifyMiddleware, statusAPI.restartServer);
app.post('/api/server/update',       auth.verifyMiddleware, statusAPI.updateServer);
app.post('/api/container/restart',   auth.verifyMiddleware, statusAPI.restartContainer);
app.get( '/api/server/health',       auth.verifyMiddleware, statusAPI.healthCheck);
app.get( '/api/server/update-status',auth.verifyMiddleware, statusAPI.getUpdateStatus);
app.post('/api/server/cancel-update',auth.verifyMiddleware, statusAPI.cancelUpdate);

// -- Logs --
const logsAPI = require('./api/logs');
app.get('/api/logs',                 auth.verifyMiddleware, logsAPI.getLogs);
app.get('/api/logs/errors',          auth.verifyMiddleware, logsAPI.getErrors);
app.get('/api/logs/server',          auth.verifyMiddleware, logsAPI.getServerLogs);
app.get('/api/logs/mods',            auth.verifyMiddleware, logsAPI.getModLogs);
app.get('/api/logs/game',            auth.verifyMiddleware, logsAPI.getGameLogs);
app.get('/api/logs/setup',           logsAPI.getSetupLog);  // no auth — needed during wizard
app.get('/api/logs/docker',          auth.verifyMiddleware, logsAPI.getDockerLogs);

// -- Players --
const playersAPI = require('./api/players');
app.get( '/api/players',             auth.verifyMiddleware, playersAPI.getPlayers);
app.post('/api/players/kick',        auth.verifyMiddleware, playersAPI.kickPlayer);
app.post('/api/players/ban',         auth.verifyMiddleware, playersAPI.banPlayer);
app.post('/api/players/unban',       auth.verifyMiddleware, playersAPI.unbanPlayer);
app.post('/api/players/admin',       auth.verifyMiddleware, playersAPI.grantAdmin);
app.post('/api/players/recent/delete',  auth.verifyMiddleware, playersAPI.deleteRecentPlayer);
app.get( '/api/players/security',              auth.verifyMiddleware, playersAPI.getSecurity);
app.put( '/api/players/security/mode',         auth.verifyMiddleware, playersAPI.setSecurityMode);
app.get( '/api/players/blocklist',             auth.verifyMiddleware, playersAPI.getBlocklist);
app.post('/api/players/blocklist',             auth.verifyMiddleware, playersAPI.addBlocklistEntry);
app.delete('/api/players/blocklist/:value',    auth.verifyMiddleware, playersAPI.removeBlocklistEntry);
app.get( '/api/players/allowlist',             auth.verifyMiddleware, playersAPI.getSecurity);
app.post('/api/players/allowlist',             auth.verifyMiddleware, playersAPI.addAllowlistEntry);
app.delete('/api/players/allowlist/:value',    auth.verifyMiddleware, playersAPI.removeAllowlistEntry);
app.get( '/api/players/name-ip-map',           auth.verifyMiddleware, playersAPI.getNameIpMap);
app.put( '/api/players/name-ip-map/:name',     auth.verifyMiddleware, playersAPI.updateNameIpEntry);
app.delete('/api/players/name-ip-map/:name',   auth.verifyMiddleware, playersAPI.deleteNameIpEntry);
app.get(   '/api/players/ip-locks',            auth.verifyMiddleware, playersAPI.getIpLocks);
app.post(  '/api/players/ip-locks',            auth.verifyMiddleware, playersAPI.addIpLock);
app.delete('/api/players/ip-locks/:name',      auth.verifyMiddleware, playersAPI.removeIpLock);
app.post('/api/players/admin-command',         auth.verifyMiddleware, playersAPI.adminCommand);
app.get( '/api/players/farmhands',        auth.verifyMiddleware, playersAPI.getFarmhands);
app.post('/api/players/farmhands/delete',   auth.verifyMiddleware, playersAPI.deleteFarmhand);
app.post('/api/players/farmhands/upgrade', auth.verifyMiddleware, playersAPI.upgradeCabin);

// -- Saves --
const savesAPI = require('./api/saves');
app.get(   '/api/saves',                      auth.verifyMiddleware, savesAPI.getSaves);
app.post(  '/api/saves/select',               auth.verifyMiddleware, savesAPI.selectSave);
app.post(  '/api/saves/upload',               auth.verifyMiddleware, savesAPI.uploadSave);
app.get(   '/api/saves/backups',                      auth.verifyMiddleware, savesAPI.getBackups);
app.post(  '/api/saves/backups',                      auth.verifyMiddleware, savesAPI.createBackup);
app.post(  '/api/saves/backups/upload',               auth.verifyMiddleware, savesAPI.uploadBackup);
app.get(   '/api/saves/backups/status',               auth.verifyMiddleware, savesAPI.getBackupStatus);
app.post(  '/api/saves/backups/:filename/restore',    auth.verifyMiddleware, savesAPI.restoreBackup);
app.get(   '/api/saves/backups/:filename',            auth.verifyMiddleware, savesAPI.downloadBackup);
app.delete('/api/saves/backups/:filename',            auth.verifyMiddleware, savesAPI.deleteBackup);
app.delete('/api/saves/:name',               auth.verifyMiddleware, savesAPI.deleteSave);

// -- Config --
const configAPI = require('./api/config');
app.get('/api/config',               auth.verifyMiddleware, configAPI.getConfig);
app.put('/api/config',               auth.verifyMiddleware, configAPI.updateConfig);

// -- Mods --
const modsAPI = require('./api/mods');
app.get(   '/api/mods',              auth.verifyMiddleware, modsAPI.getMods);
app.post(  '/api/mods/upload',       auth.verifyMiddleware, modsAPI.uploadMod);
app.delete('/api/mods/:folder',      auth.verifyMiddleware, modsAPI.deleteMod);

// -- VNC --
const vncAPI = require('./api/vnc');
app.get( '/api/vnc/status',          auth.verifyMiddleware, vncAPI.getVncStatus);
app.post('/api/vnc/enable',          auth.verifyMiddleware, vncAPI.enableVnc);
app.post('/api/vnc/disable',         auth.verifyMiddleware, vncAPI.disableVnc);
app.post('/api/vnc/password',        auth.verifyMiddleware, vncAPI.setOneTimePassword);
app.post('/api/vnc/connected',       vncAPI.notifyConnected);  // internal — called by vnc-monitor.sh, no token

// -- Farm overview --
const farmAPI = require('./api/farm');
app.get('/api/farm/overview',        auth.verifyMiddleware, farmAPI.getFarmOverview);
app.get('/api/farm/live',            auth.verifyMiddleware, farmAPI.getLiveStatus);
app.post('/api/farm/name',           auth.verifyMiddleware, farmAPI.setFarmName);

// -- Game update (Steam) --
const gameUpdateAPI = require('./api/game-update');
app.get( '/api/game-update/status', auth.verifyMiddleware, gameUpdateAPI.getStatus);
app.post('/api/game-update/check',  auth.verifyMiddleware, gameUpdateAPI.checkNow);
app.post('/api/game-update/start',  auth.verifyMiddleware, gameUpdateAPI.startUpdate);
app.post('/api/game-update/guard',  auth.verifyMiddleware, gameUpdateAPI.submitGuard);

// -- Game update (GOG) --
const gogAPI = require('./api/gog');
app.get( '/api/gog/status',           auth.verifyMiddleware, gogAPI.getStatus);
app.get( '/api/gog/auth-url',         auth.verifyMiddleware, gogAPI.getAuthUrl);
app.post('/api/gog/login',            auth.verifyMiddleware, gogAPI.login);
app.post('/api/gog/download',         auth.verifyMiddleware, gogAPI.startDownload);
app.get( '/api/gog/log',              auth.verifyMiddleware, gogAPI.getLog);
app.post('/api/gog/record-version',   auth.verifyMiddleware, gogAPI.recordVersion);
app.post('/api/gog/container/start',  auth.verifyMiddleware, gogAPI.startContainer);
app.post('/api/gog/container/stop',   auth.verifyMiddleware, gogAPI.stopContainer);

// -- Panel update --
const panelUpdateAPI = require('./api/panel-update');
app.get( '/api/panel-update/status', auth.verifyMiddleware, panelUpdateAPI.getStatus);
app.post('/api/panel-update/check',  auth.verifyMiddleware, panelUpdateAPI.checkNow);

// -- Chat bridge --
const chatAPI = require('./api/chat');
app.get(   '/api/chat/messages',  auth.verifyMiddleware, chatAPI.getMessages);
app.post(  '/api/chat/send',      auth.verifyMiddleware, chatAPI.sendMessage);
app.delete('/api/chat/messages',  auth.verifyMiddleware, chatAPI.clearMessages);
app.get(   '/api/chat/download',  auth.verifyMiddleware, chatAPI.downloadMessages);

// -- Instances (multi-instance peer registry) --
const instancesAPI = require('./api/instances');
app.get(   '/api/instances',           instancesAPI.getInstances);   // no auth — public discovery
app.post(  '/api/instances/register',  instancesAPI.registerPeer);   // no auth — cross-instance announce
app.post(  '/api/instances/peer',      auth.verifyMiddleware, instancesAPI.addPeer);
app.post(  '/api/instances/chat-ts',   auth.verifyMiddleware, instancesAPI.writeChatTs);
app.delete('/api/instances/peer/:idx', auth.verifyMiddleware, instancesAPI.removePeer);
app.post(  '/api/install-instance',      auth.verifyMiddleware, instancesAPI.startInstall);
app.get(   '/api/install-instance/log',  auth.verifyMiddleware, instancesAPI.getInstallLog);

// -- Remote (tunnel service management via compose override) --
const remoteAPI = require('./api/remote');
app.get( '/api/remote/status',      auth.verifyMiddleware, remoteAPI.getStatus);
app.post('/api/remote/apply',       auth.verifyMiddleware, remoteAPI.applyCompose);
app.post('/api/remote/start',       auth.verifyMiddleware, remoteAPI.startService);
app.post('/api/remote/stop',        auth.verifyMiddleware, remoteAPI.stopService);
app.post('/api/remote/remove',      auth.verifyMiddleware, remoteAPI.removeService);
app.get( '/api/remote/addresses',   auth.verifyMiddleware, remoteAPI.getAddresses);
app.post('/api/remote/addresses',   auth.verifyMiddleware, remoteAPI.saveAddresses);

// -- Steam (auth via steam-auth container for game download only) --
const steamAPI = require('./api/steam');
app.get( '/api/steam/status',           auth.verifyMiddleware, steamAPI.getStatus);
app.post('/api/steam/login',           auth.verifyMiddleware, steamAPI.login);
app.post('/api/steam/guard',           auth.verifyMiddleware, steamAPI.submitGuardCode);
app.post('/api/steam/logout',          auth.verifyMiddleware, steamAPI.logout);
app.post('/api/steam/container/start', auth.verifyMiddleware, steamAPI.startContainer);
app.post('/api/steam/container/stop',  auth.verifyMiddleware, steamAPI.stopContainer);

// -- Setup wizard (no token on status so the frontend can decide whether to show it) --
const wizardAPI = require('./api/wizard');
app.get( '/api/wizard/status',       wizardAPI.getWizardStatus);
app.post('/api/wizard/step/1',       wizardAPI.submitStep1);
app.post('/api/wizard/step/2',       wizardAPI.submitStep2);
app.post('/api/wizard/step/3',       wizardAPI.submitStep3);
app.post('/api/wizard/step/4',       wizardAPI.submitStep4);
app.post('/api/wizard/step/5',       wizardAPI.submitStep5);
app.post('/api/wizard/new-farm',     wizardAPI.submitNewFarm);
app.post('/api/wizard/select-save',  wizardAPI.selectExistingSave);
app.get( '/api/wizard/saves',        wizardAPI.listSaves);
app.get( '/api/wizard/game-ready',   wizardAPI.getGameReadyStatus);
app.get( '/api/wizard/smapi-log',    wizardAPI.getWizardSmapiLog);  // no auth — needed during wizard step 7
app.post('/api/wizard/force-complete', auth.verifyMiddleware, wizardAPI.forceComplete);
app.post('/api/wizard/reset',         auth.verifyMiddleware, wizardAPI.resetWizard);
app.post('/api/wizard/factory-reset', auth.verifyMiddleware, wizardAPI.factoryReset);
app.get( '/api/wizard/scan-saves',    wizardAPI.scanSaveImport);
app.post('/api/wizard/import-save',   wizardAPI.importSave);
app.get( '/api/wizard/scan-installs',      wizardAPI.scanInstalls);
app.get( '/api/wizard/browse-dir',         wizardAPI.browseDir);
app.get( '/api/wizard/scan-instance-saves', wizardAPI.scanInstanceSaves);

// -- Static files --
app.use(express.static(path.join(__dirname, 'public')));

// SPA fallback
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── WebSocket ────────────────────────────────────────────────────

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url   = new URL(req.url, `http://localhost:${PORT}`);
  const token = url.searchParams.get('token');

  if (!token || !auth.verifyToken(token)) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  console.log('[WebSocket] Client connected');

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      handleWebSocketMessage(ws, msg);
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
    }
  });

  ws.on('close', () => {
    console.log('[WebSocket] Client disconnected');
    if (ws._logWatcher) { ws._logWatcher.close(); ws._logWatcher = null; }
    const terminal = require('./api/terminal');
    terminal.closeTerminal();
  });
});

function handleWebSocketMessage(ws, msg) {
  switch (msg.type) {

    case 'subscribe':
      if (msg.channel === 'logs') {
        logsAPI.subscribeLogs(ws, msg.filter || 'all');
      } else if (msg.channel === 'status') {
        statusAPI.subscribeStatus(ws);
      }
      break;

    case 'unsubscribe':
      if (ws._logWatcher) { ws._logWatcher.close(); ws._logWatcher = null; }
      break;

    case 'terminal:open':
      require('./api/terminal').openTerminal(ws);
      break;

    case 'terminal:input':
      require('./api/terminal').handleInput(ws, msg.data);
      break;

    case 'terminal:close':
      require('./api/terminal').closeTerminal();
      break;

    default:
      ws.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${msg.type}` }));
  }
}

// ─── Global error handler — returns JSON for body-too-large and other Express errors ───
app.use((err, req, res, _next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'File too large — maximum upload size is 50MB' });
  }
  console.error('[StardropHost] Unhandled error:', err.message);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ─── Start ────────────────────────────────────────────────────────

async function start() {
  await auth.initialize(DATA_DIR);

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[StardropHost] ✅ Web panel running on http://0.0.0.0:${PORT}`);
  });

  panelUpdateAPI.startBackgroundCheck();

  // Sync remote-active.json with manager on startup — handles the case where
  // remote was already configured before this feature existed.
  setTimeout(() => remoteAPI.syncRemoteActive(), 3000);
}

start().catch((err) => {
  console.error('[StardropHost] Failed to start web panel:', err);
  process.exit(1);
});