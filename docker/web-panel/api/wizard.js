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
const config  = require('../server');
const auth    = require('../auth');

const WIZARD_STATE_FILE = path.join(config.DATA_DIR, 'wizard-state.json');

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

// -- Game file detection --

function detectGameFiles(gamePath) {
  const checkPath = gamePath || '/home/steam/stardewvalley';
  return fs.existsSync(path.join(checkPath, 'StardewValley'));
}

// -- Route Handlers --

function getWizardStatus(req, res) {
  const state       = readState();
  const gamePresent = detectGameFiles();
  const hasPassword = auth.isSetupComplete();

  // Wizard is needed if it was never completed OR if game files have gone missing.
  // This handles the case where the wizard was completed in a previous session
  // but the data/game/ directory was wiped (fresh install, clean setup, etc.).
  const needsWizard = !state.completed || !gamePresent;

  if (!needsWizard) {
    return res.json({ completed: true, needsWizard: false });
  }

  // If game files disappeared after a previous completion, reset the step
  // back to 2 (game files) so the user can re-provide them.
  if (state.completed && !gamePresent) {
    state.completed   = false;
    state.currentStep = 2;
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

// Step 1 — Admin password
function submitStep1(req, res) {
  const { password, confirmPassword } = req.body || {};

  if (!password || typeof password !== 'string') {
    return res.status(400).json({ error: 'Password is required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (password !== confirmPassword) {
    return res.status(400).json({ error: 'Passwords do not match' });
  }

  auth.setupPassword(password)
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

  if (!method || !['local', 'path', 'steam'].includes(method)) {
    return res.status(400).json({ error: 'Method must be one of: local, path, steam' });
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
    if (!fs.existsSync(path.join(gamePath, 'StardewValley'))) {
      return res.status(400).json({
        error: 'StardewValley binary not found at that path',
        hint:  'Make sure you are pointing to the root of your Stardew Valley installation',
      });
    }
    writeEnvValues({ GAME_PATH: gamePath });
  }

  if (method === 'steam') {
    // Steam download — credentials will be handled by the steam-auth container (Phase 4).
    // For now just flag it so entrypoint.sh knows to download.
    writeEnvValues({ STEAM_DOWNLOAD: 'true' });
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
  const { serverPassword, timezone, saveName } = req.body || {};

  const envUpdates = {};

  if (serverPassword && typeof serverPassword === 'string') {
    envUpdates.SERVER_PASSWORD = serverPassword;
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

// Reset wizard (dev/recovery use)
function resetWizard(req, res) {
  writeState(defaultState());
  res.json({ success: true, message: 'Wizard reset' });
}

module.exports = {
  getWizardStatus,
  submitStep1,
  submitStep2,
  submitStep3,
  submitStep4,
  submitStep5,
  resetWizard,
};