/**
 * StardropHost | web-panel/api/wizard.js
 * First-run setup wizard
 *
 * Guides the user through:
 *   Step 1 — Admin password
 *   Step 2 — Game files (local path or Steam download)
 *   Step 3 — Resource limits (CPU, RAM)
 *   Step 4 — Server settings (name, password, player limit)
 *   Step 5 — Confirm and launch
 */

const fs   = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const config  = require('../server');
const auth    = require('../auth');

const WIZARD_STATE_FILE = path.join(config.DATA_DIR, 'wizard-state.json');

// -- Wizard-complete guard --
// These endpoints are intentionally unauthenticated during the wizard (no account exists yet).
// Once setup is done they must not remain open — gate them with this check.
function wizardCompleteGuard(req, res) {
  if (auth.isSetupComplete()) {
    res.status(403).json({ error: 'Wizard already completed' });
    return true;
  }
  return false;
}

// Allowed roots for file-system access via wizard endpoints
const WIZARD_ALLOWED_ROOTS = ['/host-parent', '/home/steam'];

function isUnderAllowedRoot(resolved) {
  return WIZARD_ALLOWED_ROOTS.some(r => resolved === r || resolved.startsWith(r + '/'));
}

// -- State helpers --

function defaultState() {
  return {
    completed:   false,
    currentStep: 1,
    steps: {
      1: { complete: false },  // Admin password
      2: { complete: false },  // Game files
      3: { complete: false },  // Resource limits
      4: { complete: false },  // Server settings
      5: { complete: false },  // Confirm
    },
  };
}

function readState() {
  try {
    if (fs.existsSync(WIZARD_STATE_FILE)) {
      return { ...defaultState(), ...JSON.parse(fs.readFileSync(WIZARD_STATE_FILE, 'utf-8')) };
    }
  } catch {}
  return defaultState();
}

function writeState(state) {
  try {
    const dir = path.dirname(WIZARD_STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(WIZARD_STATE_FILE, JSON.stringify({ ...defaultState(), ...state }, null, 2));
  } catch {}
}

// -- Env file writer (same pattern as config.js) --

function findEnvFile() {
  const candidates = [
    config.ENV_FILE,
    '/home/steam/web-panel/data/runtime.env',
    path.join(process.cwd(), '.env'),
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return config.ENV_FILE || '/home/steam/web-panel/data/runtime.env';
}

function writeEnvValues(envData) {
  const envPath = findEnvFile();
  const envDir  = path.dirname(envPath);

  if (!fs.existsSync(envDir)) fs.mkdirSync(envDir, { recursive: true });
  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, '# Managed by StardropHost web panel\n', 'utf-8');
  }

  const original    = fs.readFileSync(envPath, 'utf-8');
  const lines       = original.split('\n');
  const updatedKeys = new Set();

  const newLines = lines.map(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) return line;
    const key = trimmed.slice(0, eqIndex).trim();
    if (key in envData) {
      updatedKeys.add(key);
      return `${key}=${envData[key]}`;
    }
    return line;
  });

  for (const [key, value] of Object.entries(envData)) {
    if (!updatedKeys.has(key)) newLines.push(`${key}=${value}`);
  }

  fs.writeFileSync(envPath, newLines.join('\n'), 'utf-8');
}

// Read a single key from the runtime env file (used for status checks)
function readEnvKey(key) {
  try {
    const content = fs.readFileSync(findEnvFile(), 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 1) continue;
      if (trimmed.slice(0, eqIdx).trim() === key) return trimmed.slice(eqIdx + 1).trim();
    }
  } catch {}
  return '';
}

// -- Game file detection --

// Recursively find the directory containing the StardewValley binary (depth-limited).
function findGameDir(dir, depth = 0) {
  if (depth > 4) return null;
  try {
    if (fs.existsSync(path.join(dir, 'StardewValley'))) return dir;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const found = findGameDir(path.join(dir, e.name), depth + 1);
      if (found) return found;
    }
  } catch {}
  return null;
}

function detectGameFiles(gamePath) {
  const checkPath = gamePath || '/home/steam/stardewvalley';
  return !!findGameDir(checkPath);
}

// -- Route Handlers --

