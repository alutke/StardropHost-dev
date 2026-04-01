/**
 * StardropHost | web-panel/public/js/app.js
 * Main application — navigation, WebSocket, all page logic
 */

// ─── Auth Check ──────────────────────────────────────────────────
(function authCheck() {
  if (!API.token) { window.location.href = '/login.html'; return; }
  API.get('/api/auth/verify').then(data => {
    if (!data || !data.valid) { window.location.href = '/login.html'; return; }
    const loader = document.getElementById('app-loader');
    if (loader) loader.classList.add('hidden');
    // Check wizard before showing main app
    API.get('/api/wizard/status').then(wiz => {
      if (wiz && wiz.needsWizard) {
        showWizard(wiz);
      } else {
        _checkSteamAuthOrInit();
      }
    }).catch(() => { _checkSteamAuthOrInit(); });
  }).catch(() => { window.location.href = '/login.html'; });
})();

// ─── Timezone Picker ─────────────────────────────────────────────
// Builds a search-as-you-type timezone picker inside `containerId`.
// The selected IANA timezone value is readable via tzPickerValue(containerId).

function tzPickerValue(containerId) {
  const el = document.getElementById(containerId);
  return el?.querySelector('input[data-tz-value]')?.dataset.tzValue || '';
}

function buildTzPicker(containerId, initialValue) {
  const container = document.getElementById(containerId);
  if (!container) return;

  // Get all IANA timezone IDs available in this browser
  const zones = (() => {
    try { return Intl.supportedValuesOf('timeZone'); } catch { return []; }
  })();

  // Compute UTC offset string for a timezone
  function getOffset(tz) {
    try {
      const parts = new Intl.DateTimeFormat('en', { timeZone: tz, timeZoneName: 'shortOffset' })
        .formatToParts(new Date());
      return parts.find(p => p.type === 'timeZoneName')?.value || 'UTC';
    } catch { return ''; }
  }

  // Build options array once (lazy, on first search)
  let _opts = null;
  function getOpts() {
    if (_opts) return _opts;
    _opts = zones.map(tz => {
      const off = getOffset(tz);
      return { value: tz, off, search: (tz + ' ' + off).toLowerCase().replace(/[/_]/g, ' ') };
    });
    return _opts;
  }

  const inputId  = `${containerId}-search`;
  const dropId   = `${containerId}-drop`;
  const hiddenId = `${containerId}-val`;

  const displayValue = initialValue
    ? `${initialValue} (${getOffset(initialValue)})`
    : '';

  container.innerHTML = `
    <input class="input" id="${inputId}" type="text" autocomplete="off"
      placeholder="Search timezone (e.g. Melbourne, UTC+10)"
      value="${escapeHtml(displayValue)}" style="width:100%">
    <input type="hidden" id="${hiddenId}" data-tz-value="${escapeHtml(initialValue || '')}"
      value="${escapeHtml(initialValue || '')}">
    <div class="tz-dropdown" id="${dropId}" style="display:none"></div>
  `;

  const searchEl  = document.getElementById(inputId);
  const hiddenEl  = document.getElementById(hiddenId);
  const dropEl    = document.getElementById(dropId);
  let activeIdx   = -1;

  function showDropdown(results) {
    if (!results.length) { dropEl.style.display = 'none'; return; }
    dropEl.innerHTML = results.slice(0, 50).map((r, i) =>
      `<div class="tz-option" data-i="${i}" data-val="${escapeHtml(r.value)}">
         <span class="tz-option-tz">${escapeHtml(r.value)}</span>
         <span class="tz-option-off">${escapeHtml(r.off)}</span>
       </div>`
    ).join('');
    dropEl.style.display = '';
    activeIdx = -1;
    dropEl.querySelectorAll('.tz-option').forEach(opt => {
      opt.onmousedown = e => { e.preventDefault(); selectTz(opt.dataset.val); };
    });
  }

  function selectTz(val) {
    const off = getOffset(val);
    searchEl.value        = val ? `${val} (${off})` : '';
    hiddenEl.value        = val;
    hiddenEl.dataset.tzValue = val;
    dropEl.style.display  = 'none';
    activeIdx             = -1;
  }

  searchEl.addEventListener('input', () => {
    const q = searchEl.value.trim().toLowerCase();
    hiddenEl.value = '';
    hiddenEl.dataset.tzValue = '';
    if (!q) { dropEl.style.display = 'none'; return; }
    const results = getOpts().filter(o => o.search.includes(q));
    showDropdown(results);
  });

  searchEl.addEventListener('keydown', e => {
    const opts = dropEl.querySelectorAll('.tz-option');
    if (!opts.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIdx = Math.min(activeIdx + 1, opts.length - 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIdx = Math.max(activeIdx - 1, 0);
    } else if (e.key === 'Enter' && activeIdx >= 0) {
      e.preventDefault();
      selectTz(opts[activeIdx].dataset.val);
      return;
    } else if (e.key === 'Escape') {
      dropEl.style.display = 'none'; return;
    }
    opts.forEach((o, i) => o.classList.toggle('active', i === activeIdx));
    if (activeIdx >= 0) opts[activeIdx].scrollIntoView({ block: 'nearest' });
  });

  searchEl.addEventListener('blur', () => {
    setTimeout(() => { dropEl.style.display = 'none'; }, 150);
  });

  // If initial value passed, pre-select it
  if (initialValue) selectTz(initialValue);
}

// ─── Setup Wizard ────────────────────────────────────────────────
let _wizState = {};

function showWizard(status) {
  _wizState = status;
  document.getElementById('wizard-overlay').style.display = 'block';
  // Populate the game path hint
  const gpEl = document.getElementById('wiz-game-path');
  if (gpEl) gpEl.textContent = '/home/stardew-server/stardrophost/data/game/';
  // Map backend step to UI step (new step 3 is download progress; backend 3→UI 4, 4→5, 5→6)
  const bs = status.currentStep || 2;
  let uiStep = bs <= 2 ? 2 : bs + 1; // backend 3→UI 4, backend 4→UI 5, backend 5→UI 6
  if (uiStep < 2) uiStep = 2;
  wizGoToStep(uiStep);
}

function wizGoToStep(n) {
  document.querySelectorAll('.wiz-step').forEach(el => el.style.display = 'none');
  const step = document.getElementById(`wiz-step-${n}`);
  if (step) step.style.display = 'block';
  // Update dots (steps 2-7 → dots 0-5)
  document.querySelectorAll('.wiz-dot').forEach((dot, i) => {
    const dotStep = i + 2;
    dot.classList.toggle('done',   dotStep < n);
    dot.classList.toggle('active', dotStep === n);
  });
  _wizState.currentStep = n;

  // Step 2: auto-scan on entry
  if (n === 2) wizInitStep2();

  // Step 5: build timezone picker
  if (n === 5) {
    if (!document.getElementById('wiz-tz-picker-search')) {
      buildTzPicker('wiz-tz-picker', Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
    }
  }
}

function wizSetMethod(method) {
  document.querySelectorAll('.wiz-method-btn').forEach(b => b.classList.toggle('active', b.dataset.method === method));
  document.getElementById('wiz-method-local').style.display = method === 'local' ? 'block' : 'none';
  document.getElementById('wiz-method-steam').style.display = method === 'steam' ? 'block' : 'none';
  _wizState._method = method;
  // Steam: hide the Continue row entirely — download button auto-advances
  // Local/path: show Continue row, enable once files are verified
  const continueRow = document.getElementById('wiz-step2-continue-row');
  if (continueRow) continueRow.style.display = method === 'steam' ? 'none' : '';
  const nextBtn = document.getElementById('wiz-step2-next');
  if (nextBtn) nextBtn.disabled = !_wizState._filesFound;
    if (method === 'local') wizScanInstalls();
}

// Called on step 2 entry — auto-shows the local tab and triggers scan
function wizInitStep2() {
  const choiceDiv = document.getElementById('wiz-method-choice');
  if (choiceDiv) choiceDiv.style.display = 'block';
  wizSetMethod('local');
}

// Auto-scan /host-parent for sibling stardrophost installs with game files
async function wizScanInstalls() {
  const loadingEl = document.getElementById('wiz-scan-loading');
  const listEl    = document.getElementById('wiz-scan-list');
  if (!loadingEl || !listEl) return;

  loadingEl.textContent = 'Scanning for existing StardropHost installs…';
  loadingEl.style.display = 'block';
  listEl.style.display = 'none';

  let data;
  try { data = await API.get('/api/wizard/scan-installs'); } catch { data = null; }

  if (!data?.available) {
    loadingEl.textContent = 'No existing StardropHost installs found on this server.';
    return;
  }

  const found = (data.installs || []).filter(i => i.hasGame);
  if (found.length === 0) {
    loadingEl.textContent = 'No existing StardropHost game installs found on this server.';
    return;
  }

  loadingEl.style.display = 'none';
  listEl.style.display = 'block';
  listEl.innerHTML = `
    <p style="font-size:13px;color:var(--text-secondary);margin:0 0 8px">Found game files in existing installs:</p>
    ${found.map((i, idx) => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:var(--bg-tertiary);border-radius:6px;margin-bottom:6px">
        <div>
          <div style="font-size:13px;font-weight:500">${escapeHtml(i.name)}</div>
          <div style="font-size:11px;color:var(--text-muted);font-family:monospace">${escapeHtml(i.displayPath)}</div>
        </div>
        <button id="wiz-use-btn-${idx}" class="btn btn-secondary" style="font-size:12px;padding:4px 12px"
          data-path="${escapeHtml(i.gamePath)}"
          onclick="wizUseGamePath(this.dataset.path, ${idx})">Use This</button>
      </div>
    `).join('')}
  `;
}

// Register a game path via the wizard step 2 API
async function wizUseGamePath(gamePath, btnIdx) {
  const statusEl = document.getElementById('wiz-scan-status');
  const btn = btnIdx !== undefined ? document.getElementById(`wiz-use-btn-${btnIdx}`) : null;
  if (statusEl) { statusEl.style.color = 'var(--text-secondary)'; statusEl.textContent = 'Registering…'; }
  try {
    const data = await API.post('/api/wizard/step/2', { method: 'path', gamePath });
    if (data?.success) {
      if (btn) { btn.textContent = '✓ Selected'; btn.disabled = true; btn.style.borderColor = 'var(--accent)'; btn.style.color = 'var(--accent)'; }
      if (statusEl) { statusEl.style.color = 'var(--accent)'; statusEl.textContent = '✅ Game files registered — click Continue.'; }
      _wizState._filesFound = true;
      _wizState._method = 'path';
      document.getElementById('wiz-step2-next').disabled = false;
    } else {
      if (statusEl) { statusEl.style.color = 'var(--accent-error)'; statusEl.textContent = '❌ ' + (data?.error || 'Game files not found at that path.'); }
    }
  } catch (e) {
    if (statusEl) { statusEl.style.color = 'var(--accent-error)'; statusEl.textContent = '❌ ' + (e.message || 'Request failed.'); }
  }
}

// ─── Directory browser ─────────────────────────────────────────────
let _dirBrowserPath    = '';
let _dirBrowserHasGame = false;

function wizOpenDirBrowser() {
  const modal = document.getElementById('dir-browser-modal');
  modal.style.display = 'flex';
  wizBrowseDirLoad('/host-parent');
}

function closeDirBrowser() {
  document.getElementById('dir-browser-modal').style.display = 'none';
}

async function wizBrowseDirLoad(p) {
  const listEl  = document.getElementById('dir-browser-list');
  const pathEl  = document.getElementById('dir-browser-path');
  const badge   = document.getElementById('dir-browser-badge');
  const selBtn  = document.getElementById('dir-browser-select-btn');

  listEl.innerHTML = '<div style="padding:12px;color:var(--text-muted);font-size:13px">Loading…</div>';

  let data;
  try {
    data = await API.get(`/api/wizard/browse-dir?path=${encodeURIComponent(p)}`);
  } catch (e) {
    listEl.innerHTML = `<div style="padding:12px;color:var(--accent-error);font-size:13px">${escapeHtml(e.message || 'Failed to load directory')}</div>`;
    return;
  }

  _dirBrowserPath    = data.path;
  _dirBrowserHasGame = data.hasGame;

  pathEl.textContent = data.path.replace('/host-parent', '~');
  badge.style.display  = data.hasGame ? 'block' : 'none';
  selBtn.disabled      = !data.hasGame;

  const rows = [];
  if (data.parent) {
    rows.push(`<div data-path="${escapeHtml(data.parent)}" onclick="wizBrowseDirLoad(this.dataset.path)"
      style="padding:8px 12px;cursor:pointer;border-radius:4px;display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-secondary)"
      onmouseover="this.style.background='var(--bg-overlay)'" onmouseout="this.style.background=''">
      <span>↑</span><span>.. (parent directory)</span>
    </div>`);
  }
  for (const e of data.entries) {
    const full = data.path + '/' + e.name;
    rows.push(`<div data-path="${escapeHtml(full)}" onclick="wizBrowseDirLoad(this.dataset.path)"
      style="padding:8px 12px;cursor:pointer;border-radius:4px;display:flex;align-items:center;gap:8px;font-size:13px"
      onmouseover="this.style.background='var(--bg-overlay)'" onmouseout="this.style.background=''">
      <span>📁</span><span>${escapeHtml(e.name)}</span>
    </div>`);
  }

  listEl.innerHTML = rows.length ? rows.join('') : '<div style="padding:12px;color:var(--text-muted);font-size:13px">No subdirectories</div>';
}

async function selectFromDirBrowser() {
  if (!_dirBrowserHasGame) return;
  closeDirBrowser();
  await wizUseGamePath(_dirBrowserPath);
}

let _steamAuthPollTimer = null;
let _steamDlPollTimer   = null;
let _steamDlLogLines    = 0;

// Step A — initiate Steam login via steam-auth sidecar (this triggers the Guard email)
async function wizSteamLogin() {
  const user     = document.getElementById('wiz-steam-user')?.value?.trim();
  const pass     = document.getElementById('wiz-steam-pass')?.value?.trim();
  const statusEl = document.getElementById('wiz-steam-status');
  const loginBtn = document.getElementById('wiz-steam-login-btn');

  if (!user || !pass) {
    statusEl.style.color = 'var(--accent-error)';
    statusEl.textContent = 'Enter your Steam username and password.';
    return;
  }

  // Store credentials in memory only — never written to disk here
  _wizState._steamUser = user;
  _wizState._steamPass = pass;

  loginBtn.disabled = true;
  loginBtn.textContent = 'Connecting to Steam…';
  statusEl.style.color = 'var(--text-secondary)';
  statusEl.textContent = 'Connecting to Steam…';

  try {
    const data = await API.post('/api/steam/login', { username: user, password: pass });
    if (data?.success) {
      statusEl.style.color = '';
      statusEl.textContent = 'Logging in… waiting for Steam Guard if required.';
      clearInterval(_steamAuthPollTimer);
      _steamAuthPollTimer = setInterval(wizPollSteamAuth, 3000);
    } else {
      loginBtn.disabled = false;
      loginBtn.textContent = 'Login to Steam';
      statusEl.style.color = 'var(--accent-error)';
      statusEl.textContent = data?.error || 'Login failed — try again.';
    }
  } catch (e) {
    loginBtn.disabled = false;
    loginBtn.textContent = 'Login to Steam';
    statusEl.style.color = 'var(--accent-error)';
    statusEl.textContent = e.message || 'Could not reach Steam auth service — is it running?';
  }
}

// Step B — poll steam-auth status every 3s (mirrors the original working flow)
// IMPORTANT: polling is NEVER stopped on guard_required — it keeps running so that
// when the user submits the code and steam-auth transitions to 'online', the poll
// detects it automatically without needing a manual interval restart.
async function wizPollSteamAuth() {
  const statusEl = document.getElementById('wiz-steam-status');
  const guardRow = document.getElementById('wiz-steam-guard-row');
  const loginBtn = document.getElementById('wiz-steam-login-btn');

  try {
    const data = await API.get('/api/steam/status');
    if (!data) return;

    if (data.state === 'guard_required') {
      // Show guard row — keep polling so we detect 'online' after code is submitted
      guardRow.style.display = '';
      document.getElementById('wiz-steam-guard').focus();
      statusEl.style.color = 'var(--accent-warning,#f59e0b)';
      statusEl.textContent = data.lastError
        ? '⚠️ ' + data.lastError + ' — try again.'
        : '📧 A Steam Guard code has been sent to your email — enter it above and click Submit Code.';

    } else if (data.state === 'online') {
      clearInterval(_steamAuthPollTimer);
      _steamAuthPollTimer = null;
      guardRow.style.display = 'none';
      statusEl.style.color = 'var(--accent)';
      statusEl.textContent = '✅ Steam authenticated — starting game download…';
      _wizState._method = 'steam';
      wizTriggerSteamDownload();

    } else if (data.state === 'error') {
      clearInterval(_steamAuthPollTimer);
      _steamAuthPollTimer = null;
      loginBtn.disabled = false;
      loginBtn.textContent = 'Login to Steam';
      statusEl.style.color = 'var(--accent-error)';
      statusEl.textContent = data.lastError || '❌ Steam login error — try again.';

    } else if (data.state === 'unavailable') {
      clearInterval(_steamAuthPollTimer);
      _steamAuthPollTimer = null;
      loginBtn.disabled = false;
      loginBtn.textContent = 'Login to Steam';
      statusEl.style.color = 'var(--accent-error)';
      statusEl.textContent = '❌ Steam auth service unavailable — check container logs.';
    }
    // state === 'logging_in' → keep polling, no UI change needed
  } catch {}
}

// Step C — submit the Guard code to steam-auth
// The polling interval is still running — it will detect 'online' automatically.
async function wizSubmitSteamGuard() {
  const code     = document.getElementById('wiz-steam-guard')?.value?.trim();
  const statusEl = document.getElementById('wiz-steam-status');
  const guardBtn = document.getElementById('wiz-steam-guard-btn');

  if (!code) {
    statusEl.style.color = 'var(--accent-error)';
    statusEl.textContent = 'Enter the code from your email.';
    return;
  }

  guardBtn.disabled = true;
  guardBtn.textContent = 'Verifying…';
  statusEl.style.color = 'var(--text-secondary)';
  statusEl.textContent = 'Submitting Steam Guard code…';

  try {
    await API.post('/api/steam/guard', { code });
    statusEl.style.color = 'var(--text-secondary)';
    statusEl.textContent = 'Code submitted — waiting for Steam confirmation…';
  } catch (e) {
    statusEl.style.color = 'var(--accent-error)';
    statusEl.textContent = e.message || 'Failed to submit code — try again.';
  } finally {
    guardBtn.disabled = false;
    guardBtn.textContent = 'Submit Code';
  }
}

// Step D — credentials verified; write to runtime.env to kick off steamcmd, then advance
async function wizTriggerSteamDownload() {
  const statusEl = document.getElementById('wiz-steam-status');

  try {
    const body = {
      method:        'steam',
      steamUsername: _wizState._steamUser,
      steamPassword: _wizState._steamPass,
    };

    const data = await API.post('/api/wizard/step/2', body);
    if (data?.success) {
      _wizState._method     = 'steam';
      _wizState._filesFound = true;
      statusEl.style.color  = 'var(--accent)';
      statusEl.textContent  = '✅ Steam code accepted — starting game download…';
      // Advance to step 3 (download progress screen) and begin polling
      _steamDlLogLines = 0;
      setTimeout(() => { wizGoToStep(3); wizPollDownloadProgress(); }, 1200);
    } else {
      statusEl.style.color = 'var(--accent-error)';
      statusEl.textContent = data?.error || 'Failed to start download.';
    }
  } catch (e) {
    statusEl.style.color = 'var(--accent-error)';
    statusEl.textContent = e.message || 'Failed to start download.';
  }
}

// Step 3 — poll game-ready + stream setup.log while download/install is running
const _DL_STAGE_PCT = { waiting: 5, no_game_files: 5, downloading: 30, installing: 65, starting: 90, loading: 95, running: 97, hosting: 99, ready: 100 };
const _DL_STAGE_TXT = {
  waiting:       'Connecting to Steam…',
  no_game_files: 'Waiting for download to begin…',
  downloading:   'Downloading Stardew Valley via Steam… (may take 5–15 min)',
  installing:    'Installing SMAPI and building mods… (first run only)',
  starting:      'Game installed — starting server…',
  loading:       'Server loading…',
  running:       'Server running — proceeding to setup…',
  hosting:       'Multiplayer enabled — proceeding to setup…',
  ready:         '✅ Game installed and server is ready!',
};

// Show a "← Back to Step 2" button below the step-3 log when a fatal error occurs.
function _wizShowStep3BackBtn(msg) {
  const logEl = document.getElementById('wiz-dl-log');
  if (!logEl) return;
  // Only add once
  if (document.getElementById('wiz-dl-back-btn')) return;
  const wrap = document.createElement('div');
  wrap.style.cssText = 'margin-top:12px;display:flex;flex-direction:column;gap:8px;align-items:flex-start';
  if (msg) {
    const p = document.createElement('p');
    p.style.cssText = 'font-size:12px;color:var(--accent-error,#ef4444);margin:0';
    p.textContent = msg;
    wrap.appendChild(p);
  }
  const btn = document.createElement('button');
  btn.id = 'wiz-dl-back-btn';
  btn.className = 'btn btn-secondary';
  btn.textContent = 'Back to Step 2';
  btn.onclick = () => { wizGoToStep(2); };
  wrap.appendChild(btn);
  logEl.parentElement.appendChild(wrap);
}

// Returns the index of the LAST "Steam credentials detected" line in the log,
// or 0 if not found. Using the last occurrence means each new download attempt
// resets the view — old sentinels from earlier attempts are excluded.
function _wizLatestAttemptStart(lines) {
  let idx = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/Steam credentials detected/i.test(lines[i].text)) idx = i;
  }
  return idx;
}

// Stream setup.log lines into the step-3 log box, starting from the most
// recent "Steam credentials detected" line so old attempts are hidden.
function _wizStreamLogs(lines, logEl, cntEl) {
  if (!logEl || !lines?.length) return;

  // Recalculate start on first display or after a retry reset
  if (_steamDlLogLines === 0) {
    const startIdx = _wizLatestAttemptStart(lines);
    if (startIdx > 0) _steamDlLogLines = startIdx;
    logEl.innerHTML = ''; // clear placeholder
  }

  const newLines = lines.slice(_steamDlLogLines);
  if (!newLines.length) return;

  // Lines that are pure container-startup noise — not useful during the wizard
  const _wizNoisePatterns = [
    /StardropHost v[\d.]+ Starting/,
    /Phase \d+:/,
    /Step 0:/,
    /Step 1:/,
    /Starting web panel/,
    /Web panel started/,
    /Validating configuration/,
    /Configuration loaded/,
    /Setting up game files/,
    /No game files found/,
    /waiting for setup wizard/,
    /Open the web panel/,
    /={4,}/,           // === dividers
  ];

  newLines.forEach(l => {
    if (_wizNoisePatterns.some(p => p.test(l.text))) return;
    const div = document.createElement('div');
    div.style.color = l.level === 'error'            ? 'var(--accent-error,#ef4444)' :
                      l.level === 'warn'             ? 'var(--accent-warning,#f59e0b)' :
                      l.text.includes('[STEP]')      ? 'var(--accent)' :
                      l.text.includes('[STEAM]')     ? 'var(--text-secondary)' : '';
    if (l.text.includes('[STEP]')) div.style.fontWeight = '600';
    div.textContent = l.text;
    logEl.appendChild(div);
  });
  logEl.scrollTop = logEl.scrollHeight;
  _steamDlLogLines = lines.length;
  if (cntEl) cntEl.textContent = `${_steamDlLogLines} lines`;
}

// Called when the user submits a Guard code for steamcmd (separate from the
// sidecar login code). Re-triggers the download with the code included.
async function wizSubmitSteamcmdGuard() {
  const input    = document.getElementById('wiz-dl-guard-input');
  const btn      = document.getElementById('wiz-dl-guard-btn');
  const statusEl = document.getElementById('wiz-dl-guard-status');
  const lbl      = document.getElementById('wiz-dl-status');
  const bar      = document.getElementById('wiz-dl-bar');

  const code = input?.value?.trim();
  if (!code) { if (statusEl) statusEl.textContent = 'Please enter the Guard code.'; return; }
  if (!_wizState._steamUser || !_wizState._steamPass) {
    if (statusEl) statusEl.textContent = 'Session expired — go back to Step 2 and log in again.';
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = 'Submitting…'; }
  if (statusEl) statusEl.textContent = '';

  try {
    const data = await API.post('/api/wizard/step/2', {
      method: 'steam',
      steamUsername: _wizState._steamUser,
      steamPassword: _wizState._steamPass,
      steamGuardCode: code,
    });
    if (data?.success) {
      const guardRow = document.getElementById('wiz-dl-guard-row');
      if (guardRow) guardRow.style.display = 'none';
      if (input) input.value = '';
      if (lbl) { lbl.style.color = ''; lbl.textContent = 'Guard code sent — retrying download…'; }
      if (bar) bar.style.width = '35%';
      // Reset log position so we start streaming from the new attempt
      _steamDlLogLines = 0;
      // Remove any back button from a previous failed attempt
      const oldBack = document.getElementById('wiz-dl-back-btn');
      if (oldBack) oldBack.parentElement.remove();
      // Resume polling
      _steamDlPollTimer = setTimeout(wizPollDownloadProgress, 5000);
    } else {
      if (statusEl) statusEl.textContent = data?.error || 'Failed to submit code.';
      if (btn) btn.disabled = false;
    }
  } catch (e) {
    if (statusEl) statusEl.textContent = 'Network error — please try again.';
    if (btn) btn.disabled = false;
  }
}

async function wizPollDownloadProgress() {
  const bar     = document.getElementById('wiz-dl-bar');
  const lbl     = document.getElementById('wiz-dl-status');
  const logEl   = document.getElementById('wiz-dl-log');
  const cntEl   = document.getElementById('wiz-dl-log-count');

  try {
    const data  = await API.get('/api/wizard/game-ready');
    const stage = data?.stage || 'waiting';
    const pct   = _DL_STAGE_PCT[stage] || 5;

    if (bar) bar.style.width = pct + '%';
    if (lbl) {
      lbl.textContent = _DL_STAGE_TXT[stage] || lbl.textContent;
      lbl.style.color = stage === 'ready' ? 'var(--accent)' :
                        stage === 'no_game_files' ? 'var(--accent-error,#ef4444)' : '';
    }

    // Advance to step 4 (resource limits) once game + SMAPI are installed
    if (stage === 'starting' || stage === 'loading' || stage === 'running' || stage === 'hosting' || data?.ready) {
      clearTimeout(_steamDlPollTimer);
      _steamDlPollTimer = null;
      _wizState._gameMethod = 'steam';
      if (lbl) { lbl.style.color = 'var(--accent)'; lbl.textContent = '✅ Game installed — continuing setup…'; }
      setTimeout(() => wizGoToStep(4), 1200);
      return;
    }

    // Check setup.log for status and errors
    const log = await API.get('/api/logs/setup?lines=300');
    if (log?.lines?.length) {
      // Only check sentinels in lines from the latest attempt onwards —
      // this prevents old STEAM_GUARD_REQUIRED etc. from re-triggering.
      const attemptStart = _wizLatestAttemptStart(log.lines);
      const allText = log.lines.slice(attemptStart).map(l => l.text).join('\n');

      // Detect steamcmd Guard requirement — show inline input, pause polling.
      // Always show (even on retry) so the user can correct a wrong code.
      if (/STEAM_GUARD_REQUIRED/i.test(allText)) {
        clearTimeout(_steamDlPollTimer);
        _steamDlPollTimer = null;
        const guardRow  = document.getElementById('wiz-dl-guard-row');
        const guardBtn  = document.getElementById('wiz-dl-guard-btn');
        const guardStat = document.getElementById('wiz-dl-guard-status');
        const alreadyShown = guardRow && guardRow.style.display !== 'none';
        if (guardRow) guardRow.style.display = '';
        if (guardBtn) { guardBtn.disabled = false; guardBtn.textContent = alreadyShown ? 'Submit & Retry' : 'Submit'; }
        if (guardStat) guardStat.textContent = '';
        if (lbl) { lbl.style.color = 'var(--accent-warning,#f59e0b)'; lbl.textContent = '⏳ Waiting for Steam Guard code…'; }
        if (bar) bar.style.width = '30%';
        _wizStreamLogs(log.lines, logEl, cntEl);
        return;
      }

      if (/STEAM_WRONG_PASSWORD/i.test(allText)) {
        clearTimeout(_steamDlPollTimer);
        _steamDlPollTimer = null;
        if (lbl) { lbl.style.color = 'var(--accent-error,#ef4444)'; lbl.textContent = '❌ Wrong password.'; }
        _wizShowStep3BackBtn('Wrong Steam password — go back and re-enter your credentials.');
        return;
      }

      if (/STEAM_RATE_LIMIT/i.test(allText)) {
        clearTimeout(_steamDlPollTimer);
        _steamDlPollTimer = null;
        if (lbl) { lbl.style.color = 'var(--accent-error,#ef4444)'; lbl.textContent = '❌ Steam rate limit.'; }
        _wizShowStep3BackBtn('Steam has rate-limited this login. Wait a few minutes, then go back and retry.');
        return;
      }

      if (/STEAM_DOWNLOAD_FAILED|waiting for new credentials/i.test(allText)) {
        clearTimeout(_steamDlPollTimer);
        _steamDlPollTimer = null;
        if (lbl) { lbl.style.color = 'var(--accent-error,#ef4444)'; lbl.textContent = '❌ Download failed.'; }
        _wizShowStep3BackBtn('Download failed — go back to Step 2 and check your credentials.');
        return;
      }

      // Update progress bar from steamcmd download percentage.
      // Scan the current attempt's lines for the latest:
      //   "Update state (0x61) downloading, progress: 23.34"
      // and map that 0–100 value onto 5–90% of the bar (leaving room for
      // the preallocating/installing phases at either end).
      const attemptLines = log.lines.slice(attemptStart);
      let dlPct = null;
      for (let i = attemptLines.length - 1; i >= 0; i--) {
        const m = attemptLines[i].text.match(/downloading,\s*progress:\s*([\d.]+)/i);
        if (m) { dlPct = parseFloat(m[1]); break; }
      }
      if (dlPct !== null && bar) {
        const mapped = 5 + (dlPct / 100) * 85;
        bar.style.width = Math.min(Math.round(mapped), 90) + '%';
        if (lbl && dlPct > 0) {
          lbl.style.color = '';
          lbl.textContent = `Downloading Stardew Valley… ${Math.round(dlPct)}%`;
        }
      }

      // Stream new log lines (filtered to start from "Steam credentials detected")
      _wizStreamLogs(log.lines, logEl, cntEl);
    }
  } catch {}

  // Keep polling while on step 3
  if (_wizState.currentStep === 3) {
    _steamDlPollTimer = setTimeout(wizPollDownloadProgress, 4000);
  }
}

async function wizCheckGameFiles() {
  const statusEl   = document.getElementById('wiz-files-status');
  const choiceDiv  = document.getElementById('wiz-method-choice');
  statusEl.style.color = 'var(--text-secondary)';
  statusEl.textContent = 'Checking…';
  try {
    const data = await API.get('/api/wizard/status');
    if (data && data.gamePresent) {
      statusEl.style.color = 'var(--accent)';
      statusEl.textContent = '✅ Game files found!';
      _wizState._filesFound = true;
      if (choiceDiv) choiceDiv.style.display = 'none';
      document.getElementById('wiz-step2-next').disabled = false;
      if (!_wizState._method) _wizState._method = 'local';
    } else {
      statusEl.style.color = 'var(--accent-error)';
      statusEl.textContent = '❌ Game files not found. Choose a method below to provide them.';
      if (choiceDiv) choiceDiv.style.display = 'block';
      wizSetMethod('local');
    }
  } catch {
    statusEl.style.color = 'var(--accent-error)';
    statusEl.textContent = 'Check failed — try again.';
    if (choiceDiv) choiceDiv.style.display = 'block';
  }
}

async function wizScanInstanceSaves() {
  const loadingEl = document.getElementById('wiz-save-scan-loading');
  const listEl    = document.getElementById('wiz-save-scan-list');
  if (!loadingEl || !listEl) return;

  loadingEl.textContent = 'Scanning for existing saves…';
  loadingEl.style.display = 'block';
  listEl.style.display = 'none';

  let data;
  try { data = await API.get('/api/wizard/scan-instance-saves'); } catch { data = null; }

  if (!data?.available) {
    loadingEl.textContent = 'No existing StardropHost installs found to scan.';
    return;
  }
  if (!data.saves?.length) {
    loadingEl.textContent = 'No saves found in existing StardropHost installs.';
    return;
  }

  loadingEl.style.display = 'none';
  listEl.style.display = 'block';
  listEl.innerHTML = `
    <p style="font-size:13px;color:var(--text-secondary);margin:0 0 8px">Found saves in existing installs:</p>
    ${data.saves.map((s, idx) => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:var(--bg-tertiary);border-radius:6px;margin-bottom:6px">
        <div>
          <div style="font-size:13px;font-weight:500">${escapeHtml(s.saveName)}</div>
          <div style="font-size:11px;color:var(--text-muted)">${escapeHtml(s.instanceName)}</div>
        </div>
        <button id="wiz-import-btn-${idx}" class="btn btn-secondary" style="font-size:12px;padding:4px 12px"
          data-path="${escapeHtml(s.savePath)}" data-name="${escapeHtml(s.saveName)}"
          onclick="wizImportSaveFromScan(this.dataset.path, this.dataset.name, ${idx})">Import</button>
      </div>
    `).join('')}
  `;
}

async function wizImportSaveFromScan(savePath, saveName, btnIdx) {
  const btn      = document.getElementById(`wiz-import-btn-${btnIdx}`);
  const statusEl = document.getElementById('wiz-import-status');
  if (statusEl) { statusEl.style.color = 'var(--text-secondary)'; statusEl.textContent = `Importing "${saveName}"…`; }
  try {
    const data = await API.post('/api/wizard/import-save', { savePath, saveName });
    if (data?.success) {
      if (btn) { btn.textContent = '✓ Imported'; btn.disabled = true; btn.style.color = 'var(--accent)'; btn.style.borderColor = 'var(--accent)'; }
      if (statusEl) { statusEl.style.color = 'var(--accent)'; statusEl.textContent = `✅ "${saveName}" imported — select it below to use it.`; }
      wizRefreshSaveDropdown();
    } else {
      if (statusEl) { statusEl.style.color = 'var(--accent-error)'; statusEl.textContent = '❌ ' + (data?.error || 'Import failed.'); }
    }
  } catch (e) {
    if (statusEl) { statusEl.style.color = 'var(--accent-error)'; statusEl.textContent = e.message || 'Import failed.'; }
  }
}

async function wizSubmitStep2() {
  const method = _wizState._method;
  if (!method) { showToast('Select a game file method first', 'error'); return; }
  try {
    await API.post('/api/wizard/step/2', { method });
    _wizState._gameMethod = method;
    // Local/path users skip the download progress screen (step 3) — go straight to resources
    wizGoToStep(4);
  } catch (e) {
    showToast(e.message || 'Failed to save — try again', 'error');
  }
}

async function wizSubmitStep3(skip) {
  const cpu = skip ? '' : (document.getElementById('wiz-cpu').value.trim());
  const mem = skip ? '' : (document.getElementById('wiz-mem').value.trim());
  try {
    await API.post('/api/wizard/step/3', { cpuLimit: cpu, memoryLimit: mem });
    _wizState._cpu = cpu; _wizState._mem = mem;
    wizGoToStep(5);
    buildTzPicker('wiz-tz-picker', Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  } catch (e) {
    showToast(e.message || 'Failed to save — try again', 'error');
  }
}

async function wizSubmitStep4() {
  const pw   = document.getElementById('wiz-srv-pw').value.trim();
  const tz   = tzPickerValue('wiz-tz-picker');
  const mode = document.getElementById('wiz-server-mode')?.value || 'lan';
  try {
    await API.post('/api/wizard/step/4', { serverPassword: pw, timezone: tz || undefined, serverMode: mode });
    _wizState._srvPw = pw;
    // Populate confirm lines for step 6
    const gm = _wizState._gameMethod;
    document.getElementById('wiz-confirm-game').textContent =
      `✅ Game files: ${gm === 'steam' ? 'Steam download configured' : 'Copied manually'}`;
    const cpu = _wizState._cpu, mem = _wizState._mem;
    document.getElementById('wiz-confirm-resources').textContent =
      cpu || mem ? `✅ Resources: CPU=${cpu||'unlimited'}, RAM=${mem||'unlimited'}` : '✅ Resources: no limits set';
    document.getElementById('wiz-confirm-server').textContent =
      pw ? '✅ Server password set' : '✅ Server: open (no password)';
    // Load farm step (step 6)
    wizGoToStep(6);
    wizLoadFarmStep();
  } catch (e) {
    showToast(e.message || 'Failed to save — try again', 'error');
  }
}

// ─── Farm Setup (Step 5) ─────────────────────────────────────────
function wizFarmTab(tab) {
  document.getElementById('wiz-farm-new').style.display      = tab === 'new'      ? '' : 'none';
  document.getElementById('wiz-farm-existing').style.display = tab === 'existing' ? '' : 'none';
  document.getElementById('farm-tab-new').classList.toggle('active',      tab === 'new');
  document.getElementById('farm-tab-existing').classList.toggle('active', tab === 'existing');
  if (tab === 'existing') {
    wizScanInstanceSaves();
    wizRefreshSaveDropdown();
  }
}

async function wizRefreshSaveDropdown() {
  try {
    const data = await API.get('/api/wizard/saves');
    const sel  = document.getElementById('wiz-existing-save');
    if (!sel) return;
    if (data?.saves?.length) {
      sel.innerHTML = data.saves.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
    } else {
      sel.innerHTML = '<option value="">No saves found — copy or import a save above</option>';
    }
  } catch {}
}

async function wizLoadFarmStep() {
  wizFarmTab('new');
}

function wizPetToggle() {
  const accept     = document.getElementById('wiz-accept-pet')?.value === 'true';
  const detailsEl  = document.getElementById('wiz-pet-detail');
  if (detailsEl) detailsEl.style.display = accept ? '' : 'none';
}

function wizPetBreedOptions() {
  const species  = document.getElementById('wiz-pet-species')?.value || 'cat';
  const breedSel = document.getElementById('wiz-pet-breed');
  if (!breedSel) return;
  const cats = ['Tabby (orange)', 'Black cat', 'Calico', 'Siamese', 'Grey'];
  const dogs = ['Corgi', 'Pitbull', 'Poodle', 'Shiba Inu', 'Dalmatian'];
  const breeds = species === 'dog' ? dogs : cats;
  const current = breedSel.value;
  breedSel.innerHTML = breeds.map((b, i) => `<option value="${i}">${b}</option>`).join('');
  // Preserve selection if valid
  const idx = parseInt(current, 10);
  if (!isNaN(idx) && idx < 5) breedSel.value = String(idx);
}

async function wizCreateNewFarm() {
  const statusEl = document.getElementById('wiz-farm-status');

  const val = id => document.getElementById(id)?.value ?? '';

  const farmName     = val('wiz-farm-name').trim()    || 'Stardrop Farm';
  const farmerName   = val('wiz-farmer-name').trim()  || 'Host';
  const favoriteThing= val('wiz-favorite-thing').trim()|| 'Farming';
  const farmType     = val('wiz-farm-type')   || '0';
  const cabinCount   = val('wiz-cabin-count') || '1';
  const cabinLayout  = val('wiz-cabin-layout')|| 'separate';
  const moneyStyle   = val('wiz-money-style') || 'shared';
  const profitMargin = val('wiz-profit-margin')|| 'normal';
  const moveBuild    = val('wiz-move-build')  || 'off';
  const ccBundles    = val('wiz-cc-bundles')  || 'normal';
  const mineRewards  = val('wiz-mine-rewards')|| 'normal';
  const monsters     = val('wiz-monsters')    || 'false';
  const year1        = val('wiz-year1')       || 'false';
  const randomSeed   = val('wiz-random-seed').trim();
  const acceptPet    = val('wiz-accept-pet')  || 'true';
  const petSpecies   = val('wiz-pet-species') || 'cat';
  const petBreed     = val('wiz-pet-breed')   || '0';
  const petName      = val('wiz-pet-name').trim() || 'Stella';
  const cave         = val('wiz-cave')        || 'mushrooms';
  const joja         = val('wiz-joja')        || 'false';

  statusEl.style.color = 'var(--text-secondary)';
  statusEl.textContent = 'Saving farm configuration…';
  try {
    await API.post('/api/wizard/new-farm', {
      farmName, farmerName, favoriteThing,
      farmType, cabinCount, cabinLayout,
      moneyStyle, profitMargin, moveBuildPermission: moveBuild,
      communityCenterBundles: ccBundles, mineRewards,
      spawnMonstersAtNight: monsters === 'true',
      guaranteeYear1Completable: year1 === 'true',
      randomSeed: randomSeed !== '' ? randomSeed : null,
      acceptPet: acceptPet === 'true',
      petSpecies, petBreed: parseInt(petBreed, 10) || 0, petName,
      mushroomsOrBats: cave,
      purchaseJojaMembership: joja === 'true',
    });
    statusEl.style.color = 'var(--accent)';
    statusEl.textContent = '✅ Farm config saved';
    _wizState._farmMode = 'new';
    _wizState._farmName = farmName;
    const typeNames = ['Standard','Riverland','Forest','Hill-top','Wilderness','Four Corners','Beach'];
    document.getElementById('wiz-confirm-save').textContent =
      `✅ New farm: "${farmName}" (${typeNames[parseInt(farmType,10)] || 'Standard'})`;
    setTimeout(() => wizLaunchServer(), 800);
  } catch (e) {
    statusEl.style.color = 'var(--accent-error)';
    statusEl.textContent = e.message || 'Failed to save farm config.';
  }
}

async function wizSelectExistingSave() {
  const statusEl = document.getElementById('wiz-existing-status');
  const saveName = document.getElementById('wiz-existing-save')?.value?.trim();
  if (!saveName) { statusEl.textContent = 'No save selected.'; return; }

  statusEl.style.color = 'var(--text-secondary)';
  statusEl.textContent = 'Selecting save…';
  try {
    await API.post('/api/wizard/select-save', { saveName });
    statusEl.style.color = 'var(--accent)';
    statusEl.textContent = `✅ Will load: ${saveName}`;
    _wizState._farmMode = 'existing';
    _wizState._farmName = saveName;
    document.getElementById('wiz-confirm-save').textContent = `✅ Load save: ${saveName}`;
    setTimeout(() => wizLaunchServer(), 800);
  } catch (e) {
    statusEl.style.color = 'var(--accent-error)';
    statusEl.textContent = e.message || 'Failed to select save.';
  }
}

let _gameReadyTimer = null;
let _setupLogTimer  = null;
let _setupLogLines  = 0;
let _smapiLogTimer  = null;
let _smapiLogLines  = 0;
let _smapiLogActive = false;

async function wizLaunchServer() {
  wizGoToStep(7);
  _smapiLogLines  = 0;
  _smapiLogActive = false;
  try { await API.post('/api/wizard/step/5', {}); } catch {}
  wizPollGameReady(0);
  wizPollSetupLog();
}

async function wizPollSetupLog() {
  const box   = document.getElementById('wiz-setup-log');
  const count = document.getElementById('wiz-log-count');
  if (!box) return;

  try {
    const data = await fetch('/api/logs/setup?lines=120').then(r => r.json());
    if (data?.lines?.length && data.lines.length !== _setupLogLines) {
      _setupLogLines = data.lines.length;
      const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
      box.innerHTML = data.lines.map(l => {
        const cls = l.level === 'error' ? 'color:#ef4444'
                  : l.level === 'warn'  ? 'color:#f59e0b'
                  : l.text.includes('[STEP]') ? 'color:var(--accent);font-weight:600'
                  : '';
        return `<div style="${cls}">${escapeHtml(l.text)}</div>`;
      }).join('');
      if (count) count.textContent = `${data.lines.length} lines`;
      if (atBottom) box.scrollTop = box.scrollHeight;
    }
  } catch {}

  // Keep polling while wizard overlay is visible
  if (document.getElementById('wizard-overlay')?.style.display !== 'none') {
    _setupLogTimer = setTimeout(wizPollSetupLog, 3000);
  }
}

async function wizPollSmapiLog() {
  const section = document.getElementById('wiz-smapi-log-section');
  const box     = document.getElementById('wiz-smapi-log');
  const count   = document.getElementById('wiz-smapi-log-count');
  if (!box) return;

  try {
    const data = await fetch('/api/wizard/smapi-log?lines=150').then(r => r.json());
    if (data?.exists && data.lines?.length) {
      if (section) section.style.display = '';
      if (data.lines.length !== _smapiLogLines) {
        _smapiLogLines = data.lines.length;
        const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
        box.innerHTML = data.lines.map(l => {
          const cls = l.level === 'error' ? 'color:#ef4444'
                    : l.level === 'warn'  ? 'color:#f59e0b'
                    : l.level === 'trace' ? 'color:var(--text-muted);opacity:0.7'
                    : l.text.includes('[FarmAutoCreate]') || l.text.includes('[StardropGameManager]')
                      ? 'color:var(--accent);font-weight:600'
                    : '';
          return `<div style="${cls}">${escapeHtml(l.text)}</div>`;
        }).join('');
        if (count) count.textContent = `${data.lines.length} lines`;
        if (atBottom) box.scrollTop = box.scrollHeight;
      }
    }
  } catch {}

  if (document.getElementById('wizard-overlay')?.style.display !== 'none') {
    _smapiLogTimer = setTimeout(wizPollSmapiLog, 3000);
  }
}

const _STAGE_PCT = { waiting: 5, no_game_files: 8, downloading: 20, installing: 45, starting: 60, loading: 70, running: 80, hosting: 92, ready: 100 };
const _STAGE_TXT = {
  waiting:       'Waiting for server to start…',
  no_game_files: '⚠️ Game files not found — go back to step 2 to provide them',
  downloading:   'Downloading game files via Steam… (may take 5–15 min)',
  installing:    'Installing SMAPI and building mods… (first run only, may take a few minutes)',
  starting:      'Starting game server…',
  loading:       'Game is loading…',
  running:       'Creating your farm automatically…',
  hosting:       'Farm loaded, enabling multiplayer hosting…',
  ready:         '✅ Server is live — players can join!',
};

function wizPollGameReady(prevPct) {
  const bar = document.getElementById('wiz-launch-bar');
  const lbl = document.getElementById('wiz-launch-status');
  const btn = document.getElementById('wiz-complete-btn');

  _gameReadyTimer = setTimeout(async () => {
    try {
      const data = await API.get('/api/wizard/game-ready');
      const stage = data?.stage || 'waiting';
      const pct   = Math.max(prevPct, _STAGE_PCT[stage] || prevPct);

      if (bar) bar.style.width = pct + '%';
      if (lbl) {
        lbl.textContent  = _STAGE_TXT[stage] || lbl.textContent;
        lbl.style.color  = stage === 'ready' ? 'var(--accent)' : '';
      }

      // Start SMAPI log polling as soon as the game process is running
      if (!_smapiLogActive && data?.gameRunning) {
        _smapiLogActive = true;
        wizPollSmapiLog();
      }

      if (data?.ready) {
        if (bar) bar.style.width = '100%';
        if (lbl) { lbl.style.color = 'var(--accent)'; lbl.textContent = _STAGE_TXT.ready; }
        if (btn) { btn.disabled = false; btn.style.opacity = '1'; btn.textContent = 'Go to Dashboard'; }
      } else if (data?.stage === 'no_game_files') {
        // Game files never arrived — send user back to step 2
        if (lbl) { lbl.style.color = 'var(--accent-error, #ef4444)'; lbl.textContent = _STAGE_TXT.no_game_files; }
        if (btn) {
          btn.disabled = false; btn.style.opacity = '1';
          btn.textContent = 'Back to Game Files';
          btn.className = 'btn btn-warning';
          btn.onclick = () => wizGoToStep(2);
        }
        wizPollGameReady(pct); // keep polling — container will retry once creds re-appear
      } else {
        wizPollGameReady(pct);
      }
    } catch {
      wizPollGameReady(prevPct);
    }
  }, 5000);
}

async function wizComplete() {
  if (_gameReadyTimer) { clearTimeout(_gameReadyTimer); _gameReadyTimer = null; }

  // Mark wizard complete in backend state regardless of step-check results
  try { await API.post('/api/wizard/force-complete'); } catch {}

  // For existing-save path: save is already on disk — auto-select if needed.
  // For new-farm path: save won't exist until Day 1 ends; don't block here.
  if (_wizState._farmMode === 'existing') {
    try {
      const savesData = await API.get('/api/saves');
      if (savesData?.saves?.length && !savesData.selectedSave) {
        await API.post('/api/saves/select', { saveName: savesData.saves[0].name });
      }
    } catch {}
  }

  document.getElementById('wizard-overlay').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  init();
  showToast('Setup complete! Server is running.', 'success');
}

// ─── Startup Init ────────────────────────────────────────────────

function _checkSteamAuthOrInit() {
  document.getElementById('app').style.display = 'flex';
  init();
}

// ─── Global State ────────────────────────────────────────────────
let ws                     = null;
let currentPage            = 'dashboard';
let logAutoScroll          = true;
let statusInterval         = null;
let farmInterval           = null;
let playersInterval        = null;
let lastStatusData         = null;
let backupStatusPoll       = null;
let lastBackupStatus       = null;
let containerReconnectPoll = null;
let isGameRestarting       = false;
let gameRestartInitiatedAt = 0;
let isStopping             = false;
let isStarting             = false;
let isTransitioning        = false; // true during any start/stop/restart/boot state
let lastRemoteData         = null;
let _remoteOptimisticState = null;  // 'starting' | 'stopping' | null
let _remoteYaml            = '';
let _configRevealTimer     = null;
let _configCountdownTimer  = null;

// ─── Theme ───────────────────────────────────────────────────────
let currentTheme = (() => {
  const saved = localStorage.getItem('panel_theme');
  if (saved === 'dark' || saved === 'light') return saved;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
})();

function applyTheme() {
  document.documentElement.dataset.theme = currentTheme;
  const use = document.querySelector('#themeToggle use');
  if (use) use.setAttribute('href', currentTheme === 'dark' ? '#icon-theme-light' : '#icon-theme-dark');
}

// ─── Helpers ─────────────────────────────────────────────────────
function icon(name, cls = 'icon') {
  return `<svg class="${cls}" aria-hidden="true"><use href="#icon-${name}"></use></svg>`;
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function escapeHtml(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function formatSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0, size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return `${size.toFixed(1)} ${units[i]}`;
}

function formatUptime(seconds) {
  if (!seconds || seconds <= 0) return '--';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className   = `toast show ${type}`;
  setTimeout(() => toast.classList.remove('show'), 3500);
}

// ─── Copy-to-clipboard ───────────────────────────────────────────
function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  // HTTP fallback (LAN access)
  const el = document.createElement('textarea');
  el.value = text;
  el.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0';
  document.body.appendChild(el);
  el.focus(); el.select();
  try { document.execCommand('copy'); } catch {}
  document.body.removeChild(el);
  return Promise.resolve();
}

function setupCopyable() {
  document.addEventListener('click', e => {
    const el = e.target.closest('.copyable');
    if (!el) return;
    const text = el.textContent.trim();
    if (!text || text === '--') return;
    copyText(text).then(() => {
      const orig = el.textContent;
      el.textContent = 'Copied!';
      el.style.color = 'var(--accent)';
      setTimeout(() => { el.textContent = orig; el.style.color = ''; }, 1500);
      showToast(`Copied: ${text}`, 'success');
    }).catch(() => showToast('Copy failed', 'error'));
  });
}

// ─── Init ────────────────────────────────────────────────────────
async function loadPanelVersion() {
  const data = await API.get('/api/panel-update/status').catch(() => null);
  if (!data?.version) return;
  const el = document.getElementById('sidebarVersion');
  if (el) el.textContent = `v${data.version}`;
}

function init() {
  applyTheme();
  setupNavigation();
  setupCopyable();
  setupWebSocket();
  loadDashboard();
  loadRemoteStatus();
  loadBackupStatus();
  renderQuickActions();
  loadPanelVersion();

  document.getElementById('logoutBtn').onclick = () => {
    localStorage.removeItem('panel_token');
    window.location.href = '/login.html';
  };

  document.getElementById('themeToggle').onclick = () => {
    currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('panel_theme', currentTheme);
    applyTheme();
  };

  document.getElementById('menuToggle').onclick = () => {
    document.getElementById('sidebar').classList.toggle('open');
  };

  // Log controls — smart auto-scroll: pauses when user scrolls up, resumes at bottom
  const logOutput = document.getElementById('logOutput');
  if (logOutput) {
    logOutput.addEventListener('scroll', () => {
      logAutoScroll = logOutput.scrollHeight - logOutput.scrollTop - logOutput.clientHeight < 50;
    });
  }

  document.getElementById('logClear').onclick = () => {
    document.getElementById('logOutput').innerHTML = '';
  };

  // Close download dropdown when clicking outside
  document.addEventListener('click', e => {
    const dd = document.getElementById('logDlDropdown');
    if (dd && !dd.contains(e.target)) {
      const menu = document.getElementById('logDlMenu');
      if (menu) menu.style.display = 'none';
    }
  });

  document.querySelectorAll('.log-filter').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.log-filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadLogs(btn.dataset.filter);
      subscribeToLogs(btn.dataset.filter);
    };
  });

  let searchTimeout;
  document.getElementById('logSearch').oninput = e => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      const filter = document.querySelector('.log-filter.active')?.dataset.filter || 'all';
      loadLogs(filter, e.target.value);
    }, 300);
  };

  statusInterval = setInterval(loadDashboard, 5000);

  // Restore page from URL hash on refresh
  const VALID_PAGES = ['dashboard','farm','players','chat','saves','mods','terminal','config','remote'];
  const hashPage = window.location.hash.slice(1);
  if (hashPage && VALID_PAGES.includes(hashPage)) navigateTo(hashPage);
}