function detectSaves() {
  try {
    const savesDir = config.SAVES_DIR;
    return fs.existsSync(savesDir) &&
      fs.readdirSync(savesDir).some(f =>
        fs.statSync(path.join(savesDir, f)).isDirectory());
  } catch { return false; }
}

function getWizardStatus(req, res) {
  const state       = readState();
  const gamePresent = detectGameFiles();
  const hasPassword = auth.isSetupComplete();
  const savesExist  = detectSaves();

  // Wizard is needed if: never completed (and no saves to prove setup already ran), or game missing.
  // Saves existing is treated as proof the wizard ran, even if state file is missing/reset.
  const needsWizard = (!state.completed && !savesExist) || !gamePresent;

  if (!needsWizard) {
    return res.json({ completed: true, needsWizard: false });
  }

  // If game files are missing (regardless of completion state or current step),
  // reset to step 2 so the user can re-provide them. This handles:
  //   - Completed wizard but game volume was cleared
  //   - Previous run reached step 6 but game never fully downloaded
  if (!gamePresent && state.currentStep !== 2) {
    state.completed   = false;
    state.currentStep = 2;
    state.steps[2]    = { complete: false };
    writeState(state);
  }

  res.json({
    completed:    state.completed,
    needsWizard:  true,
    currentStep:  state.currentStep,
    steps:        state.steps,
    gamePresent,
    hasPassword,
  });
}

// Step 1 — Admin credentials
function submitStep1(req, res) {
  const { username, password, confirmPassword } = req.body || {};

  if (username !== undefined) {
    if (typeof username !== 'string' || username.trim().length < 3) {
      return res.status(400).json({ error: 'Username must be at least 3 characters' });
    }
    if (!/^[a-zA-Z0-9_.-]+$/.test(username.trim())) {
      return res.status(400).json({ error: 'Username may only contain letters, numbers, _ . -' });
    }
  }
  if (!password || typeof password !== 'string') {
    return res.status(400).json({ error: 'Password is required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (password !== confirmPassword) {
    return res.status(400).json({ error: 'Passwords do not match' });
  }

  auth.setupPassword(password, username ? username.trim() : undefined)
    .then(() => {
      const state = readState();
      state.steps[1].complete = true;
      state.currentStep = 2;
      writeState(state);
      res.json({ success: true, message: 'Admin password set', nextStep: 2 });
    })
    .catch((e) => {
      res.status(500).json({ error: 'Failed to save password', details: e.message });
    });
}

// Step 2 — Game files
function submitStep2(req, res) {
  const { method, gamePath } = req.body || {};

  if (!method || !['local', 'path', 'steam', 'gog'].includes(method)) {
    return res.status(400).json({ error: 'Method must be one of: local, path, steam, gog' });
  }

  if (method === 'local') {
    // Game files should already be in the volume mount
    if (!detectGameFiles()) {
      return res.status(400).json({
        error: 'Game files not found at /home/steam/stardewvalley',
        hint:  'Make sure your Stardew Valley folder is mounted at ./data/game/',
      });
    }
    // No env changes needed — local volume mount is handled by docker-compose
  }

  if (method === 'path') {
    if (!gamePath || typeof gamePath !== 'string') {
      return res.status(400).json({ error: 'gamePath is required for method=path' });
    }
    if (!fs.existsSync(gamePath)) {
      return res.status(400).json({ error: `Path not found: ${gamePath}` });
    }
    const actualGameDir = findGameDir(gamePath);
    if (!actualGameDir) {
      return res.status(400).json({
        error: 'StardewValley binary not found at that path or in its subdirectories',
      });
    }
    writeEnvValues({ GAME_PATH: actualGameDir });
  }

  if (method === 'gog') {
    // Record provider so the update path knows which container to use.
    // The actual download is driven by the frontend via /api/gog/* endpoints.
    writeEnvValues({ GAME_PROVIDER: 'gog' });
    const state = readState();
    state.steps[2].complete = true;
    state.steps[2].method   = 'gog';
    state.currentStep = 3;
    writeState(state);
    return res.json({ success: true, message: 'GOG download configured', nextStep: 3 });
  }

  if (method === 'steam') {
    const { steamUsername, steamPassword, steamGuardCode } = req.body || {};
    if (!steamUsername || typeof steamUsername !== 'string' || !steamUsername.trim()) {
      return res.status(400).json({ error: 'Steam username is required' });
    }
    if (!steamPassword || typeof steamPassword !== 'string') {
      return res.status(400).json({ error: 'Steam password is required' });
    }
    // Write credentials + flag to runtime.env — the entrypoint.sh waiting loop
    // re-reads this every 30s and runs steamcmd to download the game.
    const envUpdates = {
      GAME_PROVIDER:   'steam',
      STEAM_DOWNLOAD:  'true',
      STEAM_USERNAME:  steamUsername.trim(),
      STEAM_PASSWORD:  steamPassword,
    };
    if (steamGuardCode && typeof steamGuardCode === 'string' && steamGuardCode.trim()) {
      envUpdates.STEAM_GUARD_CODE = steamGuardCode.trim();
    }
    writeEnvValues(envUpdates);
    // Respond immediately — download is async via entrypoint waiting loop
    return res.json({ success: true, message: 'Credentials saved — download starting', nextStep: 3 });
  }

  const state = readState();
  state.steps[2].complete = true;
  state.steps[2].method   = method;
  state.currentStep = 3;
  writeState(state);

  res.json({ success: true, message: 'Game file method saved', nextStep: 3 });
}

// Step 3 — Resource limits
function submitStep3(req, res) {
  const { cpuLimit, memoryLimit } = req.body || {};

  const envUpdates = {};

  if (cpuLimit && typeof cpuLimit === 'string' && cpuLimit.trim()) {
    // Validate: must be a positive number (e.g. "2" or "2.5")
    const cpu = parseFloat(cpuLimit);
    if (isNaN(cpu) || cpu <= 0) {
      return res.status(400).json({ error: 'CPU limit must be a positive number (e.g. 2 or 2.5)' });
    }
    envUpdates.CPU_LIMIT = cpuLimit.trim();
  }

  if (memoryLimit && typeof memoryLimit === 'string' && memoryLimit.trim()) {
    // Validate: must match Docker memory format (e.g. 2g, 512m)
    if (!/^\d+(\.\d+)?[kmgKMG]$/i.test(memoryLimit.trim())) {
      return res.status(400).json({ error: 'Memory limit must be in Docker format (e.g. 2g, 512m)' });
    }
    envUpdates.MEMORY_LIMIT = memoryLimit.trim();
  }

  if (Object.keys(envUpdates).length > 0) {
    writeEnvValues(envUpdates);
  }

  const state = readState();
  state.steps[3].complete = true;
  state.currentStep = 4;
  writeState(state);

  res.json({ success: true, message: 'Resource limits saved', nextStep: 4 });
}

// Step 4 — Server settings
function submitStep4(req, res) {
  const { timezone, saveName, serverMode } = req.body || {};

  const envUpdates = {};

  if (serverMode === 'lan' || serverMode === 'steam') {
    envUpdates.SERVER_MODE = serverMode;
  }

  if (saveName && typeof saveName === 'string' && saveName.trim()) {
    envUpdates.SAVE_NAME = saveName.trim();
  }

  if (timezone && typeof timezone === 'string') {
    envUpdates.TZ = timezone;
  }

  if (Object.keys(envUpdates).length > 0) {
    writeEnvValues(envUpdates);
  }

  const state = readState();
  state.steps[4].complete = true;
  state.currentStep = 5;
  writeState(state);

  res.json({ success: true, message: 'Server settings saved', nextStep: 5 });
}

// Step 5 — Confirm and complete
function submitStep5(req, res) {
  const state = readState();

  // Check required steps are complete
  if (!state.steps[1].complete) {
    return res.status(400).json({ error: 'Step 1 (admin password) is not complete' });
  }
  if (!state.steps[2].complete) {
    return res.status(400).json({ error: 'Step 2 (game files) is not complete' });
  }

  state.steps[5].complete = true;
  state.completed          = true;
  state.completedAt        = new Date().toISOString();
  writeState(state);

  res.json({
    success:  true,
    message:  'Setup complete! The server will start momentarily.',
    completed: true,
  });
}

// New farm setup — writes new-farm.json consumed by StardropGameManager SMAPI mod
function submitNewFarm(req, res) {
  const body = req.body || {};

  // ── Farm type ──
  const ft = parseInt(body.farmType ?? '0', 10);
  if (isNaN(ft) || ft < 0 || ft > 6) {
    return res.status(400).json({ error: 'farmType must be 0–6' });
  }

  // ── Cabin count (1–16; 9–16 is experimental) ──
  const cc = parseInt(body.cabinCount ?? '1', 10);
  if (isNaN(cc) || cc < 1 || cc > 16) {
    return res.status(400).json({ error: 'cabinCount must be 1–16' });
  }

  // ── Pet breed ──
  const petBreed = Math.min(Math.max(parseInt(body.petBreed ?? '0', 10) || 0, 0), 4);

  // ── Random seed (optional, must be a non-negative integer if supplied) ──
  let randomSeed = null;
  if (body.randomSeed !== null && body.randomSeed !== undefined && body.randomSeed !== '') {
    const seed = parseInt(body.randomSeed, 10);
    if (isNaN(seed) || seed < 0) {
      return res.status(400).json({ error: 'randomSeed must be a non-negative integer' });
    }
    randomSeed = seed;
  }

  const farmConfig = {
    // Identity
    FarmName:     (body.farmName    || 'Stardrop Farm').trim(),
    FarmerName:   (body.farmerName  || 'Host').trim(),
    FavoriteThing:(body.favoriteThing || 'Farming').trim(),

    // Farm layout
    FarmType:     ft,
    CabinCount:   cc,
    CabinLayout:  body.cabinLayout === 'nearby' ? 'nearby' : 'separate',

    // Economy
    MoneyStyle:   body.moneyStyle === 'separate' ? 'separate' : 'shared',
    ProfitMargin: ['75%','50%','25%'].includes(body.profitMargin) ? body.profitMargin : 'normal',

    // World generation
    CommunityCenterBundles:   body.communityCenterBundles === 'remixed' ? 'remixed' : 'normal',
    GuaranteeYear1Completable: body.guaranteeYear1Completable === true || body.guaranteeYear1Completable === 'true',
    MineRewards:  body.mineRewards === 'remixed' ? 'remixed' : 'normal',
    SpawnMonstersAtNight: body.spawnMonstersAtNight === true || body.spawnMonstersAtNight === 'true',
    ...(randomSeed !== null && { RandomSeed: randomSeed }),

    // Pet
    AcceptPet:    body.acceptPet !== false && body.acceptPet !== 'false',
    PetSpecies:   body.petSpecies === 'dog' ? 'dog' : 'cat',
    PetBreed:     petBreed,
    PetName:      (body.petName || 'Stella').trim(),

    // Cave & advanced
    MushroomsOrBats:         body.mushroomsOrBats === 'bats' ? 'bats' : 'mushrooms',
    PurchaseJojaMembership:  body.purchaseJojaMembership === true || body.purchaseJojaMembership === 'true',
    MoveBuildPermission:     ['owned','on'].includes(body.moveBuildPermission) ? body.moveBuildPermission : 'off',

    createdAt: new Date().toISOString(),
  };

  try {
    const configPath = path.join(config.DATA_DIR, 'new-farm.json');
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(farmConfig, null, 2));
  } catch (e) {
    return res.status(500).json({ error: 'Failed to save farm config', details: e.message });
  }

  // Write playerLimit to startup_preferences (immediate effect) and to env (survives game resetting it on each run)
  // playerLimit = cabins + 1 (host counts as one slot)
  const playerLimit = cc + 1;
  const cropSaverEnabled = body.cropSaverEnabled === true || body.cropSaverEnabled === 'true';
  writeEnvValues({ PLAYER_LIMIT: String(playerLimit), CROP_SAVER_ENABLED: String(cropSaverEnabled) });
  try {
    const prefsPath = path.join(config.CONFIG_DIR, 'startup_preferences');
    if (fs.existsSync(prefsPath)) {
      let prefs = fs.readFileSync(prefsPath, 'utf-8');
      if (prefs.includes('<playerLimit>')) {
        prefs = prefs.replace(/<playerLimit>[^<]*<\/playerLimit>/, `<playerLimit>${playerLimit}</playerLimit>`);
      } else {
        prefs = prefs.replace('</StartupPreferences>', `  <playerLimit>${playerLimit}</playerLimit>\n</StartupPreferences>`);
      }
      fs.writeFileSync(prefsPath, prefs, 'utf-8');
    }
  } catch {}

  res.json({ success: true, message: 'Farm configuration saved', farmConfig });
}

// Select existing save
function selectExistingSave(req, res) {
  const { saveName } = req.body || {};
  if (!saveName || typeof saveName !== 'string') {
    return res.status(400).json({ error: 'saveName is required' });
  }
  const savesDir = config.SAVES_DIR || '/home/steam/.config/StardewValley/Saves';
  if (!fs.existsSync(path.join(savesDir, saveName))) {
    return res.status(400).json({ error: `Save not found: ${saveName}` });
  }
  writeEnvValues({ SAVE_NAME: saveName });
  res.json({ success: true, message: `Save '${saveName}' selected`, saveName });
}

// List existing saves
function listSaves(req, res) {
  const savesDir = config.SAVES_DIR || '/home/steam/.config/StardewValley/Saves';
  try {
    if (!fs.existsSync(savesDir)) return res.json({ saves: [] });
    const saves = fs.readdirSync(savesDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name);
    res.json({ saves });
  } catch { res.json({ saves: [] }); }
}

// Poll whether the game is loaded and hosting (wizard step 5)
function getGameReadyStatus(req, res) {
  if (wizardCompleteGuard(req, res)) return;
  const { spawnSync } = require('child_process');

  function pgrepRunning(pattern) {
    try { return spawnSync('pgrep', ['-f', pattern], { encoding: 'utf-8' }).status === 0; } catch { return false; }
  }

  const smapi = config.SMAPI_LOG || '/home/steam/.config/StardewValley/ErrorLogs/SMAPI-latest.txt';
  let loaded = false;
  let hosting = false;
  let smapiLogExists = false;
  try {
    if (fs.existsSync(smapi)) {
      smapiLogExists = true;
      const content = fs.readFileSync(smapi, 'utf-8');
      loaded  = /SAVE LOADED SUCCESSFULLY|Context: loaded save|Server ready for connections/i.test(content);
      hosting = /Starting LAN server|Auto [Mm]ode [Oo]n/i.test(content);
    }
  } catch {}

  const gameRunning    = pgrepRunning('StardewModdingAPI');
  const steamRunning   = pgrepRunning('steamcmd');
  const gameFilesExist = fs.existsSync('/home/steam/stardewvalley/StardewValley');
  const smapiInstalled = fs.existsSync('/home/steam/stardewvalley/StardewModdingAPI');

  // Determine stage
  const pendingGamePath = !gameFilesExist ? readEnvKey('GAME_PATH') : '';
  let stage = 'waiting';
  if      (steamRunning)                             stage = 'downloading';
  else if (!gameFilesExist && pendingGamePath)       stage = 'copying';
  else if (!gameFilesExist)                          stage = 'no_game_files';
  else if (!smapiInstalled)                          stage = 'installing';
  else if (!gameRunning)                             stage = 'starting';
  else if (gameRunning && !smapiLogExists)           stage = 'loading';
  else if (gameRunning && !loaded)                   stage = 'running';
  else if (gameRunning && loaded && !hosting)        stage = 'hosting';
  else if (hosting)                                  stage = 'ready';

  res.json({ gameRunning, saveLoaded: loaded, hosting, ready: loaded && hosting, stage, smapiInstalled, gameFilesExist });
}

// SMAPI log tail for wizard step 7 — no auth required (runs before dashboard login)
function getWizardSmapiLog(req, res) {
  if (wizardCompleteGuard(req, res)) return;
  const smapi = config.SMAPI_LOG || '/home/steam/.config/StardewValley/ErrorLogs/SMAPI-latest.txt';
  const lines = Math.min(parseInt(req.query.lines || '150', 10), 400);

  if (!fs.existsSync(smapi)) {
    return res.json({ lines: [], exists: false });
  }

  try {
    const content  = fs.readFileSync(smapi, 'utf-8');
    const allLines = content.split('\n').filter(l => l.trim());
    const result   = allLines.slice(-lines).map(line => ({
      text:  line,
      level: /\bERROR\b/i.test(line) ? 'error'
           : /\bWARN\b/i.test(line)  ? 'warn'
           : /\bTRACE\b/i.test(line) ? 'trace'
           : 'info',
    }));
    res.json({ lines: result, total: allLines.length, exists: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to read SMAPI log', details: e.message });
  }
}

// Reset wizard (dev/recovery use)
function forceComplete(_req, res) {
  const state = readState();
  state.completed   = true;
  state.completedAt = new Date().toISOString();
  writeState(state);
  res.json({ success: true });
}

function resetWizard(req, res) {
  writeState(defaultState());
  res.json({ success: true, message: 'Wizard reset' });
}

function factoryReset(_req, res) {
  try {
    // 1. Kill the running game so it restarts clean (no stale in-memory state)
    spawnSync('pkill', ['-f', 'StardewModdingAPI'], { encoding: 'utf-8' });

    // 2. Delete all save folders
    const savesDir = config.SAVES_DIR;
    if (fs.existsSync(savesDir)) {
      for (const entry of fs.readdirSync(savesDir, { withFileTypes: true })) {
        fs.rmSync(path.join(savesDir, entry.name), { recursive: true, force: true });
      }
    }

    // 3. Delete stale runtime files
    const filesToDelete = [
      path.join(config.CONFIG_DIR || '/home/steam/.config/StardewValley', 'startup_preferences'),
      config.LIVE_FILE,
      path.join(config.DATA_DIR, 'new-farm.json'),
    ];
    for (const f of filesToDelete) {
      try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch {}
    }

    // 4. Clear SAVE_NAME from runtime.env so game doesn't look for a deleted save
    try {
      const envPath = findEnvFile();
      if (fs.existsSync(envPath)) {
        const updated = fs.readFileSync(envPath, 'utf-8')
          .split('\n')
          .filter(l => !l.startsWith('SAVE_NAME='))
          .join('\n');
        fs.writeFileSync(envPath, updated, 'utf-8');
      }
    } catch {}

    // 5. Reset wizard state — skip step 2 if game files are already present
    const freshState = defaultState();
    if (detectGameFiles()) {
      freshState.steps[2].complete = true;
      freshState.steps[2].method   = 'local';
      freshState.currentStep       = 3;
    }
    writeState(freshState);

    // 6. Restart the game process
    //    If crash-monitor is running it restarts SMAPI automatically (~10s).
    //    If not, start it directly after a short delay to let the kill settle.
    const crashMonitorRunning =
      spawnSync('pgrep', ['-f', 'crash-monitor'], { encoding: 'utf-8' }).status === 0;

    if (!crashMonitorRunning) {
      setTimeout(() => {
        try {
          spawn('bash', ['-c', 'cd /home/steam/stardewvalley && ./StardewModdingAPI --server &'], {
            detached: true,
            stdio: 'ignore',
          }).unref();
        } catch {}
      }, 3000);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: `Failed to reset: ${err.message}` });
  }
}

// Scan /host-parent for sibling stardrophost install directories that contain game files
function scanInstalls(req, res) {
  if (wizardCompleteGuard(req, res)) return;
  const hostParent = '/host-parent';
  const results = [];
  if (!fs.existsSync(hostParent)) return res.json({ installs: [], available: false });

  // Get the inode of the current instance's game dir so we can skip it
  let currentGameIno = null;
  try { currentGameIno = fs.statSync('/home/steam/stardewvalley').ino; } catch {}

  try {
    for (const entry of fs.readdirSync(hostParent, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('stardrophost')) continue;
      const installDir = path.join(hostParent, entry.name);
      const gameDir    = findGameDir(installDir);
      if (!gameDir) continue;

      // Skip the current instance (same mount as /home/steam/stardewvalley)
      if (currentGameIno) {
        try { if (fs.statSync(gameDir).ino === currentGameIno) continue; } catch {}
      }

      const displayPath = path.join('~', entry.name, path.relative(installDir, gameDir));
      results.push({ name: entry.name, gamePath: gameDir, displayPath, hasGame: true });
    }
  } catch {}

  res.json({ installs: results, available: true });
}

// Browse a directory on the server (restricted to /host-parent and /home/steam)
function browseDir(req, res) {
  if (wizardCompleteGuard(req, res)) return;
  const reqPath  = req.query.path || '/host-parent';
  const resolved = path.resolve(reqPath);

  if (!isUnderAllowedRoot(resolved)) {
    return res.status(403).json({ error: 'Path not allowed' });
  }
  if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'Path not found' });

  const entries = [];
  try {
    for (const e of fs.readdirSync(resolved, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith('.')) entries.push({ name: e.name });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
  } catch {}

  const hasGame = !!findGameDir(resolved);
  const parent  = resolved === '/host-parent' ? null
    : ALLOWED.some(a => path.dirname(resolved) === a || path.dirname(resolved).startsWith(a + '/'))
      ? path.dirname(resolved)
      : null;

  res.json({ path: resolved, parent, entries, hasGame });
}

// Scan sibling stardrophost installs for Stardew Valley saves
function scanInstanceSaves(req, res) {
  if (wizardCompleteGuard(req, res)) return;
  const hostParent = '/host-parent';
  if (!fs.existsSync(hostParent)) return res.json({ saves: [], available: false });

  let currentSavesIno = null;
  try { currentSavesIno = fs.statSync('/home/steam/.config/StardewValley').ino; } catch {}

  const results = [];

  function findSavesIn(dir, instanceName, depth) {
    if (depth > 3 || !fs.existsSync(dir)) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (fs.existsSync(path.join(full, 'SaveGameInfo'))) {
        results.push({ saveName: e.name, savePath: full, instanceName });
      } else if (depth < 2) {
        findSavesIn(full, instanceName, depth + 1);
      }
    }
  }

  try {
    for (const entry of fs.readdirSync(hostParent, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('stardrophost')) continue;
      const savesDir = path.join(hostParent, entry.name, 'data', 'saves');
      if (currentSavesIno) {
        try { if (fs.statSync(savesDir).ino === currentSavesIno) continue; } catch {}
      }
      findSavesIn(savesDir, entry.name, 0);
    }
  } catch {}

  res.json({ saves: results, available: true });
}