// ─── Navigation ──────────────────────────────────────────────────
const PAGE_TITLES = {
  dashboard: 'Dashboard', farm: 'Farm', players: 'Players', chat: 'Chat',
  saves: 'Saves', mods: 'Mods', terminal: 'Console', config: 'Config', remote: 'Remote',
};

function setupNavigation() {
  document.querySelectorAll('.nav-item, .mob-nav-item').forEach(item => {
    item.onclick = () => navigateTo(item.dataset.page);
  });
}

function navigateTo(page) {
  currentPage = page;
  history.replaceState(null, '', '#' + page);

  // Stop farm polling when leaving farm tab
  if (page !== 'farm' && farmInterval) { clearInterval(farmInterval); farmInterval = null; }

  // Stop player polling when leaving players tab
  if (page !== 'players' && playersInterval) { clearInterval(playersInterval); playersInterval = null; }
  // Stop chat polling when leaving both players and chat tabs
  if (page !== 'chat' && _chatPollTimer) { clearInterval(_chatPollTimer); _chatPollTimer = null; }

  document.querySelectorAll('.nav-item, .mob-nav-item').forEach(i => i.classList.remove('active'));
  document.querySelectorAll(`.nav-item[data-page="${page}"], .mob-nav-item[data-page="${page}"]`)
    .forEach(i => i.classList.add('active'));

  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(`page-${page}`)?.classList.add('active');

  setText('pageTitle', PAGE_TITLES[page] || page);
  document.getElementById('sidebar').classList.remove('open');

  switch (page) {
    case 'dashboard': loadDashboard(); loadRemoteStatus(); renderQuickActions(); break;
    case 'farm':
      loadFarm();
      if (!farmInterval) farmInterval = setInterval(loadFarm, 5000);
      break;
    case 'players':
      loadPlayers();
      if (!playersInterval) playersInterval = setInterval(loadPlayers, 5000);
      break;
    case 'chat':
      _chatPlayersTs = 0; // force immediate player refresh on page open
      renderChatPlayerPills();
      initChatColorRow();
      initChatEmoteMenu();
      loadChatMessages();
      if (!_chatPollTimer) _chatPollTimer = setInterval(loadChatMessages, 3000);
      break;
    case 'saves':     loadSaves();                                           break;
    case 'mods':      loadMods();                                            break;
    case 'terminal':  loadLogs('game'); subscribeToLogs('game');             break;
    case 'config':    loadConfig();                                          break;
    case 'remote':    loadRemoteStatus();                                    break;
  }
}

// ─── WebSocket ───────────────────────────────────────────────────
function setupWebSocket() {
  if (ws) ws.close();
  ws = new WebSocket(API.getWsUrl());

  ws.onopen    = ()  => console.log('[WS] Connected');
  ws.onclose   = ()  => { console.log('[WS] Disconnected, reconnecting in 5s...'); setTimeout(setupWebSocket, 5000); };
  ws.onerror   = ()  => {};
  ws.onmessage = (e) => {
    try { handleWsMessage(JSON.parse(e.data)); }
    catch (err) { console.error('[WS] Parse error:', err); }
  };
}

function wsSend(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function handleWsMessage(msg) {
  switch (msg.type) {
    case 'status':           updateDashboardUI(msg.data);      break;
    case 'log':              appendLogLine(msg.line);          break;
    case 'terminal:output':  appendTerminalOutput(msg.data);   break;
    case 'terminal:opened':
      appendTerminalOutput(msg.data);
      document.getElementById('termInput').disabled    = false;
      document.getElementById('termSendBtn').disabled  = false;
      document.getElementById('termConnect').style.display    = 'none';
      document.getElementById('termDisconnect').style.display = '';
      break;
    case 'terminal:closed':
    case 'terminal:error':
      appendTerminalOutput(msg.type === 'terminal:error' ? `[Error] ${msg.data}\r\n` : msg.data);
      document.getElementById('termInput').disabled    = true;
      document.getElementById('termSendBtn').disabled  = true;
      document.getElementById('termConnect').style.display    = '';
      document.getElementById('termDisconnect').style.display = 'none';
      break;
  }
}

// ─── Quick Actions ───────────────────────────────────────────────

const QUICK_ACTION_DEFS = {
  'restart-server': { label: 'Restart Server',    icon: 'icon-refresh',  cls: 'btn-warning',   onclick: 'restartServer()' },
  'toggle-server':  { label: 'Start/Stop Server', icon: 'icon-refresh',  cls: 'btn-secondary', onclick: 'toggleServer()' },
  'check-update':   { label: 'Check for Updates', icon: 'icon-download', cls: 'btn-secondary', onclick: 'checkAllUpdates()' },
  'toggle-remote':  { label: 'Remote',            icon: 'icon-globe',    cls: 'btn-secondary', onclick: 'toggleRemote()' },
  'backup-now':     { label: 'Backup Now',         icon: 'icon-saves',    cls: 'btn-success',   onclick: 'createBackup()' },
};

const QUICK_ACTIONS_KEY     = 'stardrop_quick_actions';
const QUICK_ACTIONS_DEFAULT = ['restart-server', 'toggle-server', 'check-update', 'toggle-remote'];

let quickActionsEditMode = false;
let qasDragSrcId        = null;

function getQuickActions() {
  try {
    const s = localStorage.getItem(QUICK_ACTIONS_KEY);
    if (s) return JSON.parse(s);
  } catch {}
  return [...QUICK_ACTIONS_DEFAULT];
}

function saveQuickActions(ids) {
  localStorage.setItem(QUICK_ACTIONS_KEY, JSON.stringify(ids));
}

function _qaButtonDef(id) {
  if (id === 'toggle-server') {
    const running = !!(lastStatusData?.gameRunning);
    return running
      ? { label: 'Stop Server',  icon: 'icon-screen',  cls: 'btn-danger',  onclick: 'stopServer()',  disabled: isTransitioning }
      : { label: 'Start Server', icon: 'icon-refresh', cls: 'btn-success', onclick: 'startServer()', disabled: isTransitioning };
  }
  if (id === 'toggle-remote') {
    if (!lastRemoteData?.configured) {
      return { label: 'Setup Remote', icon: 'icon-globe', cls: 'btn-secondary', onclick: "navigateTo('remote')" };
    }
    return lastRemoteData.anyRunning
      ? { label: 'Pause Remote',  icon: 'icon-globe', cls: 'btn-secondary', onclick: 'stopRemoteService()',  disabled: !!_remoteOptimisticState }
      : { label: 'Resume Remote', icon: 'icon-globe', cls: 'btn-success',   onclick: 'startRemoteService()', disabled: !!_remoteOptimisticState };
  }
  return QUICK_ACTION_DEFS[id];
}

function renderQuickActions() {
  if (qasDragSrcId) return; // don't interrupt active drag
  const container = document.getElementById('quickActionsContainer');
  if (!container) return;
  const ids       = getQuickActions().filter(id => QUICK_ACTION_DEFS[id]);
  const editClass = quickActionsEditMode ? ' editing' : '';
  container.innerHTML = ids.map(id => {
    const def = _qaButtonDef(id);
    const drag = `draggable="true" data-qaid="${id}"
      ondragstart="onQADragStart(event)" ondragover="onQADragOver(event)"
      ondrop="onQADrop(event)" ondragend="onQADragEnd(event)"`;
    return `<div class="quick-action-wrap${editClass}" ${drag}>
      <button class="btn ${def.cls}" type="button" onclick="${quickActionsEditMode ? '' : def.onclick}" ${def.disabled ? 'disabled' : ''}>
        <svg class="icon"><use href="#${def.icon}"></use></svg>${escapeHtml(def.label)}
      </button>
      <button class="quick-action-remove" onclick="removeQuickAction('${id}')" title="Remove">×</button>
    </div>`;
  }).join('') +
  `<button class="btn btn-secondary quick-action-add" type="button" onclick="openQuickActionsModal()" title="Add quick action">+</button>` +
  `<button class="btn btn-secondary quick-action-add" type="button" onclick="toggleQuickActionsEditMode()" title="${quickActionsEditMode ? 'Done' : 'Remove quick actions'}">${quickActionsEditMode ? '✓' : '−'}</button>`;
}

function toggleQuickActionsEditMode() {
  quickActionsEditMode = !quickActionsEditMode;
  renderQuickActions();
}

// ── Drag-to-reorder ──────────────────────────────────────────────
function onQADragStart(e) {
  qasDragSrcId = e.currentTarget.dataset.qaid;
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}
function onQADragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.quick-action-wrap').forEach(el => el.classList.remove('drag-over'));
  if (e.currentTarget.dataset.qaid !== qasDragSrcId) e.currentTarget.classList.add('drag-over');
}
function onQADrop(e) {
  e.preventDefault();
  const targetId = e.currentTarget.dataset.qaid;
  if (!targetId || targetId === qasDragSrcId) return;
  const ids    = getQuickActions();
  const srcIdx = ids.indexOf(qasDragSrcId);
  const tgtIdx = ids.indexOf(targetId);
  if (srcIdx === -1 || tgtIdx === -1) return;
  ids.splice(srcIdx, 1);
  ids.splice(tgtIdx, 0, qasDragSrcId);
  saveQuickActions(ids);
  qasDragSrcId = null;
  renderQuickActions();
}
function onQADragEnd() {
  document.querySelectorAll('.quick-action-wrap').forEach(el => el.classList.remove('dragging', 'drag-over'));
  qasDragSrcId = null;
}

function addQuickAction(id) {
  const ids = getQuickActions();
  if (!ids.includes(id) && QUICK_ACTION_DEFS[id]) {
    ids.push(id);
    saveQuickActions(ids);
    renderQuickActions();
    renderQuickActionsPickerList();
  }
}

function removeQuickAction(id) {
  saveQuickActions(getQuickActions().filter(i => i !== id));
  renderQuickActions();
}

function openQuickActionsModal() {
  quickActionsEditMode = false;
  document.getElementById('quickActionsModal').style.display = 'flex';
  renderQuickActionsPickerList();
}

function closeQuickActionsModal() {
  document.getElementById('quickActionsModal').style.display = 'none';
}

function renderQuickActionsPickerList() {
  const list = document.getElementById('quickActionsPickerList');
  if (!list) return;
  const added     = new Set(getQuickActions());
  const available = Object.entries(QUICK_ACTION_DEFS).filter(([id]) => !added.has(id));
  if (available.length === 0) {
    list.innerHTML = '<div class="empty-state" style="padding:12px 0">All actions already added.</div>';
    return;
  }
  list.innerHTML = available.map(([id, def]) => `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:var(--bg-tertiary);border-radius:8px">
      <div style="display:flex;align-items:center;gap:10px">
        <svg class="icon" style="color:var(--accent)"><use href="#${def.icon}"></use></svg>
        <span>${escapeHtml(def.label)}</span>
      </div>
      <button class="btn btn-sm btn-primary" onclick="addQuickAction('${id}')">Add</button>
    </div>`).join('');
}

// ─── Dashboard ───────────────────────────────────────────────────
async function loadDashboard() {
  const data = await API.get('/api/status');
  if (data) updateDashboardUI(data);
}