// Scan a server directory for Stardew Valley save folders
function scanSaveImport(req, res) {
  if (wizardCompleteGuard(req, res)) return;
  const dir = req.query.dir;
  if (!dir || typeof dir !== 'string') return res.status(400).json({ error: 'dir required' });

  const resolved = path.resolve(dir);
  if (!isUnderAllowedRoot(resolved)) {
    return res.status(403).json({ error: 'Directory not allowed' });
  }

  const saves = [];
  function scan(d, depth) {
    if (depth > 3 || !fs.existsSync(d)) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(d, e.name);
      if (fs.existsSync(path.join(full, 'SaveGameInfo'))) {
        saves.push({ name: e.name, path: full });
      } else if (depth < 2) {
        scan(full, depth + 1);
      }
    }
  }
  scan(resolved, 0);
  res.json({ saves });
}

// Copy a save from a server path into the saves directory
function importSave(req, res) {
  if (wizardCompleteGuard(req, res)) return;
  const { savePath, saveName } = req.body || {};
  if (!savePath || !saveName) return res.status(400).json({ error: 'savePath and saveName required' });

  // savePath must be under an allowed root — prevents copying arbitrary container paths
  const resolvedSrc = path.resolve(savePath);
  if (!isUnderAllowedRoot(resolvedSrc)) {
    return res.status(403).json({ error: 'Source path not allowed' });
  }

  // saveName must not traverse out of the saves directory
  const cleanName = path.basename(saveName);
  if (!cleanName || cleanName !== saveName) {
    return res.status(400).json({ error: 'Invalid save name' });
  }

  const dest = path.join(config.SAVES_DIR, cleanName);
  try {
    if (!fs.existsSync(config.SAVES_DIR)) fs.mkdirSync(config.SAVES_DIR, { recursive: true });
    fs.cpSync(resolvedSrc, dest, { recursive: true });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  getWizardStatus,
  scanInstalls,
  browseDir,
  scanInstanceSaves,
  submitStep1,
  submitStep2,
  submitStep3,
  submitStep4,
  submitStep5,
  submitNewFarm,
  selectExistingSave,
  listSaves,
  getGameReadyStatus,
  getWizardSmapiLog,
  forceComplete,
  scanSaveImport,
  importSave,
  resetWizard,
  factoryReset,
};