function updateDashboardUI(data) {
  lastStatusData = data;
  renderQuickActions();

  const gameRunning = !!data.gameRunning;
  const liveRunning = data.live?.serverState === 'running';

  // Clear flags on settled states
  if (!gameRunning) isStopping = false;
  if (gameRunning || liveRunning) isStarting = false;
  // Only clear restarting once live data is fresher than when restart was initiated
  // (prevents stale pre-restart live-status.json from prematurely clearing the flag)
  const liveIsPostRestart = (data.live?.timestamp || 0) > gameRestartInitiatedAt / 1000;
  if (isGameRestarting && liveRunning && liveIsPostRestart) {
    isGameRestarting = false;
    showToast('Server is back online', 'success');
  }

  // "Starting..." on fresh container boot: SMAPI not yet found but wasn't stopped by user.
  // systemUptime < 90s covers the gap between container start and SMAPI being detected by pgrep.
  const bootStarting = !gameRunning && !data.stoppedByUser && (data.containerUptime || 0) < 90;

  // Priority: Stopped > Stopping > Restarting > Starting > Running
  const realStopped = !gameRunning && !isGameRestarting && !isStarting && !bootStarting;
  const statusText  = realStopped      ? 'Stopped'
    : isStopping                       ? 'Stopping...'
    : isGameRestarting                 ? 'Restarting...'
    : (isStarting || bootStarting || (gameRunning && !liveRunning)) ? 'Starting...'
    :                                    'Running';
  const statusClass = realStopped      ? 'offline'
    : (isStopping || isGameRestarting || isStarting || bootStarting || !liveRunning) ? 'restarting'
    :                                    'running';
  const starting = isStopping || isGameRestarting || isStarting || bootStarting || (gameRunning && !liveRunning);

  setText('stat-status', statusText);
  document.getElementById('stat-status-icon').innerHTML =
    `<span class="status-orb ${statusClass}"></span>`;
  document.getElementById('serverStatus').className = `status-badge ${statusClass}`;
  document.getElementById('serverStatus').innerHTML =
    `<span class="status-dot ${statusClass}"></span>Server`;

  isTransitioning = starting;
  // Update config tab server status badge (live — same style as header)
  const cfgSrvEl = document.getElementById('configServerStatusBadge');
  if (cfgSrvEl) cfgSrvEl.innerHTML = `<span class="status-dot ${statusClass}"></span>${statusText}`;
  // Update config tab server toggle button
  updateServerToggleBtn(starting);

  // Disable all restart buttons while in any transitional state
  document.querySelectorAll('.btn[onclick="restartServer()"]').forEach(btn => { btn.disabled = starting; });

  setText('stat-players', `${data.players?.online ?? 0}/8`);
  setText('stat-uptime',  formatUptime(data.uptime || 0));
  setText('stat-day',     data.paused ? 'Paused' : (data.day || '--'));
  setText('stat-backups', data.backupCount ?? 0);
  setText('stat-mods',    data.modCount    ?? 0);

  // CPU
  const cpu = Math.round(data.cpu || 0);
  setText('cpu-value', `${cpu}%`);
  const cpuBar = document.getElementById('cpu-bar');
  cpuBar.style.width  = Math.min(cpu, 100) + '%';
  cpuBar.className    = 'progress-fill' + (cpu > 80 ? ' danger' : cpu > 60 ? ' warn' : '');

  // RAM
  const memUsedMB  = Math.round(data.memory?.used  || 0);
  const memLimitMB = data.memory?.limit || 2048;
  const memPct     = Math.round((memUsedMB / memLimitMB) * 100);
  setText('ram-value', `${memUsedMB} / ${memLimitMB} MB`);
  const ramBar   = document.getElementById('ram-bar');
  ramBar.style.width = Math.min(memPct, 100) + '%';
  ramBar.className   = 'progress-fill' + (memPct > 80 ? ' danger' : memPct > 60 ? ' warn' : '');

  // Details
  const net = data.network || {};
  setText('detail-join-ip',    net.joinIp || '--');
  setText('detail-local-ips',  net.localIps?.[0] || '--');
  setText('detail-panel-port', net.panelPort || 18642);
  const vncBadge = document.getElementById('vncTopbarBadge');
  if (vncBadge) vncBadge.style.display = data.vncEnabled ? '' : 'none';

  // Panel update notification (dashboard + config tab)
  function _renderPanelNotif(el) {
    if (!el) return;
    if (liveRunning && data.panelUpdateAvailable) {
      const info = data.panelUpdateInfo || {};
      const sub  = info.message ? `"${info.message.substring(0, 60)}${info.message.length > 60 ? '…' : ''}"` : 'A new version is available';
      el.innerHTML = `
        <div class="update-notification" onclick="selfUpdate()" title="Click to update StardropHost">
          <div class="update-notification-icon">🔄</div>
          <div class="update-notification-text">
            <div class="update-notification-title">StardropHost update available</div>
            <div class="update-notification-sub">${escapeHtml(sub)}</div>
          </div>
          <span style="color:var(--accent);font-size:18px;flex-shrink:0">›</span>
        </div>`;
      el.style.display = '';
    } else {
      el.style.display = 'none';
    }
  }
  _renderPanelNotif(document.getElementById('panelUpdateNotification'));
  _renderPanelNotif(document.getElementById('configPanelUpdateNotif'));

  // Game update notification (dashboard + config tab)
  function _renderGameNotif(el) {
    if (!el) return;
    if (liveRunning && data.gameUpdateAvailable) {
      const builds = data.gameUpdateBuilds || {};
      const sub = builds.latest ? `Build ${builds.current || '?'} → ${builds.latest}` : 'A new version is available';
      el.innerHTML = `
        <div class="update-notification" onclick="openGameUpdateModal()" title="Click to update">
          <div class="update-notification-icon">⬆</div>
          <div class="update-notification-text">
            <div class="update-notification-title">Stardew Valley update available</div>
            <div class="update-notification-sub">${escapeHtml(sub)} — click to update via Steam</div>
          </div>
          <span style="color:var(--accent);font-size:18px;flex-shrink:0">›</span>
        </div>`;
      el.style.display = '';
    } else {
      el.style.display = 'none';
    }
  }
  _renderGameNotif(document.getElementById('gameUpdateNotification'));
  _renderGameNotif(document.getElementById('configGameUpdateNotif'));

}

// ─── Farm ────────────────────────────────────────────────────────
function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s; }

async function loadFarm() {
  const data = await API.get('/api/farm/overview');
  if (!data) return;

  const liveEl = document.getElementById('farmLiveData');
  const ccEl   = document.getElementById('farmCCData');
  const infoEl = document.getElementById('farmInfoData');

  if (!data.available) {
    const msg = `<div class="empty-state">${escapeHtml(data.message || 'No farm data available')}</div>`;
    liveEl.innerHTML = msg; ccEl.innerHTML = msg; infoEl.innerHTML = msg;
    return;
  }

  const farmPlayers = (data.players || []).filter(p => !p.isHost);
  const season  = capitalize(data.season);
  const weather = capitalize(data.weather);

  const gameState = (() => {
    if (data.serverState === 'running') return farmPlayers.length > 0 ? 'Playing' : 'Paused';
    return capitalize(data.serverState) || '--';
  })();

  // Compact player strip
  const playerStrip = farmPlayers.length
    ? `<div class="farm-player-strip">
        ${farmPlayers.map(p => `<span class="farm-player-dot">● ${escapeHtml(p.name)}</span>`).join('')}
        <span style="color:var(--text-muted);font-size:12px">${farmPlayers.length} online</span>
       </div>`
    : `<div class="farm-player-strip" style="color:var(--text-muted)">No players online</div>`;

  liveEl.innerHTML = `
    <div class="details-grid">
      <div class="detail-item">
        <div class="detail-label">Date</div>
        <div class="detail-value">${escapeHtml(season || '--')} ${data.day ?? '--'}, Year ${data.year ?? '--'}</div>
      </div>
      <div class="detail-item">
        <div class="detail-label">Time</div>
        <div class="detail-value">${data.timeOfDay != null ? formatGameTime(data.timeOfDay) : '--'}</div>
      </div>
      <div class="detail-item">
        <div class="detail-label">Weather</div>
        <div class="detail-value">${escapeHtml(weather || '--')}</div>
      </div>
      <div class="detail-item">
        <div class="detail-label">Game State</div>
        <div class="detail-value">${escapeHtml(gameState)}</div>
      </div>
    </div>
    <div style="margin-top:12px">${playerStrip}</div>
  `;

  // Community Center
  if (data.communityCenter) {
    const cc = data.communityCenter;
    const roomsHtml = Object.entries(cc.rooms).map(([room, info]) =>
      `<div class="detail-item">
        <div class="detail-label">${escapeHtml(room)}</div>
        <div class="detail-value" style="color:${info.complete ? 'var(--accent)' : 'var(--text-primary)'}">
          ${info.complete ? '✅ Complete' : `${info.bundles.filter(b => b.complete).length}/${info.bundles.length} Bundles`}
        </div>
      </div>`
    ).join('');

    ccEl.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <span class="detail-label">Progress</span>
        <span class="detail-value">${cc.completedRooms} / ${cc.totalRooms} Rooms (${cc.percentComplete}%)</span>
      </div>
      <div class="progress-bar" style="margin-bottom:16px;height:12px">
        <div class="progress-fill" style="width:${cc.percentComplete}%;${cc.percentComplete === 100 ? 'background:var(--accent)' : ''}"></div>
      </div>
      <div class="details-grid">${roomsHtml}</div>
    `;
  } else {
    ccEl.innerHTML = '<div class="empty-state">Community Center data not available</div>';
  }

  // Farm info — no Farmer field
  infoEl.innerHTML = `
    <div class="details-grid">
      <div class="detail-item">
        <div class="detail-label">Farm Name</div>
        <div class="detail-value">${escapeHtml(data.farmName || '--')}</div>
      </div>
      <div class="detail-item">
        <div class="detail-label">Farm Type</div>
        <div class="detail-value">${escapeHtml(data.farmType || '--')}</div>
      </div>
      <div class="detail-item">
        <div class="detail-label">Combined Money</div>
        <div class="detail-value">${data.money != null ? `${data.money.toLocaleString()}g` : '--'}</div>
      </div>
      <div class="detail-item">
        <div class="detail-label">Combined Total Earned</div>
        <div class="detail-value">${data.totalEarned != null ? `${data.totalEarned.toLocaleString()}g` : '--'}</div>
      </div>
      <div class="detail-item">
        <div class="detail-label">Combined Farm Time</div>
        <div class="detail-value">${data.playtimeHours != null ? `${data.playtimeHours}h` : '--'}</div>
      </div>
    </div>
  `;
}

// ─── World Controls ───────────────────────────────────────────────

let _worldFrozen = false;

async function worldCmd(base, value, clearId) {
  const command = value !== '' ? `${base} ${value}` : base;
  const data = await API.post('/api/players/admin-command', { command }).catch(() => null);
  if (data?.success && clearId) { const inp = document.getElementById(clearId); if (inp) inp.value = ''; }
  const el = document.getElementById('worldCmdResult');
  if (!el) return;
  el.textContent    = data?.success ? `✓ Sent: ${command}` : `✗ ${data?.error || 'Failed — is the server running?'}`;
  el.style.color    = data?.success ? 'var(--accent)' : '#ef4444';
  el.style.background = data?.success ? 'rgba(167,139,250,0.08)' : 'rgba(239,68,68,0.08)';
  el.style.display  = '';
  setTimeout(() => { el.style.display = 'none'; }, 4000);
}

async function toggleWorldFreeze() {
  const data = await API.post('/api/players/admin-command', { command: 'world_freezetime' }).catch(() => null);
  if (data?.success) {
    _worldFrozen = !_worldFrozen;
    const stateEl = document.getElementById('worldFreezeState');
    if (stateEl) stateEl.textContent = _worldFrozen ? '❄️ Frozen' : '▶ Running';
  }
  const el = document.getElementById('worldCmdResult');
  if (!el) return;
  el.textContent  = data?.success ? `✓ Time ${_worldFrozen ? 'frozen' : 'unfrozen'}` : `✗ ${data?.error || 'Failed'}`;
  el.style.color  = data?.success ? 'var(--accent)' : '#ef4444';
  el.style.background = data?.success ? 'rgba(167,139,250,0.08)' : 'rgba(239,68,68,0.08)';
  el.style.display = '';
  setTimeout(() => { el.style.display = 'none'; }, 4000);
}

function formatGameTime(t) {
  const h      = Math.floor(t / 100);
  const m      = t % 100;
  const suffix = h >= 12 ? 'pm' : 'am';
  const h12    = h > 12 ? h - 12 : h === 0 ? 12 : h;
  return `${h12}:${String(m).padStart(2, '0')}${suffix}`;
}

// ─── Logs ────────────────────────────────────────────────────────

function toggleLogDlMenu() {
  const menu = document.getElementById('logDlMenu');
  if (menu) menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
}

async function downloadSmapiLog() {
  try {
    const data = await API.get('/api/logs?type=all&lines=10000');
    if (!data?.lines?.length) { showToast('No logs to download', 'warn'); return; }
    const text = data.lines.map(l => l.text).join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
      download: `smapi-log-${Date.now()}.txt`,
    });
    a.click();
    URL.revokeObjectURL(a.href);
  } catch {
    showToast('Failed to download SMAPI log', 'error');
  }
}

async function downloadUpdateLog() {
  const btn = document.getElementById('logUpdateDownload');
  if (btn) { btn.disabled = true; btn.textContent = 'Downloading...'; }
  try {
    const [gameUpdate, panelUpdate] = await Promise.all([
      API.get('/api/game-update/status').catch(() => null),
      API.get('/api/panel-update/status').catch(() => null),
    ]);
    const lines = ['=== StardropHost Update Log ===', `Generated: ${new Date().toLocaleString()}`, ''];
    if (panelUpdate) {
      lines.push('--- Panel Status ---');
      lines.push(`Version: ${panelUpdate.version || 'unknown'}`);
      lines.push(`Update available: ${panelUpdate.available ? 'Yes — ' + (panelUpdate.latestCommitSha || '') : 'No'}`);
      lines.push('');
    }
    if (gameUpdate?.log?.length) {
      lines.push('--- Last Game Update Log ---');
      lines.push(...gameUpdate.log);
    } else {
      lines.push('--- No game update log available ---');
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.href = url; a.download = `stardrop-update-log-${ts}.txt`; a.click();
    URL.revokeObjectURL(url);
  } catch {
    showToast('Failed to download update log', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<svg class="icon"><use href="#icon-download"></use></svg> Update Log'; }
  }
}

async function downloadDockerLogs() {
  const btn = document.getElementById('logDockerDownload');
  if (btn) { btn.disabled = true; btn.textContent = 'Downloading...'; }
  try {
    const data = await API.get('/api/logs/docker?lines=1000');
    if (!data?.lines?.length) { showToast('No docker logs available', 'warn'); return; }
    const text = data.lines.join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.href = url; a.download = `stardrop-docker-${ts}.txt`; a.click();
    URL.revokeObjectURL(url);
  } catch {
    showToast('Failed to download docker logs', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Docker Logs'; }
  }
}

async function downloadLogs() {
  const btn = document.getElementById('logDownload');
  if (btn) { btn.disabled = true; btn.textContent = 'Downloading...'; }

  try {
    const data = await API.get('/api/logs?type=all&lines=5000');
    if (!data?.lines?.length) { showToast('No logs to download', 'warn'); return; }

    const text = data.lines.map(l => l.text).join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.href     = url;
    a.download = `stardrop-logs-${ts}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  } catch {
    showToast('Failed to download logs', 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<svg class="icon"><use href="#icon-download"></use></svg> Download';
    }
  }
}

async function loadLogs(filter, search) {
  const params = new URLSearchParams({ type: filter || 'all', lines: 300 });
  if (search) params.set('search', search);

  const data = await API.get(`/api/logs?${params}`);
  if (!data) return;

  const output = document.getElementById('logOutput');
  output.innerHTML = '';
  logAutoScroll = true; // reset on tab switch / filter change

  if (!data.exists) {
    output.innerHTML = '<div class="log-line info">Log file not found yet — server may still be starting...</div>';
    return;
  }

  if (!data.lines.length) {
    output.innerHTML = '<div class="log-line info">No log entries yet — waiting for server activity...</div>';
    return;
  }

  for (const line of data.lines) appendLogLine(line);
  output.scrollTop = output.scrollHeight;
}

function appendLogLine(line) {
  const output = document.getElementById('logOutput');
  const div    = document.createElement('div');
  div.className   = `log-line ${line.level || 'info'}`;
  div.textContent = line.text || line;
  output.appendChild(div);
  while (output.children.length > 2000) output.removeChild(output.firstChild);
  if (logAutoScroll) output.scrollTop = output.scrollHeight;
}

function subscribeToLogs(filter) {
  wsSend({ type: 'subscribe', channel: 'logs', filter });
}

// ─── Terminal ────────────────────────────────────────────────────
function terminalConnect()    { wsSend({ type: 'terminal:open' }); }
function terminalDisconnect() {
  wsSend({ type: 'terminal:close' });
  document.getElementById('termInput').disabled    = true;
  document.getElementById('termSendBtn').disabled  = true;
  document.getElementById('termConnect').style.display    = '';
  document.getElementById('termDisconnect').style.display = 'none';
}

function terminalSend() {
  const input = document.getElementById('termInput');
  const text  = input.value.trim();
  if (!text) return;
  wsSend({ type: 'terminal:input', data: text });
  input.value = '';
}

function appendTerminalOutput(text) {
  const output = document.getElementById('termOutput');
  output.querySelector('.terminal-hint')?.remove();
  output.textContent += text;
  output.scrollTop = output.scrollHeight;
}

// ─── Players ─────────────────────────────────────────────────────
function renderPlayerStats(p, separateWallets) {
  const parts = [];
  if (p.health != null)  parts.push(`❤️ ${p.health}/${p.maxHealth}`);
  if (p.stamina != null) parts.push(`⚡ ${p.stamina}/${p.maxStamina}`);
  const statsLine = parts.length ? `<div class="player-info">${parts.join(' &nbsp;·&nbsp; ')}</div>` : '';

  const s = p.skills;
  const skillsLine = s ? `<div class="player-info" style="font-size:11px;color:var(--text-muted)">
    🌱${s.farming} ⛏${s.mining} 🌲${s.foraging} 🎣${s.fishing} ⚔️${s.combat} 🍀${s.luck}
  </div>` : '';

  const moneyLine = separateWallets && p.money != null
    ? `<div class="player-info">💰 ${p.money.toLocaleString()}g${p.totalEarned != null ? ` · Earned: ${p.totalEarned.toLocaleString()}g` : ''}</div>`
    : '';

  const playtimeLine = p.totalPlaytimeHours != null
    ? `<div class="player-info" style="font-size:11px;color:var(--text-muted)">⏱ ${p.totalPlaytimeHours}h played · ${p.daysPlayed ?? '--'} days</div>`
    : (p.daysPlayed != null ? `<div class="player-info" style="font-size:11px;color:var(--text-muted)">${p.daysPlayed} days played</div>` : '');

  return statsLine + skillsLine + moneyLine + playtimeLine;
}

function timeAgo(ms) {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  return `${Math.floor(s/3600)}h ago`;
}

async function loadPlayers() {
  const data = await API.get('/api/players');
  if (!data) return;
  _lastPlayersData = data;

  const sw   = data.separateWallets === true;
  const list = document.getElementById('playersList');
  setText('playerCount', `${data.online ?? 0} / 8`);

  if (!data.players?.length) {
    list.innerHTML = `<div class="empty-state">${icon('players', 'icon empty-icon')}<div>No players online</div></div>`;
  } else {
    list.innerHTML = data.players.map(p => `
      <div class="player-card">
        <div class="player-avatar">${icon('players', 'icon')}</div>
        <div class="player-body">
          <div class="player-name">${escapeHtml(p.name)}${p.knownIp ? `<span class="player-ip">${escapeHtml(p.knownIp)}</span>` : ''}</div>
          ${p.location ? `<div class="player-info">${escapeHtml(p.location)}</div>` : ''}
          ${renderPlayerStats(p, sw)}
        </div>
        <div class="player-actions">
          <button class="btn btn-sm" onclick="openAdminModal(_lastPlayersData.players.find(x=>x.id==='${escapeHtml(p.id)}'))">Admin</button>
          <button class="btn btn-sm" onclick="kickPlayer(this,'${escapeHtml(p.id)}','${escapeHtml(p.name)}')">Kick</button>
          <button class="btn btn-sm btn-danger" onclick="banPlayer(this,'${escapeHtml(p.id)}','${escapeHtml(p.name)}')">Ban</button>
        </div>
      </div>
    `).join('');
  }

  // Recent Players card
  const recentCard = document.getElementById('recentPlayersCard');
  const recentList = document.getElementById('recentPlayersList');
  const onlineNames = new Set((data.players || []).map(p => p.name));
  const recent = (data.recentPlayers || []).filter(p => p.name && !onlineNames.has(p.name));
  const bannedIds   = new Set(data.bannedIds   || []);
  const bannedNames = new Set(data.bannedNames || []);
  const isBanned = p => bannedIds.has(p.id) || bannedNames.has(p.name);

  if (recent.length) {
    recentCard.style.display = '';
    recentList.innerHTML = recent.map(p => `
      <div class="player-card player-card-offline">
        <div class="player-avatar">${icon('players', 'icon')}</div>
        <div class="player-body">
          <div class="player-name">
            ${escapeHtml(p.name)}
            <span class="player-offline-badge">${isBanned(p) ? 'Banned' : 'Offline'}</span>
          </div>
          ${p.location ? `<div class="player-info">${escapeHtml(p.location)}</div>` : ''}
          ${renderPlayerStats(p, sw)}
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex-shrink:0">
          <div class="player-last-seen">Last seen<br>${timeAgo(p.lastSeen)}</div>
          ${isBanned(p)
            ? `<button class="btn btn-sm btn-secondary" onclick="unbanPlayer(this,'${escapeHtml(p.id)}','${escapeHtml(p.name)}')">Unban</button>`
            : `<button class="btn btn-sm btn-danger" onclick="banPlayer(this,'${escapeHtml(p.id)}','${escapeHtml(p.name)}')">Ban</button>`
          }
          <button class="btn btn-sm" style="color:var(--text-muted);border-color:var(--border)"
            onclick="deleteRecentPlayer(this,'${escapeHtml(p.id)}')">Remove</button>
        </div>
      </div>
    `).join('');
  } else {
    recentCard.style.display = 'none';
  }

  // Security
  renderSecurity(data.security || { mode: 'block', blocklist: [], allowlist: [] }, data.nameIpMap || {});
}

async function kickPlayer(btn, id, name) {
  if (!confirm(`Kick ${name}?`)) return;
  btn.disabled = true; btn.textContent = 'Kicking...';
  const data = await API.post('/api/players/kick', { id, name }).catch(() => null);
  showToast(data?.success ? `Kicked ${name}` : (data?.error || 'Kick failed'), data?.success ? 'success' : 'error');
  if (data?.success) setTimeout(loadPlayers, 600); else { btn.disabled = false; btn.textContent = 'Kick'; }
}

async function banPlayer(btn, id, name) {
  if (!confirm(`Ban ${name}? They will be kicked and blocked from rejoining.`)) return;
  btn.disabled = true; btn.textContent = 'Banning...';
  const data = await API.post('/api/players/ban', { id, name }).catch(() => null);
  showToast(data?.success ? `Banned ${name}` : (data?.error || 'Ban failed'), data?.success ? 'success' : 'error');
  if (data?.success) setTimeout(loadPlayers, 600); else { btn.disabled = false; btn.textContent = 'Ban'; }
}

async function unbanPlayer(btn, id, name) {
  btn.disabled = true; btn.textContent = 'Unbanning...';
  const data = await API.post('/api/players/unban', { id, name }).catch(() => null);
  showToast(data?.success ? `Unbanned ${name}` : (data?.error || 'Unban failed'), data?.success ? 'success' : 'error');
  if (data?.success) loadPlayers(); else { btn.disabled = false; btn.textContent = 'Unban'; }
}

async function deleteRecentPlayer(btn, id) {
  btn.disabled = true;
  await API.post('/api/players/recent/delete', { id }).catch(() => null);
  loadPlayers();
}

// ─── Security (Block List / Allow List) ───────────────────────────

let _securityMode = 'block';

function renderSecurity(security, nameIpMap) {
  _securityMode = security.mode || 'block';

  const blockBtn = document.getElementById('secModeBlockBtn');
  const allowBtn = document.getElementById('secModeAllowBtn');
  const modeDesc = document.getElementById('secModeDesc');
  const badge    = document.getElementById('allowlistBadge');
  if (blockBtn) blockBtn.classList.toggle('active', _securityMode === 'block');
  if (allowBtn) allowBtn.classList.toggle('active', _securityMode === 'allow');
  if (modeDesc) modeDesc.textContent = _securityMode === 'block'
    ? 'Block List Mode — everyone can join except blocked players.'
    : 'Allow List Mode — only players on the Allow List can join.';
  if (badge) {
    badge.textContent          = _securityMode === 'allow' ? 'Active' : 'Inactive in Block Mode';
    badge.style.background     = _securityMode === 'allow' ? 'rgba(34,197,94,0.15)' : 'var(--bg-tertiary)';
    badge.style.color          = _securityMode === 'allow' ? '#22c55e' : 'var(--text-muted)';
  }

  _renderSecurityList('blocklistEntries', security.blocklist || [], 'block', nameIpMap);
  _renderSecurityList('allowlistEntries', security.allowlist || [], 'allow', nameIpMap);
  _renderNameIpMap(nameIpMap);
}

function _renderSecurityList(elId, list, listType, nameIpMap) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!list.length) {
    el.innerHTML = '<div class="security-empty">No entries.</div>';
    return;
  }
  el.innerHTML = list.map(e => {
    const badge = e.type === 'ip'
      ? '<span class="sec-badge sec-badge-ip">IP</span>'
      : '<span class="sec-badge sec-badge-name">Name</span>';
    const knownIp = (e.type === 'name' && nameIpMap[e.value])
      ? `<span class="sec-known-ip">${escapeHtml(nameIpMap[e.value])}</span>` : '';
    const desc = e.description ? `<span class="sec-desc">${escapeHtml(e.description)}</span>` : '';
    return `<div class="sec-entry">
      ${badge}
      <span class="sec-value">${escapeHtml(e.value)}</span>
      ${knownIp}${desc}
      <button class="btn btn-sm btn-danger" style="margin-left:auto" onclick="removeSecurityEntry('${listType}','${escapeHtml(e.value)}')">Remove</button>
    </div>`;
  }).join('');
}

function _renderNameIpMap(map) {
  const el = document.getElementById('knownIpsEntries');
  if (!el) return;
  const entries = Object.entries(map);
  if (!entries.length) {
    el.innerHTML = '<div class="security-empty">No players recorded yet. IPs are captured automatically when players join.</div>';
    return;
  }
  el.innerHTML = entries.map(([name, ip]) => `
    <div class="sec-entry">
      <span class="sec-badge sec-badge-name">Name</span>
      <span class="sec-value">${escapeHtml(name)}</span>
      <span class="sec-known-ip">${escapeHtml(ip)}</span>
      <input type="text" class="form-input" id="nipm-ip-${escapeHtml(name)}" value="${escapeHtml(ip)}"
        style="width:130px;padding:4px 8px;font-size:12px" placeholder="IP">
      <button class="btn btn-sm" onclick="updateNameIp('${escapeHtml(name)}')">Update</button>
      <button class="btn btn-sm btn-danger" onclick="deleteNameIp('${escapeHtml(name)}')">Remove</button>
    </div>`).join('');
}

async function setSecurityMode(mode) {
  const data = await API.put('/api/players/security/mode', { mode }).catch(() => null);
  if (data?.success) renderSecurity(data.security, _lastPlayersData?.nameIpMap || {});
  else showToast('Failed to update mode', 'error');
}

async function addBlocklistEntry() {
  const type  = document.getElementById('blocklistTypeInput').value;
  const value = document.getElementById('blocklistValueInput').value.trim();
  const desc  = document.getElementById('blocklistDescInput').value.trim();
  const msg   = document.getElementById('blocklistMsg');
  if (!value) { _secMsg(msg, 'Enter a player name or IP.', false); return; }
  const data = await API.post('/api/players/blocklist', { type, value, description: desc }).catch(() => null);
  if (data?.success) {
    document.getElementById('blocklistValueInput').value = '';
    document.getElementById('blocklistDescInput').value  = '';
    _secMsg(msg, `${value} blocked.`, true);
    renderSecurity(data.security, _lastPlayersData?.nameIpMap || {});
  } else { _secMsg(msg, data?.error || 'Failed.', false); }
}

async function addAllowlistEntry() {
  const type  = document.getElementById('allowlistTypeInput').value;
  const value = document.getElementById('allowlistValueInput').value.trim();
  const desc  = document.getElementById('allowlistDescInput').value.trim();
  const msg   = document.getElementById('allowlistMsg');
  if (!value) { _secMsg(msg, 'Enter a player name or IP.', false); return; }
  const data = await API.post('/api/players/allowlist', { type, value, description: desc }).catch(() => null);
  if (data?.success) {
    document.getElementById('allowlistValueInput').value = '';
    document.getElementById('allowlistDescInput').value  = '';
    _secMsg(msg, `${value} added to allow list.`, true);
    renderSecurity(data.security, _lastPlayersData?.nameIpMap || {});
  } else { _secMsg(msg, data?.error || 'Failed.', false); }
}

async function removeSecurityEntry(listType, value) {
  if (!confirm(`Remove "${value}" from the ${listType === 'block' ? 'block' : 'allow'} list?`)) return;
  const endpoint = listType === 'block'
    ? `/api/players/blocklist/${encodeURIComponent(value)}`
    : `/api/players/allowlist/${encodeURIComponent(value)}`;
  const data = await API.del(endpoint).catch(() => null);
  if (data?.success) renderSecurity(data.security, _lastPlayersData?.nameIpMap || {});
  else showToast('Failed to remove entry', 'error');
}

async function updateNameIp(name) {
  const ip = document.getElementById(`nipm-ip-${name}`)?.value.trim();
  if (!ip) return;
  const data = await API.put(`/api/players/name-ip-map/${encodeURIComponent(name)}`, { ip }).catch(() => null);
  if (data?.success) _renderNameIpMap(data.nameIpMap);
  else showToast('Failed to update IP', 'error');
}

async function deleteNameIp(name) {
  if (!confirm(`Remove ${name} from known IPs?`)) return;
  const data = await API.del(`/api/players/name-ip-map/${encodeURIComponent(name)}`).catch(() => null);
  if (data?.success) _renderNameIpMap(data.nameIpMap);
  else showToast('Failed to remove entry', 'error');
}

function _secMsg(el, text, ok) {
  if (!el) return;
  el.textContent  = text;
  el.style.color  = ok ? 'var(--accent)' : '#ef4444';
  el.style.display = '';
  if (ok) setTimeout(() => { el.style.display = 'none'; }, 3000);
}

// ─── SDV Item List (qualified IDs for player_add command) ─────────
const SDV_ITEMS = [
  // Books
  { id:'Book_AnimalCatalogue',  name:'Animal Catalogue',           cat:'Books' },
  { id:'Book_Artifact',         name:'Treasure Appraisal Guide',   cat:'Books' },
  { id:'Book_Bombs',            name:'Dwarvish Safety Manual',     cat:'Books' },
  { id:'Book_Crabbing',         name:'The Art O\'Crabbing',        cat:'Books' },
  { id:'Book_Defense',          name:'Jack Be Nimble, Jack Be Thick', cat:'Books' },
  { id:'Book_Diamonds',         name:'The Diamond Hunter',         cat:'Books' },
  { id:'Book_Friendship',       name:'Friendship 101',             cat:'Books' },
  { id:'Book_Grass',            name:'Ol\' Slitherlegs',           cat:'Books' },
  { id:'Book_Horse',            name:'Horse: The Book',            cat:'Books' },
  { id:'Book_Marlon',           name:'Mapping Cave Systems',       cat:'Books' },
  { id:'Book_Mystery',          name:'Book of Mysteries',          cat:'Books' },
  { id:'Book_PriceCatalogue',   name:'Price Catalogue',            cat:'Books' },
  { id:'Book_QueenOfSauce',     name:'Queen of Sauce Cookbook',    cat:'Books' },
  { id:'Book_Roe',              name:'Jewels of the Sea',          cat:'Books' },
  { id:'Book_Speed',            name:'Way of the Wind pt. 1',      cat:'Books' },
  { id:'Book_Speed2',           name:'Way of the Wind pt. 2',      cat:'Books' },
  { id:'Book_Trash',            name:'The Alleyway Buffet',        cat:'Books' },
  { id:'Book_Void',             name:'Monster Compendium',         cat:'Books' },
  { id:'Book_WildSeeds',        name:'Raccoon Journal',            cat:'Books' },
  { id:'Book_Woodcutting',      name:'Woody\'s Secret',            cat:'Books' },
  { id:'PurpleBook',            name:'Book of Stars',              cat:'Books' },
  { id:'SkillBook_0',           name:'Stardew Valley Almanac',     cat:'Books' },
  { id:'SkillBook_1',           name:'Bait and Bobber',            cat:'Books' },
  { id:'SkillBook_2',           name:'Woodcutter\'s Weekly',       cat:'Books' },
  { id:'SkillBook_3',           name:'Mining Monthly',             cat:'Books' },
  { id:'SkillBook_4',           name:'Combat Quarterly',           cat:'Books' },
  // Fishing
  { id:'SpecificBait',  name:'Bait',           cat:'Fishing' },
  { id:'CaveJelly',     name:'Cave Jelly',      cat:'Fishing' },
  { id:'ChallengeBait', name:'Challenge Bait',  cat:'Fishing' },
  { id:'DeluxeBait',    name:'Deluxe Bait',     cat:'Fishing' },
  { id:'Goby',          name:'Goby',            cat:'Fishing' },
  { id:'GoldenBobber',  name:'Golden Bobber',   cat:'Fishing' },
  { id:'TroutDerbyTag', name:'Golden Tag',      cat:'Fishing' },
  { id:'RiverJelly',    name:'River Jelly',     cat:'Fishing' },
  { id:'SeaJelly',      name:'Sea Jelly',       cat:'Fishing' },
  { id:'SmokedFish',    name:'Smoked Fish',     cat:'Fishing' },
  { id:'SonarBobber',   name:'Sonar Bobber',    cat:'Fishing' },
  // Mining — gems & bars
  { id:'60',  name:'Emerald',         cat:'Mining' },
  { id:'62',  name:'Aquamarine',      cat:'Mining' },
  { id:'64',  name:'Ruby',            cat:'Mining' },
  { id:'66',  name:'Amethyst',        cat:'Mining' },
  { id:'68',  name:'Topaz',           cat:'Mining' },
  { id:'70',  name:'Jade',            cat:'Mining' },
  { id:'72',  name:'Diamond',         cat:'Mining' },
  { id:'74',  name:'Prismatic Shard', cat:'Mining' },
  { id:'80',  name:'Quartz',          cat:'Mining' },
  { id:'82',  name:'Fire Quartz',     cat:'Mining' },
  { id:'84',  name:'Frozen Tear',     cat:'Mining' },
  { id:'86',  name:'Earth Crystal',   cat:'Mining' },
  { id:'330', name:'Clay',            cat:'Mining' },
  { id:'334', name:'Copper Bar',      cat:'Mining' },
  { id:'335', name:'Iron Bar',        cat:'Mining' },
  { id:'336', name:'Gold Bar',        cat:'Mining' },
  { id:'337', name:'Iridium Bar',     cat:'Mining' },
  { id:'338', name:'Refined Quartz',  cat:'Mining' },
  { id:'378', name:'Copper Ore',      cat:'Mining' },
  { id:'380', name:'Iron Ore',        cat:'Mining' },
  { id:'382', name:'Coal',            cat:'Mining' },
  { id:'384', name:'Gold Ore',        cat:'Mining' },
  { id:'386', name:'Iridium Ore',     cat:'Mining' },
  { id:'535', name:'Geode',           cat:'Mining' },
  { id:'536', name:'Frozen Geode',    cat:'Mining' },
  { id:'537', name:'Magma Geode',     cat:'Mining' },
  { id:'749', name:'Omni Geode',      cat:'Mining' },
  { id:'848', name:'Cinder Shard',    cat:'Mining' },
  { id:'909', name:'Radioactive Ore', cat:'Mining' },
  { id:'910', name:'Radioactive Bar', cat:'Mining' },
  { id:'CalicoEgg',    name:'Calico Egg',  cat:'Mining' },
  { id:'VolcanoGoldNode', name:'Gold Stone', cat:'Mining' },
  // Farming — crops & animal products
  { id:'24',  name:'Parsnip',           cat:'Farming' },
  { id:'91',  name:'Banana',            cat:'Farming' },
  { id:'174', name:'Egg (White)',        cat:'Farming' },
  { id:'176', name:'Large Egg (White)', cat:'Farming' },
  { id:'180', name:'Egg (Brown)',        cat:'Farming' },
  { id:'182', name:'Large Egg (Brown)', cat:'Farming' },
  { id:'184', name:'Milk',              cat:'Farming' },
  { id:'186', name:'Large Milk',        cat:'Farming' },
  { id:'188', name:'Green Bean',        cat:'Farming' },
  { id:'190', name:'Cauliflower',       cat:'Farming' },
  { id:'192', name:'Potato',            cat:'Farming' },
  { id:'248', name:'Garlic',            cat:'Farming' },
  { id:'250', name:'Kale',              cat:'Farming' },
  { id:'251', name:'Tea Sapling',       cat:'Farming' },
  { id:'252', name:'Rhubarb',           cat:'Farming' },
  { id:'254', name:'Melon',             cat:'Farming' },
  { id:'256', name:'Tomato',            cat:'Farming' },
  { id:'258', name:'Blueberry',         cat:'Farming' },
  { id:'260', name:'Hot Pepper',        cat:'Farming' },
  { id:'262', name:'Wheat',             cat:'Farming' },
  { id:'264', name:'Radish',            cat:'Farming' },
  { id:'266', name:'Red Cabbage',       cat:'Farming' },
  { id:'268', name:'Starfruit',         cat:'Farming' },
  { id:'270', name:'Corn',              cat:'Farming' },
  { id:'272', name:'Eggplant',          cat:'Farming' },
  { id:'274', name:'Artichoke',         cat:'Farming' },
  { id:'276', name:'Pumpkin',           cat:'Farming' },
  { id:'278', name:'Bok Choy',          cat:'Farming' },
  { id:'280', name:'Yam',               cat:'Farming' },
  { id:'282', name:'Cranberries',       cat:'Farming' },
  { id:'284', name:'Beet',              cat:'Farming' },
  { id:'289', name:'Ostrich Egg',       cat:'Farming' },
  { id:'292', name:'Mahogany Seed',     cat:'Farming' },
  { id:'297', name:'Grass Starter',     cat:'Farming' },
  { id:'300', name:'Amaranth',          cat:'Farming' },
  { id:'304', name:'Hops',              cat:'Farming' },
  { id:'305', name:'Void Egg',          cat:'Farming' },
  { id:'306', name:'Mayonnaise',        cat:'Farming' },
  { id:'307', name:'Duck Mayonnaise',   cat:'Farming' },
  { id:'308', name:'Void Mayonnaise',   cat:'Farming' },
  { id:'340', name:'Honey',             cat:'Farming' },
  { id:'347', name:'Rare Seed',         cat:'Farming' },
  { id:'400', name:'Strawberry',        cat:'Farming' },
  { id:'421', name:'Sunflower',         cat:'Farming' },
  { id:'423', name:'Rice',              cat:'Farming' },
  { id:'424', name:'Cheese',            cat:'Farming' },
  { id:'426', name:'Goat Cheese',       cat:'Farming' },
  { id:'428', name:'Cloth',             cat:'Farming' },
  { id:'430', name:'Truffle',           cat:'Farming' },
  { id:'432', name:'Truffle Oil',       cat:'Farming' },
  { id:'436', name:'Goat Milk',         cat:'Farming' },
  { id:'438', name:'Large Goat Milk',   cat:'Farming' },
  { id:'440', name:'Wool',              cat:'Farming' },
  { id:'442', name:'Duck Egg',          cat:'Farming' },
  { id:'444', name:'Duck Feather',      cat:'Farming' },
  { id:'447', name:'Rabbit\'s Foot',    cat:'Farming' },
  { id:'454', name:'Ancient Fruit',     cat:'Farming' },
  { id:'69',  name:'Banana Sapling',    cat:'Farming' },
  { id:'73',  name:'Golden Walnut',     cat:'Farming' },
  { id:'802', name:'Cactus Seeds',      cat:'Farming' },
  { id:'803', name:'Iridium Milk',      cat:'Farming' },
  { id:'829', name:'Mango',             cat:'Farming' },
  { id:'835', name:'Mango Sapling',     cat:'Farming' },
  { id:'CarrotSeeds',       name:'Carrot Seeds',        cat:'Farming' },
  { id:'DriedFruit',        name:'Dried Fruit',         cat:'Farming' },
  { id:'DriedMushrooms',    name:'Dried Mushrooms',     cat:'Farming' },
  { id:'MixedFlowerSeeds',  name:'Mixed Flower Seeds',  cat:'Farming' },
  { id:'MysticTreeSeed',    name:'Mystic Tree Seed',    cat:'Farming' },
  { id:'Powdermelon',       name:'Powdermelon',         cat:'Farming' },
  // Miscellaneous
  { id:'71',  name:'Trimmed Lucky Purple Shorts', cat:'Misc' },
  { id:'166', name:'Treasure Chest',              cat:'Misc' },
  { id:'261', name:'Warp Totem: Desert',          cat:'Misc' },
  { id:'275', name:'Artifact Trove',              cat:'Misc' },
  { id:'326', name:'Dwarvish Translation Guide',  cat:'Misc' },
  { id:'341', name:'Tea Set',                     cat:'Misc' },
  { id:'535', name:'Geode',                       cat:'Misc' },
  { id:'749', name:'Omni Geode',                  cat:'Misc' },
  { id:'Moss',                  name:'Moss',                   cat:'Misc' },
  { id:'Gold Coin',             name:'Gold Coin',              cat:'Misc' },
  { id:'Golden Animal Cracker', name:'Golden Animal Cracker',  cat:'Misc' },
  { id:'Golden Mystery Box',    name:'Golden Mystery Box',     cat:'Misc' },
  { id:'Prize Ticket',          name:'Prize Ticket',           cat:'Misc' },
  { id:'Stardrop Tea',          name:'Stardrop Tea',           cat:'Misc' },
  { id:'Tent Kit',              name:'Tent Kit',               cat:'Misc' },
  { id:'Treasure Totem',        name:'Treasure Totem',         cat:'Misc' },
  { id:'Pet License',           name:'Pet License',            cat:'Misc' },
  { id:'Butterfly Powder',      name:'Butterfly Powder',       cat:'Misc' },
  { id:'Blue Grass Starter',    name:'Blue Grass Starter',     cat:'Misc' },
];

// ─── Item Picker ──────────────────────────────────────────────────

let _selectedItemId   = '';
let _selectedItemName = '';

const ITEM_CAT_ORDER = ['Farming', 'Mining', 'Fishing', 'Misc', 'Books'];

function openItemPicker() {
  const search = document.getElementById('itemPickerSearch');
  if (search) search.value = '';
  filterItemPicker('');
  document.getElementById('itemPickerModal').style.display = '';
}

function closeItemPicker() {
  document.getElementById('itemPickerModal').style.display = 'none';
}

function selectItem(id, name) {
  _selectedItemId   = id;
  _selectedItemName = name;
  const display = document.getElementById('adminSelectedItem');
  if (display) display.textContent = name;
  closeItemPicker();
}

function filterItemPicker(query) {
  const list = document.getElementById('itemPickerList');
  if (!list) return;
  const q = (query || '').toLowerCase().trim();
  const matches = q
    ? SDV_ITEMS.filter(i => i.name.toLowerCase().includes(q) || i.id.toLowerCase().includes(q))
    : SDV_ITEMS;
  if (!matches.length) {
    list.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-muted)">No items found</div>';
    return;
  }
  const groups = {};
  for (const cat of ITEM_CAT_ORDER) groups[cat] = [];
  for (const item of matches) {
    if (!groups[item.cat]) groups[item.cat] = [];
    groups[item.cat].push(item);
  }
  let html = '';
  for (const cat of ITEM_CAT_ORDER) {
    if (!groups[cat]?.length) continue;
    html += `<div class="item-picker-cat">${escapeHtml(cat)}</div>`;
    for (const item of groups[cat]) {
      html += `<div class="item-picker-item" onclick="selectItem('(O)${escapeHtml(item.id)}','${escapeHtml(item.name.replace(/'/g,'&#39;'))}')">
        <span>${escapeHtml(item.name)}</span>
        <span class="item-picker-id">${escapeHtml(item.id)}</span>
      </div>`;
    }
  }
  list.innerHTML = html;
}

// Legacy stubs — kept so openAdminModal still compiles
function initAdminItemSelect() {}
function filterAdminItems() {}

// ─── Admin Controls Modal ─────────────────────────────────────────

let _lastPlayersData = { players: [] };
let _adminPlayer     = null;

function openAdminModal(player) {
  _adminPlayer = player;
  document.getElementById('adminModalTitle').textContent = `Admin — ${player.name}`;
  // Clear inputs and result
  ['adminSetMoney','adminSetHealth','adminSetMaxHealth','adminSetStamina','adminSetMaxStamina'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  const qty = document.getElementById('adminItemQty'); if (qty) qty.value = '1';
  const res = document.getElementById('adminCmdResult'); if (res) res.style.display = 'none';
  // Reset item selection
  _selectedItemId = ''; _selectedItemName = '';
  const display = document.getElementById('adminSelectedItem');
  if (display) display.textContent = '— none selected —';
  document.getElementById('adminModal').style.display = '';
}

function closeAdminModal() {
  document.getElementById('adminModal').style.display = 'none';
  _adminPlayer = null;
}

async function sendAdminCmd(base, value) {
  if (!value && value !== 0) return;
  const command = `${base} ${value}`;
  const data = await API.post('/api/players/admin-command', { command }).catch(() => null);
  _showAdminResult(data?.success, command, data?.error);
}

async function sendAdminGiveItem() {
  if (!_selectedItemId) { _showAdminResult(false, '', 'Browse and select an item first'); return; }
  const qty = parseInt(document.getElementById('adminItemQty').value || '1', 10) || 1;
  const command = `player_add ${_selectedItemId} ${qty}`;
  const data = await API.post('/api/players/admin-command', { command }).catch(() => null);
  _showAdminResult(data?.success, command, data?.error);
}

function _showAdminResult(success, command, error) {
  const el = document.getElementById('adminCmdResult');
  if (!el) return;
  el.textContent      = success ? `✓ Sent: ${command}` : `✗ ${error || 'Failed'}`;
  el.style.color      = success ? 'var(--accent)' : '#ef4444';
  el.style.background = success ? 'rgba(167,139,250,0.08)' : 'rgba(239,68,68,0.08)';
  el.style.display    = '';
  setTimeout(() => { el.style.display = 'none'; }, 4000);
  // Clear all inputs on success
  if (success) {
    ['adminSetMoney','adminSetHealth','adminSetMaxHealth','adminSetStamina','adminSetMaxStamina'].forEach(id => {
      const inp = document.getElementById(id); if (inp) inp.value = '';
    });
    const qty = document.getElementById('adminItemQty'); if (qty) qty.value = '1';
    _selectedItemId = ''; _selectedItemName = '';
    const display = document.getElementById('adminSelectedItem');
    if (display) display.textContent = '— none selected —';
  }
}

// ─── Chat ─────────────────────────────────────────────────────────

let _chatTarget      = null;   // null = broadcast to all; string = player name for private
let _chatLastTs      = 0;      // timestamp of newest message we've rendered
let _chatPollTimer   = null;
let _chatPlayers     = [];     // cached online player names for pills
let _chatPlayersTs   = 0;      // last time we fetched players for chat
let _chatColor       = null;   // null = no color, 'rainbow', or color name string
let _chatRainbowIdx  = 0;      // cycles per send when rainbow active

// ── Chat color / emote constants ──────────────────────────────────
const CHAT_COLORS = [
  { name: 'white',       hex: '#ffffff' },
  { name: 'red',         hex: '#e05555' },
  { name: 'blue',        hex: '#5588e0' },
  { name: 'green',       hex: '#55bb55' },
  { name: 'jade',        hex: '#5fa880' },
  { name: 'yellowgreen', hex: '#9acd32' },
  { name: 'pink',        hex: '#ff8ab4' },
  { name: 'purple',      hex: '#b06aeb' },
  { name: 'yellow',      hex: '#e8d44d' },
  { name: 'orange',      hex: '#e87d30' },
  { name: 'brown',       hex: '#a0522d' },
  { name: 'gray',        hex: '#909090' },
  { name: 'cream',       hex: '#f5e6c8' },
  { name: 'salmon',      hex: '#fa8072' },
  { name: 'peach',       hex: '#ffcba4' },
  { name: 'aqua',        hex: '#00cccc' },
  { name: 'jungle',      hex: '#29ab87' },
  { name: 'plum',        hex: '#dda0dd' },
];
const CHAT_RAINBOW_SEQ = ['red','orange','yellow','green','aqua','blue','purple'];
const CHAT_EMOTES = [
  'happy','sad','surprise','angry','exclamation','heart',
  'note','question','sleep','taunt','laugh','cry','blush','x','yes','no',
];
const EMOTE_IDS = {
  happy:0, sad:4, surprise:8, angry:12, exclamation:16, heart:20,
  note:24, question:28, sleep:32, taunt:36, laugh:40, cry:44, blush:48, x:52, yes:56, no:60,
};

function initChatColorRow() {
  const row = document.getElementById('chatColorRow');
  if (!row || row.children.length) return;
  // "off" swatch
  const off = document.createElement('button');
  off.className = 'chat-color-swatch active'; off.dataset.color = '';
  off.style.background = 'var(--bg-tertiary)'; off.style.border = '1px solid var(--border)';
  off.title = 'No color'; off.textContent = 'A';
  off.onclick = () => setChatColor(null);
  row.appendChild(off);
  // Named color swatches
  for (const c of CHAT_COLORS) {
    const btn = document.createElement('button');
    btn.className = 'chat-color-swatch'; btn.dataset.color = c.name;
    btn.style.background = c.hex; btn.title = c.name;
    btn.onclick = () => setChatColor(c.name);
    row.appendChild(btn);
  }
  // Rainbow swatch
  const rb = document.createElement('button');
  rb.className = 'chat-color-swatch chat-color-rainbow'; rb.dataset.color = 'rainbow';
  rb.title = 'Rainbow'; rb.textContent = '🌈';
  rb.onclick = () => setChatColor('rainbow');
  row.appendChild(rb);
}

function initChatEmoteMenu() {
  const menu = document.getElementById('chatEmoteMenu');
  if (!menu || menu.children.length) return;
  for (const name of CHAT_EMOTES) {
    const btn = document.createElement('button');
    btn.className = 'chat-emote-item'; btn.textContent = name;
    btn.onclick = () => sendEmote(name);
    menu.appendChild(btn);
  }
}

function setChatColor(name) {
  _chatColor = name || null;
  // Update active swatch highlight
  document.querySelectorAll('.chat-color-swatch').forEach(el => {
    const match = name ? el.dataset.color === name : el.dataset.color === '';
    el.classList.toggle('active', match);
  });
}

function toggleEmoteMenu() {
  const menu = document.getElementById('chatEmoteMenu');
  if (!menu) return;
  const open = menu.style.display !== 'none';
  menu.style.display = open ? 'none' : 'grid';
  if (!open) document.getElementById('chatEmoteBtn').classList.add('active');
  else document.getElementById('chatEmoteBtn').classList.remove('active');
}

async function sendEmote(name) {
  document.getElementById('chatEmoteMenu').style.display = 'none';
  document.getElementById('chatEmoteBtn').classList.remove('active');

  const emoteId = EMOTE_IDS[name];
  if (emoteId === undefined) return;

  if (_chatTarget) {
    // DM mode — play on the target player only
    await API.post('/api/players/admin-command', {
      command: `stardrop_emote ${_chatTarget} ${emoteId}`,
    }).catch(() => null);
  } else {
    // World chat — play on every online non-host farmhand
    const farmhands = (_lastPlayersData?.players || []).filter(p => !p.isHost);
    await Promise.all(farmhands.map(p =>
      API.post('/api/players/admin-command', {
        command: `stardrop_emote ${p.name} ${emoteId}`,
      }).catch(() => null)
    ));
  }
}

// Close emote menu when clicking outside
document.addEventListener('click', e => {
  const menu = document.getElementById('chatEmoteMenu');
  const btn  = document.getElementById('chatEmoteBtn');
  if (menu && btn && !menu.contains(e.target) && e.target !== btn) {
    menu.style.display = 'none';
    btn.classList.remove('active');
  }
});

function renderChatPlayerPills() {
  const row = document.getElementById('chatPlayerPills');
  if (!row) return;
  const worldActive = (_chatTarget === null) ? ' active' : '';
  let html = `<button class="chat-pill${worldActive}" onclick="clearChatTarget()">World Chat</button>`;
  if (_chatPlayers.length > 0) {
    html += `<span class="chat-dm-separator">Private Chats</span>`;
    for (const name of _chatPlayers) {
      const active = (_chatTarget === name) ? ' active' : '';
      html += `<button class="chat-pill chat-pill-dm${active}" onclick="setChatTarget('${escapeHtml(name)}')">${escapeHtml(name)}</button>`;
    }
  }
  row.innerHTML = html;
}

function setChatTarget(name) {
  _chatTarget = name;
  _chatLastTs = 0;
  const label = document.getElementById('chatTargetLabel');
  label.textContent = `Private Chat — ${name}`;
  label.classList.add('dm-active');
  document.getElementById('chatInput').placeholder = `Message ${name}…`;
  document.getElementById('chatInput').focus();
  const feed = document.getElementById('chatFeed');
  if (feed) feed.innerHTML = '<div class="empty-state" id="chatEmpty">Loading…</div>';
  renderChatPlayerPills();
  loadChatMessages();
}

function clearChatTarget() {
  _chatTarget = null;
  _chatLastTs = 0;
  const label = document.getElementById('chatTargetLabel');
  label.textContent = 'World Chat';
  label.classList.remove('dm-active');
  document.getElementById('chatInput').placeholder = 'Message all players…';
  const feed = document.getElementById('chatFeed');
  if (feed) feed.innerHTML = '<div class="empty-state" id="chatEmpty">Loading…</div>';
  renderChatPlayerPills();
  loadChatMessages();
}

// Parse [colorname]text tags into colored <span> elements for display in the feed
function renderChatText(raw) {
  if (!raw) return '';
  const colorMap = Object.fromEntries(CHAT_COLORS.map(c => [c.name, c.hex]));
  const parts    = raw.split(/(\[[a-z]+\])/i);
  let html    = '';
  let inColor = false;
  for (const part of parts) {
    const m = part.match(/^\[([a-z]+)\]$/i);
    if (m) {
      const hex = colorMap[m[1].toLowerCase()];
      if (hex) {
        if (inColor) html += '</span>';
        html += `<span style="color:${hex}">`;
        inColor = true;
        continue;
      }
    }
    html += escapeHtml(part);
  }
  if (inColor) html += '</span>';
  return html;
}

async function loadChatMessages() {
  // Refresh player pills every ~10s — include online AND recent players
  if (Date.now() - _chatPlayersTs > 10000) {
    _chatPlayersTs = Date.now();
    const pd = await API.get('/api/players').catch(() => null);
    if (pd) {
      const onlineNames = (pd.players || []).filter(p => !p.isHost).map(p => p.name).filter(Boolean);
      const recentNames = (pd.recentPlayers || []).map(p => p.name).filter(Boolean);
      // Merge: online first, then recent, deduplicated
      const merged = [...new Set([...onlineNames, ...recentNames])];
      if (JSON.stringify(merged) !== JSON.stringify(_chatPlayers)) {
        _chatPlayers = merged;
        // Never auto-clear DM target — let user navigate away manually
        renderChatPlayerPills();
      }
    }
  }

  const wasFirstLoad = (_chatLastTs === 0);

  const data = await API.get(`/api/chat/messages?since=${_chatLastTs}&limit=100`).catch(() => null);

  const feed = document.getElementById('chatFeed');
  if (!feed) return;

  if (!data?.messages?.length) {
    if (wasFirstLoad) {
      const emptyMsg = _chatTarget
        ? `No private messages with ${escapeHtml(_chatTarget)} yet.`
        : 'No messages yet — chat from connected players will appear here.';
      feed.innerHTML = `<div class="empty-state" id="chatEmpty">${emptyMsg}</div>`;
    }
    return;
  }

  const empty = document.getElementById('chatEmpty');
  if (empty) empty.remove();

  let renderedCount = 0;
  for (const msg of data.messages) {
    if (msg.ts <= _chatLastTs) continue;
    _chatLastTs = msg.ts;

    const isDm = msg.to && msg.to !== 'all';

    if (_chatTarget) {
      // DM view: show messages to/from this player only
      if (msg.from !== _chatTarget && msg.to !== _chatTarget) continue;
    } else {
      // World chat view: hide private messages — they belong in DM tabs only
      if (isDm) continue;
    }

    const el = document.createElement('div');
    el.className = 'chat-msg' + (msg.isHost ? ' chat-msg-host' : '');

    const time = new Date(msg.ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    let meta;
    if (_chatTarget && msg.isHost && isDm) {
      // In DM tab: host message shows as "You" with recipient tag
      meta = `<span class="chat-dm-sent">You → ${escapeHtml(msg.to)}</span>`;
    } else if (_chatTarget && !msg.isHost && msg.from === _chatTarget) {
      // In DM tab: player's message
      meta = escapeHtml(msg.from);
    } else {
      meta = escapeHtml(msg.from);
    }

    el.innerHTML = `<span class="chat-meta">${meta} <span class="chat-time">${time}</span></span><span class="chat-text">${renderChatText(msg.message)}</span>`;
    feed.appendChild(el);
    renderedCount++;
  }

  if (renderedCount === 0 && !feed.querySelector('.chat-msg')) {
    const emptyMsg = _chatTarget
      ? `No private messages with ${escapeHtml(_chatTarget)} yet.`
      : 'No messages yet — chat from connected players will appear here.';
    feed.innerHTML = `<div class="empty-state" id="chatEmpty">${emptyMsg}</div>`;
    return;
  }

  if (wasFirstLoad || feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80) {
    feed.scrollTop = feed.scrollHeight;
  }
}

async function sendChatMessage() {
  const input = document.getElementById('chatInput');
  let message = input.value.trim();
  if (!message) return;

  // Apply color prefix (skip if message is a /command)
  if (_chatColor && !message.startsWith('/')) {
    if (_chatColor === 'rainbow') {
      message = `[${CHAT_RAINBOW_SEQ[_chatRainbowIdx % CHAT_RAINBOW_SEQ.length]}]${message}`;
      _chatRainbowIdx++;
    } else {
      message = `[${_chatColor}]${message}`;
    }
  }

  input.disabled = true;
  const data = await API.post('/api/chat/send', { message, to: _chatTarget || 'all' }).catch(() => null);
  input.disabled = false;

  if (data?.success) {
    input.value = '';
    // Poll immediately to pick up the host's message from the log
    setTimeout(loadChatMessages, 300);
  } else {
    showToast(data?.error || 'Failed to send message', 'error');
  }
  input.focus();
}

// Allow Enter key to send
document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('chatInput');
  if (input) input.addEventListener('keydown', e => { if (e.key === 'Enter') sendChatMessage(); });
});

// ─── Saves ───────────────────────────────────────────────────────
async function loadSaves() {
  const [savesData, backupsData] = await Promise.all([
    API.get('/api/saves'),
    API.get('/api/saves/backups'),
  ]);

  if (savesData) {
    const list = document.getElementById('savesList');
    if (!savesData.saves?.length) {
      list.innerHTML = '<div class="empty-state">No save files found</div>';
    } else {
      list.innerHTML = savesData.saves.map(s => `
        <div class="save-item">
          <div class="save-info">
            <div class="save-name">
              ${icon('sprout', 'icon save-name-icon')}
              <span>${escapeHtml(s.farmName || s.name)}</span>
              ${s.isSelected ? '<span class="save-badge">Active</span>' : ''}
            </div>
            <div class="save-meta">
              ${s.season ? `${escapeHtml(s.season)} ${s.day}, Year ${s.year} · ` : ''}
              ${formatSize(s.size)} · ${s.lastModified ? new Date(s.lastModified).toLocaleString() : 'unknown'}
            </div>
          </div>
          <div class="save-actions">
            ${!s.isSelected ? `<button class="btn btn-sm" data-save-name="${escapeHtml(s.name)}">Select</button>` : ''}
            ${!s.isSelected ? `<button class="btn btn-sm save-delete-btn" style="color:#ef4444;border-color:#ef4444"
              data-save-name="${escapeHtml(s.name)}" data-farm="${escapeHtml(s.farmName || s.name)}">
              ${icon('trash', 'icon')}</button>` : ''}
          </div>
        </div>
      `).join('');

      list.querySelectorAll('[data-save-name]').forEach(btn => {
        if (btn.classList.contains('save-delete-btn')) {
          btn.onclick = () => deleteSave(btn.dataset.saveName, btn.dataset.farm);
        } else {
          btn.onclick = () => selectSave(btn.dataset.saveName);
        }
      });
    }
  }

  if (backupsData) {
    const list = document.getElementById('backupsList');
    if (!backupsData.backups?.length) {
      list.innerHTML = '<div class="empty-state">No backups found</div>';
    } else {
      list.innerHTML = backupsData.backups.map(b => `
        <div class="backup-item">
          <div class="save-info">
            <div class="save-name">${icon('package', 'icon save-name-icon')}<span>${escapeHtml(b.filename)}</span></div>
            <div class="save-meta">${formatSize(b.size)} · ${new Date(b.date).toLocaleString()}</div>
          </div>
          <div style="display:flex;gap:6px">
            <a class="btn btn-sm btn-primary" href="/api/saves/backups/${encodeURIComponent(b.filename)}?token=${API.token}"
               download="${escapeHtml(b.filename)}">${icon('download', 'icon')}</a>
            <button class="btn btn-sm" style="color:#ef4444;border-color:#ef4444"
               onclick="deleteBackup('${escapeHtml(b.filename)}')">${icon('trash', 'icon')}</button>
          </div>
        </div>
      `).join('');
    }
  }
}

async function handleSaveUpload(input) {
  if (!input.files?.[0]) return;
  const file = input.files[0];
  if (!file.name.endsWith('.zip'))   { showToast('Only .zip files supported', 'error'); return; }
  if (file.size > 40 * 1024 * 1024) { showToast('File too large (max 40MB)', 'error'); return; }

  const setAsDefault = document.getElementById('saveUploadSetDefault').checked;
  setText('saveUploadStatus', 'Uploading...');

  try {
    const reader = new FileReader();
    reader.onload = async () => {
      const data = await API.post('/api/saves/upload', {
        filename:     file.name,
        data:         reader.result.split(',')[1],
        setAsDefault,
      });
      setText('saveUploadStatus', '');
      input.value = '';
      if (data?.success) {
        let msg = 'Save uploaded.';
        if (data.defaultApplied)  msg = 'Save uploaded and set as active.';
        if (data.defaultSkipped)  msg += ' Multiple saves found — active save unchanged.';
        if (data.overwriteBackup) msg += ` Pre-overwrite backup: ${data.overwriteBackup}.`;
        msg += ' Restart the container to apply.';
        showToast(msg, 'success');
        loadSaves();
      } else {
        showToast(data?.error || 'Upload failed', 'error');
      }
    };
    reader.readAsDataURL(file);
  } catch (e) {
    setText('saveUploadStatus', '');
    showToast('Upload failed', 'error');
  }
}

async function selectSave(saveName) {
  if (!confirm(`Switch to save "${saveName}"? The server will restart.`)) return;
  const data = await API.post('/api/saves/select', { saveName });
  if (data?.success) {
    loadSaves();
    await triggerGameRestart();
  } else {
    showToast(data?.error || 'Failed to select save', 'error');
  }
}

async function deleteSave(saveName, farmName) {
  const label = farmName || saveName;
  const wantBackup = confirm(`Back up "${label}" before deleting?`);
  if (wantBackup) {
    showToast('Creating backup...', 'info');
    await API.post('/api/saves/backups', {});
    // Wait briefly for backup to start
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!confirm(`Permanently delete save "${label}"? This cannot be undone.`)) return;
  const data = await API.del(`/api/saves/${encodeURIComponent(saveName)}`);
  if (data?.success) { showToast('Save deleted', 'success'); loadSaves(); }
  else showToast(data?.error || 'Delete failed', 'error');
}

async function deleteBackup(filename) {
  if (!confirm(`Delete backup ${filename}?`)) return;
  const data = await API.del(`/api/saves/backups/${encodeURIComponent(filename)}`);
  if (data?.success) { showToast('Backup deleted', 'success'); loadSaves(); }
  else showToast(data?.error || 'Delete failed', 'error');
}

// ─── Backup status polling ────────────────────────────────────────
async function loadBackupStatus(silent = false) {
  const data = await API.get('/api/saves/backups/status');
  if (data) applyBackupStatus(data, silent);
}

function applyBackupStatus(status, silent = false) {
  const prevState  = lastBackupStatus?.state;
  lastBackupStatus = status;

  // If the backup was already completed before we started watching, don't show the banner
  if (status?.state === 'completed' && prevState !== 'running') {
    lastBackupStatus = null;
    renderBackupStatus({ state: 'idle' });
    stopBackupStatusPolling();
    return;
  }

  renderBackupStatus(status);

  if (status?.state === 'running') { startBackupStatusPolling(); return; }

  stopBackupStatusPolling();

  if (prevState === 'running' && status?.state === 'completed') {
    if (!silent) showToast('Backup created!', 'success');
    setTimeout(() => {
      lastBackupStatus = null;
      renderBackupStatus({ state: 'idle' });
    }, 10000);
  }

  if (!silent && prevState === 'running' && status?.state === 'failed') {
    showToast(status.error || 'Backup failed', 'error');
  }

  if (status?.state !== 'running') {
    loadDashboard();
    if (currentPage === 'saves') loadSaves();
  }
}

function renderBackupStatus(status) {
  const active = status?.state && status.state !== 'idle';
  ['savesBackupStatus'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (!active) { el.style.display = 'none'; el.innerHTML = ''; return; }

    const tone  = status.state === 'failed' ? 'error' : status.state === 'completed' ? 'success' : 'running';
    const title = status.state === 'failed' ? 'Backup failed' : status.state === 'completed' ? 'Backup complete' : 'Backup in progress...';
    const progress = status.state === 'running'
      ? `<div class="backup-progress"><div class="backup-progress-fill" style="width:${Math.max(1, status.progress || 0)}%"></div></div>` : '';
    const meta = [];
    if (status.state === 'running' && status.totalEntries > 0)
      meta.push(`${status.processedEntries}/${status.totalEntries} · ${status.progress}%`);
    if (status.backupName) meta.push(status.backupName);
    if (status.state === 'completed' && status.size) meta.push(formatSize(status.size));

    el.className     = `backup-status ${tone}`;
    el.style.display = '';
    el.innerHTML     =
      `<div class="backup-status-title">${escapeHtml(title)}</div>${progress}` +
      (meta.length ? `<div class="backup-status-meta">${escapeHtml(meta.join(' · '))}</div>` : '') +
      (status.error ? `<div class="backup-status-error">${escapeHtml(status.error)}</div>` : '');
  });

  document.querySelectorAll('.backup-action-btn').forEach(btn => {
    btn.disabled = status?.state === 'running';
  });
}

function startBackupStatusPolling() {
  if (!backupStatusPoll)
    backupStatusPoll = setInterval(() => loadBackupStatus(true), 2000);
}

function stopBackupStatusPolling() {
  if (backupStatusPoll) { clearInterval(backupStatusPoll); backupStatusPoll = null; }
}

// ─── Server Mode Card ────────────────────────────────────────────
async function loadServerModeCard() {
  const card = document.getElementById('serverModeCard');
  if (!card) return;
  card.innerHTML = `
    <div>
      <div style="font-weight:600;font-size:15px;margin-bottom:4px">Server Mode</div>
      <div style="font-size:13px;color:var(--text-secondary)">LAN — players join via the server IP on a local network or VPN tunnel (e.g. Tailscale, ZeroTier).</div>
    </div>
  `;
}

// ─── Config ──────────────────────────────────────────────────────

// Builds a config row element for a single config item
function _buildConfigRow(item) {
  const row = document.createElement('div');
  row.className = 'config-item';
  let valueHtml;
  if (item.readonly) {
    valueHtml = `<span style="color:var(--text-muted)">${item.sensitive ? '••••••••' : escapeHtml(item.value || '--')}</span>`;
  } else if (item.type === 'boolean') {
    const checked = item.value === 'true' ? 'checked' : '';
    valueHtml = `<label class="toggle"><input type="checkbox" data-key="${item.key}" ${checked} onchange="configChanged()"><span class="toggle-slider"></span></label>`;
  } else if (item.options?.length) {
    const opts = item.options.map(o => {
      const val = typeof o === 'object' ? o.value : o;
      const lbl = typeof o === 'object' ? o.label : (o || 'Auto-detect');
      const sel = val === (item.value ?? '') ? ' selected' : '';
      return `<option value="${escapeHtml(val)}"${sel}>${escapeHtml(lbl)}</option>`;
    }).join('');
    valueHtml = `<select class="input" data-key="${item.key}" style="width:220px" onchange="configChanged()">${opts}</select>`;
  } else if (item.viewable) {
    valueHtml = `<div class="password-wrapper">
      <input type="password" class="input" data-key="${item.key}" value="${escapeHtml(item.value || '')}"
        placeholder="${escapeHtml(item.default || '')}"${item.maxLength ? ` maxlength="${item.maxLength}"` : ''}
        style="width:150px" oninput="configChanged()">
      <button type="button" class="password-toggle" onclick="togglePasswordVisibility(this)" title="Show password">
        ${icon('eye', 'icon')}</button></div>`;
  } else if (item.type === 'timezone') {
    valueHtml = `<div class="tz-picker" id="cfg-tz-${item.key}" style="width:260px"></div>`;
  } else if (item.sensitive) {
    valueHtml = `<input type="password" class="input" data-key="${item.key}" placeholder="••••••••" style="width:150px" onchange="configChanged()">`;
  } else {
    valueHtml = `<input type="${item.type === 'number' ? 'number' : 'text'}" class="input" data-key="${item.key}"
      value="${escapeHtml(item.value || '')}" placeholder="${escapeHtml(item.default || '')}"
      style="width:150px" oninput="configChanged()">`;
  }
  row.innerHTML =
    `<div>
      <div class="config-label">${escapeHtml(item.label)}</div>
      ${item.description ? `<div class="config-help">${escapeHtml(item.description)}</div>` : ''}
    </div>
    <div class="config-value">${valueHtml}</div>`;
  return row;
}

async function loadConfig() {
  const data = await API.get('/api/config');
  if (!data) return;

  const container    = document.getElementById('configContainer');
  const containerTop = document.getElementById('configContainerTop');
  const advHolder    = document.getElementById('advancedHolder');
  container.innerHTML    = '';
  if (containerTop) containerTop.innerHTML = '';
  if (advHolder)    advHolder.innerHTML    = '';

  const TOP_GROUPS      = new Set(['Server']);
  const ADVANCED_GROUPS = new Set(['VNC & Display', 'Stability', 'Monitoring']);

  const deferredTzPickers = [];

  for (const group of data.groups) {
    if (ADVANCED_GROUPS.has(group.name)) continue; // handled separately below

    const target = (containerTop && TOP_GROUPS.has(group.name)) ? containerTop : container;

    const card = document.createElement('div');
    card.className = 'card config-group';
    card.innerHTML = `<div class="config-group-title">${escapeHtml(group.name)}</div>`;

    for (const item of group.items) {
      const row = _buildConfigRow(item);
      if (item.type === 'timezone') {
        deferredTzPickers.push({ id: `cfg-tz-${item.key}`, value: item.value || item.default || 'UTC', key: item.key });
      }
      card.appendChild(row);
    }

    // Server group: prepend status indicators + update notifications + actions
    if (group.name === 'Server') {
      const running     = lastStatusData !== null && !!(lastStatusData.gameRunning);
      const liveRunning = lastStatusData?.live?.serverState === 'running';
      const bootStarting = lastStatusData !== null && !running && !lastStatusData.stoppedByUser && (lastStatusData.containerUptime || 0) < 90;
      const stopping    = isStopping;
      const starting    = isStarting || isGameRestarting || bootStarting || (running && !liveRunning);
      const realStopped = lastStatusData !== null && !running && !isGameRestarting && !isStarting && !bootStarting;
      const statusText  = lastStatusData === null ? 'Loading…'
        : stopping ? 'Stopping…' : isGameRestarting ? 'Restarting…' : starting ? 'Starting…'
        : running ? 'Running' : 'Stopped';
      const statusCls   = lastStatusData === null ? 'restarting'
        : realStopped ? 'offline' : (stopping || isGameRestarting || starting) ? 'restarting' : 'running';

      let remText, remCls;
      if (_remoteOptimisticState === 'starting') {
        remText = 'Starting'; remCls = 'restarting';
      } else if (_remoteOptimisticState === 'stopping') {
        remText = 'Stopping'; remCls = 'restarting';
      } else if (!lastRemoteData?.configured) {
        remText = 'Not Setup'; remCls = 'offline';
      } else if (lastRemoteData.anyRunning) {
        remText = 'Connected'; remCls = 'running';
      } else {
        remText = 'Stopped'; remCls = 'offline';
      }

      const _dis  = isTransitioning ? ' disabled' : '';
      const _rdis = _remoteOptimisticState ? ' disabled' : '';

      const statusRow = document.createElement('div');
      statusRow.className = 'config-item';
      statusRow.innerHTML =
        `<div><div class="config-label">Server Status</div></div>
         <div class="config-value" style="gap:8px">
           <span id="configServerStatusBadge" style="display:inline-flex;align-items:center;gap:6px;font-weight:600;color:var(--text-primary)">
             <span class="status-dot ${statusCls}"></span>${escapeHtml(statusText)}
           </span>
           <button id="serverToggleBtn" class="btn btn-sm ${running ? 'btn-danger' : 'btn-success'}" type="button"
             onclick="${running ? 'stopServer()' : 'startServer()'}"${_dis}>${running ? 'Stop' : 'Start'}</button>
           <button class="btn btn-sm btn-warning" type="button" onclick="restartServer()"${_dis}>Restart</button>
         </div>`;

      const remBtnHtml = !lastRemoteData?.configured
        ? `<button class="btn btn-sm btn-secondary" type="button" onclick="navigateTo('remote')">Setup</button>`
        : lastRemoteData.anyRunning
          ? `<button class="btn btn-sm btn-secondary" type="button" onclick="stopRemoteService()"${_rdis}>Pause</button>`
          : `<button class="btn btn-sm btn-success" type="button" onclick="startRemoteService()"${_rdis}>Resume</button>`;

      const remoteRow = document.createElement('div');
      remoteRow.className = 'config-item';
      remoteRow.innerHTML =
        `<div><div class="config-label">Remote Status</div></div>
         <div class="config-value" style="gap:8px">
           <span id="configRemoteStatusBadge" style="display:inline-flex;align-items:center;gap:6px;font-weight:600;color:var(--text-primary)">
             <span class="status-dot ${remCls}"></span>${escapeHtml(remText)}
           </span>
           ${remBtnHtml}
         </div>`;

      card.insertBefore(remoteRow, card.firstChild.nextSibling);
      card.insertBefore(statusRow, card.firstChild.nextSibling);

      const cfgPanelNotif = document.createElement('div');
      cfgPanelNotif.id = 'configPanelUpdateNotif';
      cfgPanelNotif.style.display = 'none';
      card.appendChild(cfgPanelNotif);

      const cfgGameNotif = document.createElement('div');
      cfgGameNotif.id = 'configGameUpdateNotif';
      cfgGameNotif.style.display = 'none';
      card.appendChild(cfgGameNotif);

      // Check for Updates — own config-item row
      const updateRow = document.createElement('div');
      updateRow.className = 'config-item';
      updateRow.innerHTML =
        `<div><div class="config-label">Check for Updates</div>
              <div class="config-help">Checks for StardropHost panel and game updates.</div></div>
         <div class="config-value">
           <button class="btn btn-sm btn-secondary" type="button" onclick="checkAllUpdates()">Check Now</button>
         </div>`;
      card.appendChild(updateRow);
    }

    target.appendChild(card);

    for (const p of deferredTzPickers.splice(0)) {
      buildTzPicker(p.id, p.value);
      const hidden = document.getElementById(`${p.id}-val`);
      if (hidden) { hidden.dataset.key = p.key; hidden.addEventListener('change', configChanged); }
      const searchEl = document.getElementById(`${p.id}-search`);
      if (searchEl) searchEl.addEventListener('input', configChanged);
    }
  }

  // ── Advanced section (VNC, Stability, Monitoring) ──────────────
  if (advHolder) {
    const details = document.createElement('details');
    details.className = 'advanced-details';

    const summary = document.createElement('summary');
    summary.innerHTML = `Advanced Settings <span style="font-size:12px;color:var(--text-muted);font-weight:400;margin-left:6px">VNC · Stability · Monitoring</span>`;
    details.appendChild(summary);

    const advInner = document.createElement('div');
    advInner.style.cssText = 'padding-top:12px;display:flex;flex-direction:column;gap:12px';

    // VNC card — loadVnc() fills #vncPanel after we append to DOM
    const vncCard = document.createElement('div');
    vncCard.className = 'card';
    vncCard.innerHTML = '<h3>VNC &amp; Display Settings</h3><div id="vncPanel"><div class="empty-state">Loading VNC status...</div></div>';
    advInner.appendChild(vncCard);

    // Stability and Monitoring cards
    for (const group of data.groups) {
      if (!ADVANCED_GROUPS.has(group.name) || group.name === 'VNC & Display') continue;
      const card = document.createElement('div');
      card.className = 'card config-group';
      card.innerHTML = `<div class="config-group-title">${escapeHtml(group.name)}</div>`;
      for (const item of group.items) card.appendChild(_buildConfigRow(item));
      advInner.appendChild(card);
    }

    details.appendChild(advInner);
    advHolder.appendChild(details);

    // vncPanel is now in DOM — load VNC content
    loadVnc();
  }

}

function configChanged() {
  const btn = document.getElementById('saveConfigBtn');
  if (btn) btn.style.display = '';
}

function togglePasswordVisibility(btn) {
  const input = btn.parentElement.querySelector('input');
  const show  = input.type === 'password';
  input.type  = show ? 'text' : 'password';
  btn.innerHTML = icon(show ? 'eye-off' : 'eye', 'icon');
  btn.title     = show ? 'Hide password' : 'Show password';
}

async function saveConfig() {
  const updates = {};
  document.querySelectorAll('[data-key]').forEach(el => {
    updates[el.dataset.key] = el.type === 'checkbox' ? String(el.checked) : el.value;
  });
  if (!Object.keys(updates).length) return;

  const data = await API.put('/api/config', updates);
  if (data?.success) {
    document.getElementById('saveConfigBtn').style.display = 'none';
    showRestartModal('Configuration saved. Restart the container to apply changes.');
  } else {
    showToast(data?.error || 'Failed to save config', 'error');
  }
}

// ─── VNC ─────────────────────────────────────────────────────────
async function loadVnc() {
  const [vnc, cfg] = await Promise.all([
    API.get('/api/vnc/status'),
    API.get('/api/config'),
  ]);
  const panel = document.getElementById('vncPanel');
  if (!panel) return;

  const vncGroup = cfg?.groups?.find(g => g.name === 'VNC & Display');

  // Build config rows for VNC & Display settings
  let cfgRows = '';
  if (vncGroup) {
    for (const item of vncGroup.items) {
      let ctrl = '';
      if (item.type === 'boolean') {
        const chk = item.value === 'true' ? 'checked' : '';
        ctrl = `<label class="toggle"><input type="checkbox" data-key="${item.key}" ${chk} onchange="configChanged()"><span class="toggle-slider"></span></label>`;
      } else if (item.options?.length) {
        const opts = item.options.map(o => {
          const val = typeof o === 'object' ? o.value : o;
          const lbl = typeof o === 'object' ? o.label : o;
          return `<option value="${escapeHtml(val)}"${val === (item.value ?? '') ? ' selected' : ''}>${escapeHtml(lbl)}</option>`;
        }).join('');
        ctrl = `<select class="input" data-key="${item.key}" style="width:180px" onchange="configChanged()">${opts}</select>`;
      } else if (item.viewable) {
        ctrl = `<div class="password-wrapper">
          <input type="password" class="input" data-key="${item.key}" value="${escapeHtml(item.value || '')}"
            placeholder="${escapeHtml(item.default || '')}"${item.maxLength ? ` maxlength="${item.maxLength}"` : ''}
            style="width:150px" oninput="configChanged()">
          <button type="button" class="password-toggle" onclick="togglePasswordVisibility(this)" title="Show password">
            ${icon('eye','icon')}</button></div>`;
      } else {
        ctrl = `<input type="${item.type === 'number' ? 'number' : 'text'}" class="input" data-key="${item.key}"
          value="${escapeHtml(item.value || '')}" placeholder="${escapeHtml(item.default || '')}"
          style="width:150px" oninput="configChanged()">`;
      }
      cfgRows += `<div class="config-item">
        <div>
          <div class="config-label">${escapeHtml(item.label)}</div>
          ${item.description ? `<div class="config-help">${escapeHtml(item.description)}</div>` : ''}
        </div>
        <div class="config-value">${ctrl}</div>
      </div>`;
    }
  }

  panel.innerHTML = `
    <div class="details-grid" style="margin-bottom:12px">
      <div class="detail-item">
        <div class="detail-label">Connection Status</div>
        <div class="detail-value" style="color:${vnc?.enabled ? 'var(--accent)' : 'var(--text-muted)'}">
          ${vnc?.enabled ? '● Running' : '○ Stopped'}
        </div>
      </div>
      <div class="detail-item">
        <div class="detail-label">VNC Port</div>
        <div class="detail-value">${vnc?.port || 5900}/TCP</div>
      </div>
    </div>
    <div class="action-buttons" style="margin-bottom:16px">
      ${vnc?.enabled
        ? `<button class="btn btn-sm" style="color:#ef4444;border-color:#ef4444" onclick="vncDisable()">Stop VNC</button>`
        : `<button class="btn btn-sm btn-success" onclick="vncEnable()">Start VNC Now</button>`}
    </div>
    <details style="margin-top:4px">
      <summary style="font-size:13px;color:var(--text-muted);cursor:pointer;user-select:none">
        Display &amp; Password Settings
      </summary>
      <div class="config-group" style="margin-top:12px">${cfgRows}</div>
    </details>
  `;
}

function showVncPasswordForm() {
  document.getElementById('vncPasswordForm').style.display = '';
}

async function vncEnable() {
  const data = await API.post('/api/vnc/enable');
  if (data?.success) { showToast('VNC enabled', 'success'); loadVnc(); }
  else showToast(data?.error || 'Failed to enable VNC', 'error');
}

async function vncDisable() {
  if (!confirm('Disable VNC? Active connections will be dropped.')) return;
  const data = await API.post('/api/vnc/disable');
  if (data?.success) { showToast('VNC disabled', 'success'); setTimeout(loadVnc, 1500); }
  else showToast(data?.error || 'Failed to disable VNC', 'error');
}

async function setVncOneTimePassword() {
  const password = document.getElementById('vncOtpInput').value;
  if (!password) return;
  const data = await API.post('/api/vnc/password', { password });
  if (data?.success) {
    showToast('One-time VNC password set', 'success');
    document.getElementById('vncPasswordForm').style.display = 'none';
    loadVnc();
  } else {
    showToast(data?.error || 'Failed to set password', 'error');
  }
}

// ─── Mods ────────────────────────────────────────────────────────
function _renderModItem(m) {
  return `
    <div class="mod-item">
      <div class="mod-info">
        <div class="mod-name">${escapeHtml(m.name)}</div>
        <div class="mod-meta">v${escapeHtml(m.version)} · ${escapeHtml(m.author || '')}</div>
        ${m.description ? `<div class="mod-meta">${escapeHtml(m.description)}</div>` : ''}
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        ${m.pendingInstall
          ? '<span class="mod-badge" style="background:#f59e0b22;color:#f59e0b;border-color:#f59e0b55">Pending Install</span>'
          : ''}
        ${m.isCustom && !m.isBundled
          ? `<button class="btn btn-sm mod-delete-btn" style="color:#ef4444;border-color:#ef4444"
               data-folder="${escapeHtml(m.folder)}" data-name="${escapeHtml(m.name)}">
               ${icon('trash', 'icon')} Delete</button>`
          : ''}
      </div>
    </div>
  `;
}

async function loadMods() {
  const data = await API.get('/api/mods');
  if (!data) return;

  const badge = document.getElementById('smapi-version-badge');
  if (badge) badge.textContent = data.smapiVersion ? `SMAPI v${data.smapiVersion}` : '';

  setText('modUploadStatus', '');

  const bundled = (data.mods || []).filter(m => m.isBundled);
  const custom  = (data.mods || []).filter(m => !m.isBundled);

  const bundledList = document.getElementById('modsListBundled');
  if (bundledList) {
    bundledList.innerHTML = bundled.length
      ? bundled.map(_renderModItem).join('')
      : '<div class="empty-state">No bundled mods found</div>';
  }

  const list = document.getElementById('modsList');
  if (!list) return;
  list.innerHTML = custom.length
    ? custom.map(_renderModItem).join('')
    : '<div class="empty-state">No user mods installed</div>';

  list.querySelectorAll('.mod-delete-btn').forEach(btn => {
    btn.onclick = () => deleteMod(btn.dataset.folder, btn.dataset.name);
  });
}

async function handleModUpload(input) {
  if (!input.files?.[0]) return;
  const file = input.files[0];
  if (!file.name.endsWith('.zip'))   { showToast('Only .zip files supported', 'error'); return; }
  if (file.size > 50 * 1024 * 1024) { showToast('File too large (max 50MB)', 'error'); return; }

  setText('modUploadStatus', 'Uploading...');
  try {
    const data = await API.upload('/api/mods/upload', file);
    setText('modUploadStatus', '');
    input.value = '';

    if (data?.success) {
      const msg = data.hasManifest
        ? 'Mod installed. Restart the server to load it.'
        : data.autoInstallFailed
          ? 'Uploaded but auto-install failed. Restart may still install it.'
          : 'Uploaded but no manifest.json found — check archive structure.';
      showToast(msg, 'success');
      loadMods();
    } else {
      showToast(data?.error || 'Upload failed', 'error');
    }
  } catch (e) {
    setText('modUploadStatus', '');
    input.value = '';
    showToast('Upload failed: ' + (e.message || 'network error'), 'error');
  }
}

async function deleteMod(folder, name) {
  if (!confirm(`Delete mod "${name}"?`)) return;
  const data = await API.del(`/api/mods/${encodeURIComponent(folder)}`);
  if (data?.success) {
    showToast('Mod deleted. Restart the server to unload it.', 'success');
    loadMods();
  } else {
    showToast(data?.error || 'Delete failed', 'error');
  }
}

// ─── Actions ─────────────────────────────────────────────────────
async function triggerGameRestart() {
  isGameRestarting       = true;
  gameRestartInitiatedAt = Date.now();
  if (lastStatusData) updateDashboardUI(lastStatusData);
  const data = await API.post('/api/server/restart').catch(() => null);
  if (!data?.success) {
    isGameRestarting = false;
    showToast(data?.error || 'Restart failed', 'error');
    if (lastStatusData) updateDashboardUI(lastStatusData);
  } else {
    _pollServerState(true, 120000);
  }
}

async function restartServer() {
  if (!confirm('Restart the server?')) return;
  await triggerGameRestart();
}

async function startServer() {
  if (!confirm('Start the server?')) return;
  const data = await API.post('/api/server/start').catch(() => null);
  if (data?.success) {
    isStarting = true;
    if (lastStatusData) updateDashboardUI({ ...lastStatusData, stoppedByUser: false });
    showToast('Server starting...', 'info');
    _pollServerState(true, 60000);
  } else {
    showToast(data?.error || 'Failed to start server', 'error');
  }
}

async function stopServer() {
  if (!confirm('Stop the server? Players will be disconnected.')) return;
  const data = await API.post('/api/server/stop').catch(() => null);
  if (data?.success) {
    isStopping = true;
    if (lastStatusData) updateDashboardUI(lastStatusData);
    showToast('Server stopping...', 'info');
    // Log out of steam-auth on deliberate stop — modal will re-appear on next start
    API.post('/api/steam/logout').catch(() => null);
    _pollServerState(false, 35000);
  } else {
    showToast(data?.error || 'Failed to stop server', 'error');
  }
}

// Poll /api/status every 1.5s until target state is reached, then update UI.
// targetRunning=true waits for live save loaded; targetRunning=false waits for process gone.
async function _pollServerState(targetRunning, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const poll = async () => {
    const data = await API.get('/api/status').catch(() => null);
    if (data) updateDashboardUI(data);
    const reached = targetRunning
      ? data?.live?.serverState === 'running'
      : data && !data.gameRunning;
    if (reached) {
      if (targetRunning && !isGameRestarting) {
        showToast('Server is online', 'success');
      }
      return;
    }
    if (Date.now() < deadline) setTimeout(poll, 1500);
  };
  setTimeout(poll, 800);
}

async function toggleServer() {
  if (lastStatusData?.gameRunning) await stopServer();
  else await startServer();
}

function toggleRemote() {
  if (!lastRemoteData?.configured) { navigateTo('remote'); return; }
  if (lastRemoteData.anyRunning) stopRemoteService();
  else startRemoteService();
}

function updateServerToggleBtn(transitioning = false) {
  const btn = document.getElementById('serverToggleBtn');
  if (!btn) return;
  const running = !!(lastStatusData?.gameRunning);
  btn.textContent = running ? 'Stop Server' : 'Start Server';
  btn.className   = `btn btn-sm ${running ? 'btn-danger' : 'btn-success'}`;
  btn.onclick     = running ? stopServer : startServer;
  btn.disabled    = transitioning;
}

async function createBackup() {
  if (lastBackupStatus?.state === 'running') {
    showToast('A backup is already in progress', 'warn');
    startBackupStatusPolling();
    return;
  }
  const data = await API.post('/api/saves/backups');
  if (data?.success) {
    applyBackupStatus(data.status, true);
    startBackupStatusPolling();
    showToast(data.alreadyRunning ? 'Backup already in progress' : 'Backup started', 'success');
  } else {
    showToast(data?.error || 'Backup failed', 'error');
  }
}

async function changePassword() {
  const newUser = document.getElementById('newUsername')?.value?.trim();
  const oldPwd  = document.getElementById('oldPassword').value;
  const newPwd  = document.getElementById('newPassword').value;
  const confPwd = document.getElementById('confirmNewPassword')?.value;

  if (!oldPwd || !newPwd) { showToast('Please fill in required password fields', 'error'); return; }
  if (newPwd.length < 8) { showToast('New password must be at least 8 characters', 'error'); return; }
  if (confPwd !== undefined && newPwd !== confPwd) { showToast('New passwords do not match', 'error'); return; }
  if (newUser && !/^[a-zA-Z0-9_.-]{3,}$/.test(newUser)) {
    showToast('Username must be 3+ characters (letters, numbers, _ . -)', 'error'); return;
  }
  if (!confirm('Update admin credentials?')) return;

  const payload = { oldPassword: oldPwd, newPassword: newPwd };
  if (newUser) payload.newUsername = newUser;

  const data = await API.post('/api/auth/password', payload);
  if (data?.success) {
    if (data.token) { API.token = data.token; localStorage.setItem('panel_token', data.token); }
    if (document.getElementById('newUsername'))     document.getElementById('newUsername').value = '';
    if (document.getElementById('confirmNewPassword')) document.getElementById('confirmNewPassword').value = '';
    document.getElementById('oldPassword').value = '';
    document.getElementById('newPassword').value = '';
    showToast('Credentials updated', 'success');
    const card = document.getElementById('adminCredCard');
    if (card) card.removeAttribute('open');
  } else {
    showToast(data?.error || 'Update failed', 'error');
  }
}

// ─── Restart modal ────────────────────────────────────────────────
function showRestartModal(message) {
  const modal = document.getElementById('restartModal');
  setText('restartModalMessage', message || 'Restart the container for changes to take effect.');
  modal.style.display = '';
  modal.onclick = e => { if (e.target === modal) closeRestartModal(); };
}

function closeRestartModal() {
  document.getElementById('restartModal').style.display = 'none';
  const badge = document.getElementById('pendingRestartBadge');
  if (badge) badge.style.display = '';
}

function clearPendingRestart() {
  const badge = document.getElementById('pendingRestartBadge');
  if (badge) badge.style.display = 'none';
}

// ─── Factory Reset Modal ──────────────────────────────────────────
function openFactoryResetModal() {
  document.getElementById('frStep1').style.display = '';
  document.getElementById('frStep2').style.display = 'none';
  document.getElementById('frConfirmInput').value = '';
  const btn = document.getElementById('frConfirmBtn');
  btn.style.opacity = '0.4';
  btn.style.pointerEvents = 'none';
  document.getElementById('factoryResetModal').style.display = 'flex';
}

function closeFactoryResetModal() {
  document.getElementById('factoryResetModal').style.display = 'none';
}

function frNextStep() {
  document.getElementById('frStep1').style.display = 'none';
  document.getElementById('frStep2').style.display = '';
  document.getElementById('frConfirmInput').focus();
}

function frCheckInput() {
  const val = document.getElementById('frConfirmInput').value;
  const btn = document.getElementById('frConfirmBtn');
  const ok  = val === 'DELETE';
  btn.style.opacity      = ok ? '1' : '0.4';
  btn.style.pointerEvents = ok ? '' : 'none';
}

async function confirmFactoryReset() {
  const btn = document.getElementById('frConfirmBtn');
  btn.disabled = true;
  btn.textContent = 'Resetting...';

  const data = await API.post('/api/wizard/factory-reset');
  if (data?.success) {
    closeFactoryResetModal();
    showToast('Reset complete — restarting game and reloading wizard…', 'success');
    setTimeout(() => window.location.reload(), 2500);
  } else {
    showToast(data?.error || 'Reset failed', 'error');
    btn.disabled = false;
    btn.textContent = 'Delete Everything';
  }
}

async function confirmRestart() {
  const btn = document.getElementById('restartNowBtn');
  if (btn) btn.disabled = true;

  try {
    const data = await API.post('/api/container/restart');
    if (data?.success) {
      showToast('Container is restarting...', 'success');
      startContainerReconnectPolling();
      return;
    }
    showToast(data?.error || 'Restart failed', 'error');
  } catch {
    showToast('Container is restarting...', 'success');
    startContainerReconnectPolling();
    return;
  }

  if (btn) btn.disabled = false;
}

// Two-phase poll for update: wait for server to go DOWN, then wait for it to come back UP.
// Unlike container restart (which is instant), update.sh takes minutes — the server stays
// responsive while git pull + build runs, so we must not reload until it actually disconnects.
function startUpdateReconnectPolling() {
  if (containerReconnectPoll) clearInterval(containerReconnectPoll);
  let wentDown = false;
  const startedAt = Date.now();
  containerReconnectPoll = setInterval(async () => {
    let up = false;
    try {
      const res = await fetch('/api/auth/status', { cache: 'no-store' });
      up = res?.ok === true;
    } catch {}

    if (!up) {
      wentDown = true;
    } else if (wentDown) {
      clearInterval(containerReconnectPoll);
      window.location.reload();
      return;
    }
    if (Date.now() - startedAt > 300000) { clearInterval(containerReconnectPoll); window.location.reload(); }
  }, 2000);
}

function startContainerReconnectPolling() {
  closeRestartModal();
  clearPendingRestart();
  if (containerReconnectPoll) clearInterval(containerReconnectPoll);
  const startedAt = Date.now();
  containerReconnectPoll = setInterval(async () => {
    try {
      const res = await fetch('/api/auth/status', { cache: 'no-store' });
      if (res?.ok) { clearInterval(containerReconnectPoll); window.location.reload(); return; }
    } catch {}
    if (Date.now() - startedAt > 120000) { clearInterval(containerReconnectPoll); window.location.reload(); }
  }, 2000);
}

// ─── Game Update ──────────────────────────────────────────────────

let _guPollTimer = null;
let _guGuardAttempted = false;

function openGameUpdateModal() {
  // Reset to step 1
  _guGuardAttempted = false;
  document.getElementById('guStep1').style.display = '';
  document.getElementById('guStep2').style.display = 'none';
  document.getElementById('guStep3').style.display = 'none';
  document.getElementById('guUsername').value = '';
  document.getElementById('guPassword').value = '';
  if (document.getElementById('guGuardCode')) document.getElementById('guGuardCode').value = '';
  document.getElementById('gameUpdateModal').style.display = '';
}

function closeGameUpdateModal() {
  document.getElementById('gameUpdateModal').style.display = 'none';
  if (_guPollTimer) { clearTimeout(_guPollTimer); _guPollTimer = null; }
}

async function gameUpdateStart() {
  const username = document.getElementById('guUsername').value.trim();
  const password = document.getElementById('guPassword').value;
  if (!username || !password) { showToast('Enter your Steam username and password', 'error'); return; }

  const btn = document.getElementById('guStartBtn');
  btn.disabled = true;
  btn.textContent = 'Connecting...';

  document.getElementById('guStep1').style.display = 'none';
  document.getElementById('guStep3').style.display = '';
  document.getElementById('guStatus').textContent = 'Connecting to Steam...';
  document.getElementById('guLog').textContent = '';
  const doneBtn = document.getElementById('guDoneBtn');
  const restartBtn = document.getElementById('guRestartBtn');
  if (doneBtn)    doneBtn.style.display = 'none';
  if (restartBtn) restartBtn.style.display = 'none';

  await API.post('/api/game-update/start', { username, password });
  btn.disabled = false;
  btn.textContent = 'Update';
  _guStartPolling();
}

async function gameUpdateGuard() {
  const code = document.getElementById('guGuardCode').value.trim();
  if (!code) { showToast('Enter the Steam Guard code', 'error'); return; }

  const btn = document.getElementById('guGuardBtn');
  btn.disabled = true;
  btn.textContent = 'Submitting...';

  const username = document.getElementById('guUsername').value.trim();
  const password = document.getElementById('guPassword').value;

  _guGuardAttempted = true;
  document.getElementById('guStep2').style.display = 'none';
  document.getElementById('guStep3').style.display = '';
  document.getElementById('guStatus').textContent = 'Resuming download...';

  await API.post('/api/game-update/guard', { username, password, guardCode: code });
  btn.disabled = false;
  btn.textContent = 'Submit';
  _guStartPolling();
}

async function gameUpdateRestart() {
  const btn = document.getElementById('guRestartBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Restarting...'; }
  closeGameUpdateModal();
  await API.post('/api/server/restart').catch(() => null);
  showToast('Server restarting with updated game files...', 'success');
  _pollServerState(true, 120000);
}

function _guStartPolling() {
  if (_guPollTimer) clearTimeout(_guPollTimer);
  _guPoll();
}

async function _guPoll() {
  const data = await API.get('/api/game-update/status').catch(() => null);
  if (!data) { _guPollTimer = setTimeout(_guPoll, 3000); return; }

  const statusEl  = document.getElementById('guStatus');
  const logEl     = document.getElementById('guLog');
  const doneBtn   = document.getElementById('guDoneBtn');
  const restartBtn = document.getElementById('guRestartBtn');

  // Update log display (log is an array of lines)
  if (logEl && data.log?.length) {
    logEl.textContent = data.log.join('\n');
    logEl.scrollTop = logEl.scrollHeight;
  }

  const state = data.update?.state;

  if (state === 'guard_required') {
    // Switch to step 2 for guard code
    document.getElementById('guStep3').style.display = 'none';
    document.getElementById('guStep2').style.display = '';
    const guardBtn = document.getElementById('guGuardBtn');
    if (guardBtn) guardBtn.textContent = _guGuardAttempted ? 'Submit & Retry' : 'Submit';
    document.getElementById('guGuardCode').value = '';
    document.getElementById('guGuardCode').focus();
    return; // Stop polling — wait for user input
  }

  if (statusEl) {
    statusEl.textContent =
      state === 'downloading' ? 'Downloading game files...' :
      state === 'done'        ? 'Download complete!' :
      state === 'error'       ? `Error: ${data.update?.message || 'Unknown error'}` :
                                'Working...';
    statusEl.style.color = state === 'error' ? '#ef4444' : state === 'done' ? 'var(--accent)' : 'var(--accent)';
  }

  if (state === 'done') {
    if (doneBtn)    doneBtn.style.display = '';
    if (restartBtn) restartBtn.style.display = '';
    // Clear the dashboard notification
    const notif = document.getElementById('gameUpdateNotification');
    if (notif) notif.style.display = 'none';
    return; // Done — stop polling
  }

  if (state === 'error') {
    if (doneBtn) doneBtn.style.display = '';
    return; // Error — stop polling
  }

  // Keep polling while downloading
  _guPollTimer = setTimeout(_guPoll, 3000);
}

// ─── Self Update (Update StardropHost button) ─────────────────────

async function selfUpdate() {
  const btn = document.getElementById('selfUpdateConfirmBtn');
  if (btn) { btn.disabled = false; btn.textContent = 'Update Now'; }
  document.getElementById('selfUpdateModal').style.display = '';
}

function closeSelfUpdateModal() {
  document.getElementById('selfUpdateModal').style.display = 'none';
}

async function confirmSelfUpdate() {
  const btn = document.getElementById('selfUpdateConfirmBtn');
  btn.disabled = true;
  btn.textContent = 'Updating...';

  const data = await API.post('/api/server/update').catch(() => null);
  if (data?.success || data?.action === 'update') {
    closeSelfUpdateModal();
    // Show the full-screen loader with "Updating..." while the container rebuilds
    const loader = document.getElementById('app-loader');
    const loaderText = loader?.querySelector('.app-loader-text');
    if (loaderText) loaderText.textContent = 'Updating StardropHost...';
    const loaderSub = document.getElementById('app-loader-sub');
    if (loaderSub) { loaderSub.textContent = 'The dashboard may take up to a minute to load, if it doesn\'t, reload the page.'; loaderSub.style.display = 'block'; }
    if (loader) loader.classList.remove('hidden');
    const app = document.getElementById('app');
    if (app) app.style.display = 'none';
    startUpdateReconnectPolling();
  } else {
    showToast(data?.error || 'Update failed', 'error');
    btn.disabled = false;
    btn.textContent = 'Update Now';
  }
}

async function checkAllUpdates() {
  const btn = document.getElementById('checkUpdatesBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Checking...'; }

  await Promise.all([
    API.post('/api/game-update/check').catch(() => null),
    API.post('/api/panel-update/check').catch(() => null),
  ]);

  // Refresh status to pick up new check results
  await _pollServerState(false);

  if (btn) { btn.disabled = false; btn.textContent = 'Check for Updates'; }
  showToast('Update check complete', 'success');
}

// ─── Remote config reveal ─────────────────────────────────────────

function showConfigPasswordPrompt() {
  document.getElementById('remoteViewConfigBtn').style.display       = 'none';
  document.getElementById('remoteConfigPasswordArea').style.display  = '';
  document.getElementById('remoteConfigPasswordError').style.display = 'none';
  document.getElementById('remoteConfigPassword').value              = '';
  setTimeout(() => document.getElementById('remoteConfigPassword').focus(), 50);
}

function hideConfigPasswordPrompt() {
  document.getElementById('remoteConfigPasswordArea').style.display = 'none';
  document.getElementById('remoteViewConfigBtn').style.display      = '';
}

async function submitConfigPassword() {
  const input = document.getElementById('remoteConfigPassword');
  const errEl = document.getElementById('remoteConfigPasswordError');
  const password = input.value;
  if (!password) return;

  try {
    const res = await API.post('/api/auth/verify-password', { password });
    if (!res?.valid) {
      errEl.textContent = 'Incorrect password.';
      errEl.style.display = '';
      input.value = '';
      input.focus();
      return;
    }
  } catch {
    errEl.textContent = 'Verification failed.';
    errEl.style.display = '';
    return;
  }

  // Correct — reveal YAML
  hideConfigPasswordPrompt();
  document.getElementById('remoteViewConfigBtn').style.display = 'none'; // keep hidden while YAML visible
  const yamlEl = document.getElementById('remoteCurrentYaml');
  if (yamlEl) yamlEl.textContent = _remoteYaml;
  document.getElementById('remoteConfigYamlArea').style.display = '';

  // Start 60s countdown
  clearInterval(_configCountdownTimer);
  clearTimeout(_configRevealTimer);
  let remaining = 60;
  const countdownEl = document.getElementById('remoteConfigCountdown');
  if (countdownEl) countdownEl.textContent = remaining;
  _configCountdownTimer = setInterval(() => {
    remaining -= 1;
    if (countdownEl) countdownEl.textContent = remaining;
    if (remaining <= 0) clearInterval(_configCountdownTimer);
  }, 1000);
  _configRevealTimer = setTimeout(hideConfigYaml, 60000);
}

function hideConfigYaml() {
  clearTimeout(_configRevealTimer);
  clearInterval(_configCountdownTimer);
  _configRevealTimer    = null;
  _configCountdownTimer = null;
  const yamlArea = document.getElementById('remoteConfigYamlArea');
  const yamlEl   = document.getElementById('remoteCurrentYaml');
  if (yamlArea) yamlArea.style.display = 'none';
  if (yamlEl)   yamlEl.textContent     = '';
  document.getElementById('remoteViewConfigBtn').style.display = '';
}

// ─── Remote (tunnel compose management) ──────────────────────────

async function loadRemoteStatus() {
  const loading    = document.getElementById('remoteLoading');
  const noConfig   = document.getElementById('remoteNoConfig');
  const configured = document.getElementById('remoteConfigured');

  try {
    const data = await API.get('/api/remote/status');
    lastRemoteData         = data;
    _remoteOptimisticState = null;
    _updateRemoteBadge();

    if (loading)    loading.style.display    = 'none';
    if (noConfig)   noConfig.style.display   = data.configured ? 'none' : '';
    if (configured) configured.style.display = data.configured ? ''     : 'none';

    if (data.configured) {
      _renderRemoteServices(data.services || [], data.anyRunning);
      _remoteYaml = data.yaml || '';
      // Lock compose entry while a service is configured
      _lockComposeEntry(true);
    } else {
      _remoteYaml = '';
      hideConfigYaml();
      // Service was removed — re-enable compose entry
      _lockComposeEntry(false);
    }
  } catch {
    if (loading)    loading.style.display    = 'none';
    if (noConfig)   noConfig.style.display   = '';
    if (configured) configured.style.display = 'none';
  }
}

function _updateRemoteBadge() {
  // Derive display state: optimistic overrides actual
  let text, orbClass;
  if (_remoteOptimisticState === 'starting') {
    text = 'Starting'; orbClass = 'restarting';
  } else if (_remoteOptimisticState === 'stopping') {
    text = 'Stopping'; orbClass = 'restarting';
  } else if (!lastRemoteData?.configured) {
    text = 'Not Setup'; orbClass = 'offline';
  } else if (lastRemoteData.anyRunning) {
    text = 'Active'; orbClass = 'running';
  } else {
    text = 'Stopped'; orbClass = 'offline';
  }

  const iconEl = document.getElementById('stat-remote-icon');
  if (iconEl) iconEl.innerHTML = `<span class="status-orb ${orbClass}"></span>`;

  setText('stat-remote', text);

  const cfgEl = document.getElementById('configRemoteStatusBadge');
  if (cfgEl) cfgEl.innerHTML = `<span class="status-dot ${orbClass}"></span>${text}`;

  // Topbar remote badge — only visible when configured
  const remTopbar    = document.getElementById('remoteTopbarBadge');
  const remTopbarDot = document.getElementById('remoteTopbarDot');
  const remTopbarTxt = document.getElementById('remoteTopbarText');
  if (remTopbar) {
    remTopbar.style.display = lastRemoteData?.configured ? '' : 'none';
    remTopbar.className     = `status-badge ${orbClass}`;
    if (remTopbarDot) remTopbarDot.className  = `status-dot ${orbClass}`;
    if (remTopbarTxt) remTopbarTxt.textContent = 'Remote';
  }

  renderQuickActions();
}

function _renderRemoteServices(services, anyRunning) {
  const el       = document.getElementById('remoteServiceStatus');
  const startBtn = document.getElementById('remoteStartBtn');
  const stopBtn  = document.getElementById('remoteStopBtn');
  if (!el) return;

  if (startBtn) startBtn.style.display = anyRunning ? 'none' : '';
  if (stopBtn)  stopBtn.style.display  = anyRunning ? ''     : 'none';

  if (!services.length) {
    el.innerHTML = '<span style="color:var(--text-muted);font-size:13px">No services found in config.</span>';
    return;
  }

  el.innerHTML = services.map(s => {
    const running = s.running;
    const dot     = running ? 'running' : 'offline';
    const label   = running
      ? '<span style="font-weight:500;color:#22c55e">Active</span>'
      : '<span style="font-weight:500;color:var(--text-muted)">Stopped</span>';
    return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
      <span class="status-dot ${dot}"></span>
      <span style="font-size:13px;color:var(--text-secondary);font-family:monospace">${s.name}</span>
      ${label}
      <span style="font-size:12px;color:var(--text-muted)">${s.state !== 'unknown' ? '— ' + s.state : ''}</span>
    </div>`;
  }).join('');
}

function _lockComposeEntry(locked) {
  const textarea  = document.getElementById('remoteComposeInput');
  const btn       = document.getElementById('remoteApplyBtn');
  const msgEl     = document.getElementById('remoteApplyMsg');
  const inputWrap = document.getElementById('remoteComposeInputWrap');
  if (textarea) textarea.disabled     = locked;
  if (inputWrap) inputWrap.style.display = locked ? 'none' : '';
  if (btn) btn.style.display          = locked ? 'none' : '';
  if (msgEl) {
    if (locked) {
      msgEl.innerHTML    = '<strong style="color:var(--text-primary);font-size:14px">&#x2713; Service configured.</strong> <span style="color:var(--text-secondary)">Stop &amp; Remove the current service to start a new one.</span>';
      msgEl.style.display = '';
    } else {
      msgEl.style.display = 'none';
    }
  }
}

async function applyRemoteCompose() {
  const textarea = document.getElementById('remoteComposeInput');
  const btn      = document.getElementById('remoteApplyBtn');
  const msgEl    = document.getElementById('remoteApplyMsg');
  const yaml     = textarea?.value?.trim();

  if (!yaml) {
    _showRemoteMsg('Paste a docker compose snippet first.', 'error');
    return;
  }
  if (!yaml.includes('services:')) {
    _showRemoteMsg('YAML must contain a services: block.', 'error');
    return;
  }

  btn.disabled    = true;
  btn.textContent = 'Applying...';
  msgEl.style.display = 'none';

  _remoteOptimisticState = 'starting';
  _updateRemoteBadge();

  try {
    await API.post('/api/remote/apply', { yaml });
    textarea.value = '';
    await loadRemoteStatus(); // _lockComposeEntry(true) is called inside on configured
  } catch (e) {
    _remoteOptimisticState = null;
    _updateRemoteBadge();
    _showRemoteMsg(e.message || 'Failed to apply config.', 'error');
    btn.disabled    = false;
    btn.textContent = 'Apply & Connect';
  }
}

async function startRemoteService() {
  const btn = document.getElementById('remoteStartBtn');
  btn.disabled    = true;
  btn.textContent = 'Starting...';
  _remoteOptimisticState = 'starting';
  _updateRemoteBadge();
  try {
    await API.post('/api/remote/start');
    await loadRemoteStatus();
  } catch (e) {
    _remoteOptimisticState = null;
    _updateRemoteBadge();
    showToast(e.message || 'Failed to start service.', 'error');
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Resume';
  }
}

async function stopRemoteService() {
  const btn = document.getElementById('remoteStopBtn');
  btn.disabled    = true;
  btn.textContent = 'Stopping...';
  _remoteOptimisticState = 'stopping';
  _updateRemoteBadge();
  try {
    await API.post('/api/remote/stop');
    await loadRemoteStatus();
  } catch (e) {
    _remoteOptimisticState = null;
    _updateRemoteBadge();
    showToast(e.message || 'Failed to stop service.', 'error');
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Pause';
  }
}

async function removeRemoteService() {
  if (!confirm('Stop and remove the remote tunnel service? This will disconnect any active remote connections.')) return;
  const btn = document.getElementById('remoteRemoveBtn');
  btn.disabled    = true;
  btn.textContent = 'Removing...';
  try {
    await API.post('/api/remote/remove');
    await loadRemoteStatus();
  } catch (e) {
    showToast(e.message || 'Failed to remove service.', 'error');
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Stop & Remove';
  }
}

function editRemoteCompose() {
  // Pre-fill the compose textarea with the current YAML and scroll to it
  const textarea = document.getElementById('remoteComposeInput');
  if (textarea && _remoteYaml) {
    textarea.value = _remoteYaml.trim();
    textarea.scrollIntoView({ behavior: 'smooth', block: 'center' });
    textarea.focus();
  }
}


function _showRemoteMsg(text, type) {
  const el = document.getElementById('remoteApplyMsg');
  if (!el) return;
  el.textContent   = text;
  el.style.color   = type === 'error' ? '#ef4444' : 'var(--accent)';
  el.style.display = '';
}