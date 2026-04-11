/**
 * StardropHost | web-panel/public/js/app.js
 * Main application — navigation, WebSocket, all page logic
 */

// ─── Auth Check ──────────────────────────────────────────────────
(function authCheck() {
  // If an update was started recently, show the update screen instead of loading normally.
  const _updTs = parseInt(localStorage.getItem('stardrop_updating') || '0', 10);
  if (_updTs && (Date.now() - _updTs) < 1800000) {
    // Use DOMContentLoaded to ensure elements exist before manipulating them
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => showUpdateScreen(_updTs));
    } else {
      showUpdateScreen(_updTs);
    }
    return;
  }

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
  document.getElementById('wiz-method-gog').style.display   = method === 'gog'   ? 'block' : 'none';
  _wizState._method = method;
  // Steam / GOG: hide Continue row — download button auto-advances
  // Local/path: show Continue row, enable once files are verified
  const continueRow = document.getElementById('wiz-step2-continue-row');
  if (continueRow) continueRow.style.display = (method === 'steam' || method === 'gog') ? 'none' : '';
  const nextBtn = document.getElementById('wiz-step2-next');
  if (nextBtn) nextBtn.disabled = !_wizState._filesFound;
  if (method === 'local') wizScanInstalls();
  if (method === 'gog')   _wizGogLoadAuthUrl();
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
  loginBtn.textContent = 'Starting Steam service…';
  statusEl.style.color = 'var(--text-secondary)';
  statusEl.textContent = 'Starting Steam auth service…';

  // Ensure steam-auth container is running before attempting login
  try {
    await API.post('/api/steam/container/start');
  } catch {}

  // Poll until the container responds (up to 20s)
  const ready = await (async () => {
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        const s = await API.get('/api/steam/status');
        if (s?.state && s.state !== 'unavailable') return true;
      } catch {}
    }
    return false;
  })();

  if (!ready) {
    loginBtn.disabled = false;
    loginBtn.textContent = 'Login to Steam';
    statusEl.style.color = 'var(--accent-error)';
    statusEl.textContent = '❌ Steam auth service failed to start — check container logs.';
    return;
  }

  loginBtn.textContent = 'Connecting to Steam…';
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

// ─── GOG Wizard ───────────────────────────────────────────────────

let _wizGogMode = false;  // true while step 3 is showing a GOG download
let _gogDlLogLines = 0;
let _gogDlPollTimer = null;

// Fetch the GOG auth URL from the backend and populate the wizard link
async function _wizGogLoadAuthUrl() {
  const linkEl  = document.getElementById('wiz-gog-auth-link');
  if (!linkEl) return;
  try {
    const data = await API.get('/api/gog/auth-url');
    if (data?.url) {
      linkEl.href        = data.url;
      linkEl.textContent = data.url;
    }
  } catch {
    if (linkEl) linkEl.textContent = 'Could not load URL — check panel connection';
  }
}

// Login button: start container → login → trigger download → advance to step 3
async function wizGogLogin() {
  const redirectInput = document.getElementById('wiz-gog-redirect');
  const statusEl      = document.getElementById('wiz-gog-status');
  const btn           = document.getElementById('wiz-gog-login-btn');

  const redirectUrl = redirectInput?.value?.trim();
  if (!redirectUrl) {
    if (statusEl) { statusEl.style.color = 'var(--accent-error)'; statusEl.textContent = 'Paste the redirect URL first.'; }
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = 'Starting GOG service…'; }
  if (statusEl) { statusEl.style.color = ''; statusEl.textContent = 'Starting GOG downloader…'; }

  // Start the container
  try {
    await API.post('/api/gog/container/start');
  } catch {
    if (statusEl) { statusEl.style.color = 'var(--accent-error)'; statusEl.textContent = '❌ Could not start GOG service — check manager logs.'; }
    if (btn) { btn.disabled = false; btn.textContent = 'Login to GOG & Start Download'; }
    return;
  }

  // Poll for container readiness (up to 20s)
  if (statusEl) statusEl.textContent = 'Waiting for GOG service…';
  let ready = false;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const s = await API.get('/api/gog/status');
      if (s?.state !== 'unavailable') { ready = true; break; }
    } catch {}
  }
  if (!ready) {
    if (statusEl) { statusEl.style.color = 'var(--accent-error)'; statusEl.textContent = '❌ GOG service failed to start.'; }
    if (btn) { btn.disabled = false; btn.textContent = 'Login to GOG & Start Download'; }
    return;
  }

  // Attempt login
  if (statusEl) statusEl.textContent = 'Logging in to GOG…';
  let loginOk = false;
  try {
    const data = await API.post('/api/gog/login', { redirectUrl });
    if (data?.success) {
      loginOk = true;
    } else {
      if (statusEl) { statusEl.style.color = 'var(--accent-error)'; statusEl.textContent = `❌ ${data?.error || 'Login failed — check the URL and try again.'}`; }
    }
  } catch (e) {
    if (statusEl) { statusEl.style.color = 'var(--accent-error)'; statusEl.textContent = `❌ ${e.message || 'Network error'}`; }
  }

  if (!loginOk) {
    if (btn) { btn.disabled = false; btn.textContent = 'Login to GOG & Start Download'; }
    return;
  }

  // Save step 2 and start download
  if (statusEl) { statusEl.style.color = 'var(--accent)'; statusEl.textContent = '✅ Logged in — starting download…'; }
  try {
    await API.post('/api/wizard/step/2', { method: 'gog' });
    await API.post('/api/gog/download');
  } catch {}

  _wizGogMode    = true;
  _gogDlLogLines = 0;
  const dlStatus = document.getElementById('wiz-dl-status');
  if (dlStatus) dlStatus.textContent = 'Connecting to GOG…';
  const guardRow = document.getElementById('wiz-dl-guard-row');
  if (guardRow) guardRow.style.display = 'none'; // Steam-only
  setTimeout(() => { wizGoToStep(3); wizPollDownloadProgress(); }, 1000);
}

// Step 3 — poll GOG log and render lines in the download log box
async function _wizPollGogLog(logEl, cntEl) {
  try {
    const data = await API.get('/api/gog/log');
    if (!data?.lines?.length) return data;
    const newLines = data.lines.slice(_gogDlLogLines);
    if (!newLines.length) return data;
    if (_gogDlLogLines === 0) logEl.innerHTML = '';
    _gogDlLogLines = data.lines.length;
    const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
    newLines.forEach(line => {
      const div = document.createElement('div');
      div.style.color = /error|fail/i.test(line) ? '#ef4444' : /✅|complete/i.test(line) ? 'var(--accent)' : '';
      div.textContent = line;
      logEl.appendChild(div);
    });
    if (cntEl) cntEl.textContent = `${_gogDlLogLines} lines`;
    if (atBottom) logEl.scrollTop = logEl.scrollHeight;
    return data;
  } catch { return null; }
}

// ─── End GOG Wizard ───────────────────────────────────────────────

// Step 3 — poll game-ready + stream setup.log while download/install is running
const _DL_STAGE_PCT = { waiting: 5, no_game_files: 5, copying: 15, downloading: 30, installing: 65, starting: 90, loading: 95, running: 97, hosting: 99, ready: 100 };
const _DL_STAGE_TXT = {
  waiting:       'Connecting to Steam…',
  no_game_files: 'Waiting for download to begin…',
  copying:       'Copying game files from existing install…',
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
  const bar   = document.getElementById('wiz-dl-bar');
  const lbl   = document.getElementById('wiz-dl-status');
  const logEl = document.getElementById('wiz-dl-log');
  const cntEl = document.getElementById('wiz-dl-log-count');

  // ── GOG branch ──────────────────────────────────────────────────
  if (_wizGogMode) {
    const gogData = await _wizPollGogLog(logEl, cntEl);
    const state   = gogData?.state;

    if (state === 'done') {
      clearTimeout(_steamDlPollTimer);
      _steamDlPollTimer = null;
      _wizState._gameMethod = 'gog';
      if (bar) bar.style.width = '100%';
      if (lbl) { lbl.style.color = 'var(--accent)'; lbl.textContent = '✅ Game installed — continuing setup…'; }
      try { await API.post('/api/gog/record-version'); } catch {}
      setTimeout(() => wizGoToStep(4), 1200);
      return;
    }

    if (state === 'error') {
      clearTimeout(_steamDlPollTimer);
      _steamDlPollTimer = null;
      if (bar) bar.style.width = '30%';
      if (lbl) { lbl.style.color = 'var(--accent-error,#ef4444)'; lbl.textContent = '❌ Download failed — go back and try again.'; }
      _wizShowStep3BackBtn('GOG download failed — go back to Step 2 and try again.');
      return;
    }

    if (state === 'downloading' && bar) {
      // Crude pct from log — look for "[XX%]" pattern
      const lines = logEl?.querySelectorAll('div');
      if (lines?.length) {
        const last = lines[lines.length - 1].textContent;
        const m = last.match(/\[(\d+)%\]/);
        if (m) bar.style.width = Math.min(5 + Math.round(parseInt(m[1]) * 0.85), 90) + '%';
      }
    } else if (bar && state === 'logging-in') {
      bar.style.width = '10%';
    } else if (bar && state === 'logged-in') {
      bar.style.width = '20%';
    }

    if (_wizState.currentStep === 3) {
      _steamDlPollTimer = setTimeout(wizPollDownloadProgress, 3000);
    }
    return;
  }
  // ── end GOG branch ──────────────────────────────────────────────

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
  const tz   = tzPickerValue('wiz-tz-picker');
  const mode = document.getElementById('wiz-server-mode')?.value || 'lan';
  try {
    await API.post('/api/wizard/step/4', { timezone: tz || undefined, serverMode: mode });
    // Populate confirm lines for step 6
    const gm = _wizState._gameMethod;
    document.getElementById('wiz-confirm-game').textContent =
      `✅ Game files: ${gm === 'steam' ? 'Steam download configured' : 'Copied manually'}`;
    const cpu = _wizState._cpu, mem = _wizState._mem;
    document.getElementById('wiz-confirm-resources').textContent =
      cpu || mem ? `✅ Resources: CPU=${cpu||'unlimited'}, RAM=${mem||'unlimited'}` : '✅ Resources: no limits set';
    document.getElementById('wiz-confirm-server').textContent = '✅ Server: open (no password)';
    // Load farm step (step 6)
    wizGoToStep(6);
    wizLoadFarmStep();
  } catch (e) {
    showToast(e.message || 'Failed to save — try again', 'error');
  }
}

function wizToggleExperimentalCabins(checked) {
  const sel     = document.getElementById('wiz-cabin-count');
  const warning = document.getElementById('wiz-experimental-warning');
  if (checked) {
    for (let i = 9; i <= 16; i++) {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = `${i} cabins (${i} players)`;
      sel.appendChild(opt);
    }
    warning.style.display = '';
  } else {
    if (parseInt(sel.value) > 8) sel.value = '8';
    Array.from(sel.options).filter(o => parseInt(o.value) > 8).forEach(o => o.remove());
    warning.style.display = 'none';
  }
  wizUpdateCabinStack(parseInt(sel.value));
}

function wizUpdateCabinStack(count) {
  const cb    = document.getElementById('wiz-cabin-stack');
  const label = document.getElementById('wiz-cabin-stack-label');
  const note  = document.getElementById('wiz-cabin-stack-auto');
  if (!cb) return;
  if (count >= 8) {
    cb.checked  = true;
    cb.disabled = true;
    label.style.opacity = '0.5';
    label.style.cursor  = 'default';
    note.style.display  = '';
  } else {
    cb.disabled = false;
    label.style.opacity = '1';
    label.style.cursor  = 'pointer';
    note.style.display  = 'none';
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
  const cabinStack   = document.getElementById('wiz-cabin-stack')?.checked ?? false;
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
  const cropSaver    = document.getElementById('wiz-crop-saver')?.checked ?? false;

  statusEl.style.color = 'var(--text-secondary)';
  statusEl.textContent = 'Saving farm configuration…';
  try {
    await API.post('/api/wizard/new-farm', {
      farmName, farmerName, favoriteThing,
      farmType, cabinCount, cabinLayout, cabinStack,
      moneyStyle, profitMargin, moveBuildPermission: moveBuild,
      communityCenterBundles: ccBundles, mineRewards,
      spawnMonstersAtNight: monsters === 'true',
      guaranteeYear1Completable: year1 === 'true',
      randomSeed: randomSeed !== '' ? randomSeed : null,
      acceptPet: acceptPet === 'true',
      petSpecies, petBreed: parseInt(petBreed, 10) || 0, petName,
      mushroomsOrBats: cave,
      purchaseJojaMembership: joja === 'true',
      cropSaverEnabled: cropSaver,
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

const _STAGE_PCT = { waiting: 5, no_game_files: 8, copying: 15, downloading: 20, installing: 45, starting: 60, loading: 70, running: 80, hosting: 92, ready: 100 };
const _STAGE_TXT = {
  waiting:       'Waiting for server to start…',
  no_game_files: '⚠️ Game files not found — go back to step 2 to provide them',
  copying:       'Copying game files from existing install… (this may take a minute)',
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

  // Stop download containers — only needed during wizard download steps
  API.post('/api/steam/container/stop').catch(() => null);
  API.post('/api/gog/container/stop').catch(() => null);

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
let _gameProvider          = 'steam'; // updated from status polling
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
let _remoteAddressCache    = { game: '', dashboard: '' };
let _cachedLanIp           = '';
let _networkDetailsCached  = false;
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

// Auto-enable the Servers tab when this is a multi-instance setup.
// Fires once on page load; updates localStorage + nav visibility.
async function _detectAndApplyMultiInstance() {
  try {
    const data = await API.get('/api/instances');
    if (data?.multiInstance && !_serversEnabled) {
      _setMultiInstanceEnabled(true);
    }
  } catch {}
}

function init() {
  applyTheme();
  _checkIncomingPeers();
  _detectAndApplyMultiInstance();
  setupNavigation();
  setupCopyable();
  setupWebSocket();
  loadDashboard();
  loadRemoteStatus();
  loadBackupStatus();
  renderQuickActions();
  loadPanelVersion();
  startChatBackgroundPoll();

  document.getElementById('logoutBtn').onclick = () => {
    localStorage.removeItem('panel_token');
    window.location.href = '/login.html';
  };

  document.getElementById('themeToggle').onclick = () => {
    currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('panel_theme', currentTheme);
    applyTheme();
  };

  function _closeSidebar() {
    const sidebar = document.getElementById('sidebar');
    sidebar.classList.remove('open');
    document.getElementById('menuIconOpen').style.display  = '';
    document.getElementById('menuIconClose').style.display = 'none';
    document.getElementById('menuOverlay').classList.remove('active');
    _updateMenuToggleDot();
  }

  document.getElementById('menuToggle').onclick = () => {
    const sidebar = document.getElementById('sidebar');
    const isOpen  = sidebar.classList.toggle('open');
    document.getElementById('menuIconOpen').style.display  = isOpen ? 'none' : '';
    document.getElementById('menuIconClose').style.display = isOpen ? '' : 'none';
    document.getElementById('menuOverlay').classList.toggle('active', isOpen);
    _updateMenuToggleDot();
  };

  document.getElementById('sidebarCloseBtn').onclick = _closeSidebar;
  document.getElementById('menuOverlay').onclick      = _closeSidebar;

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
  const VALID_PAGES = ['dashboard','farm','players','chat','saves','mods','terminal','config','remote','servers'];
  const hashPage = window.location.hash.slice(1);
  if (hashPage && VALID_PAGES.includes(hashPage)) navigateTo(hashPage);
}

// ─── Navigation ──────────────────────────────────────────────────
const PAGE_TITLES = {
  dashboard: 'Dashboard', farm: 'Farm', players: 'Players', chat: 'Chat',
  saves: 'Saves', mods: 'Mods', terminal: 'Console', config: 'Config', remote: 'Remote',
  servers: 'Servers',
};

function setupNavigation() {
  _updateServersNav();
  document.querySelectorAll('.nav-item, .mob-nav-item').forEach(item => {
    item.onclick = () => navigateTo(item.dataset.page);
  });
}

function _updateServersNav() {
  const item = document.getElementById('nav-servers-item');
  if (item) item.style.display = _serversEnabled ? '' : 'none';
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

  // Disconnect terminal when leaving console page
  if (page !== 'terminal') terminalDisconnect();

  document.querySelectorAll('.nav-item, .mob-nav-item').forEach(i => i.classList.remove('active'));
  document.querySelectorAll(`.nav-item[data-page="${page}"], .mob-nav-item[data-page="${page}"]`)
    .forEach(i => i.classList.add('active'));

  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(`page-${page}`)?.classList.add('active');

  setText('pageTitle', PAGE_TITLES[page] || page);
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('menuIconOpen').style.display  = '';
  document.getElementById('menuIconClose').style.display = 'none';
  document.getElementById('menuOverlay').classList.remove('active');
  window.scrollTo(0, 0);
  _updateMenuToggleDot();

  switch (page) {
    case 'dashboard': loadDashboard(); loadRemoteStatus(); renderQuickActions(); break;
    case 'farm':
      loadFarm();
      initCropSaverState();
      if (!farmInterval) farmInterval = setInterval(loadFarm, 5000);
      break;
    case 'players':
      loadPlayers();
      if (!playersInterval) playersInterval = setInterval(loadPlayers, 5000);
      break;
    case 'chat':
      _chatPlayersTs = 0; // force immediate player refresh on page open
      // Clear whichever channel is currently visible
      if (_chatTarget) delete _chatNotifs[_chatTarget];
      else delete _chatNotifs['world'];
      _persistChatState();
      _updateChatBadges();
      renderChatPlayerPills();
      initChatColorRow();
      _resetChatLines();
      loadChatMessages();
      if (!_chatPollTimer) _chatPollTimer = setInterval(loadChatMessages, 3000);
      break;
    case 'saves':     loadSaves();                                           break;
    case 'mods':      loadMods();                                            break;
    case 'terminal':  loadLogs('game'); subscribeToLogs('game'); terminalConnect(); break;
    case 'config':    loadConfig();                                          break;
    case 'remote':    loadRemoteStatus();                                    break;
    case 'servers':   loadServersPage();                                     break;
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
      document.getElementById('termInput').disabled   = false;
      document.getElementById('termSendBtn').disabled = false;
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
    if (lastRemoteData.fromPeer) {
      return { label: 'Remote Active', icon: 'icon-globe', cls: 'btn-secondary', onclick: "navigateTo('remote')" };
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

let _lastSysCores = 0;
function _populateCpuOptions(sysCores) {
  if (!sysCores || sysCores === _lastSysCores) return;
  _lastSysCores = sysCores;
  const opts = [{ value: '', label: 'No limit' }];
  const steps = [1, 2, 4, 6, 8, 10, 12, 16, 20, 24, 32];
  for (const n of steps) {
    if (n <= sysCores) opts.push({ value: String(n), label: n === 1 ? '1 core' : `${n} cores` });
  }
  const sels = [
    document.getElementById('wiz-cpu'),
    document.querySelector('select[data-key="CPU_LIMIT"]'),
  ];
  for (const sel of sels) {
    if (!sel) continue;
    const cur = sel.value;
    sel.innerHTML = opts.map(o => `<option value="${o.value}"${o.value === cur ? ' selected' : ''}>${o.label}</option>`).join('');
  }
}

let _lastSysRamTotal = 0;
function _populateRamOptions(totalMB) {
  if (!totalMB || totalMB === _lastSysRamTotal) return;
  _lastSysRamTotal = totalMB;
  const totalGB = totalMB / 1024;
  const opts = [{ value: '', label: 'No limit' }];
  for (const n of [1, 2, 4, 6, 8, 12, 16, 24, 32, 48, 64]) {
    if (n <= totalGB) opts.push({ value: `${n}g`, label: `${n} GB` });
  }
  const sels = [
    document.getElementById('wiz-mem'),
    document.querySelector('select[data-key="MEMORY_LIMIT"]'),
  ];
  for (const sel of sels) {
    if (!sel) continue;
    const cur = sel.value;
    sel.innerHTML = opts.map(o => `<option value="${o.value}"${o.value === cur ? ' selected' : ''}>${o.label}</option>`).join('');
  }
}

function updateDashboardUI(data) {
  lastStatusData = data;

  // Farm name in sidebar
  const farmNameEl = document.getElementById('sidebarFarmName');
  if (farmNameEl) {
    const name = data.live?.farmName || data.farmName || '';
    if (name) { farmNameEl.textContent = name; farmNameEl.style.display = ''; }
    else       { farmNameEl.style.display = 'none'; }
  }

  populateUpgradeCabinDropdown();
  renderQuickActions();
  if (data.sysCores)              _populateCpuOptions(data.sysCores);
  if (data.sysMemory?.total > 0)  _populateRamOptions(data.sysMemory.total);

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

  setText('stat-players', liveRunning ? `${data.players?.online ?? 0}/${data.players?.max ?? '--'}` : '--');
  setText('stat-uptime',  formatUptime(data.uptime || 0));
  setText('stat-day',     data.paused ? 'Paused' : (data.day || '--'));
  setText('stat-backups', data.backupCount ?? 0);
  setText('stat-mods',    data.modCount    ?? 0);

  // CPU
  const cpu            = Math.round(data.cpu    || 0);
  const sysCpu         = Math.round(data.sysCpu || 0);
  const containerCores = data.containerCores || '';
  const sysCores       = data.sysCores       || '';
  const cpuEl = document.getElementById('cpu-value');
  const coreLabel    = containerCores ? ` / ${containerCores} cores` : '';
  const sysCoreLabel = sysCores       ? ` / ${sysCores} cores`       : '';
  if (cpuEl) cpuEl.innerHTML = `${cpu}%${coreLabel}` + (sysCpu > 0 ? ` <span style="color:var(--text-muted);font-size:11px">| ${sysCpu}%${sysCoreLabel} sys</span>` : '');
  const cpuBar    = document.getElementById('cpu-bar');
  const cpuBarSys = document.getElementById('cpu-bar-sys');
  cpuBar.style.width    = Math.min(cpu, 100) + '%';
  cpuBar.className      = 'progress-fill' + (cpu > 80 ? ' danger' : cpu > 60 ? ' warn' : '');
  cpuBarSys.style.width = Math.min(sysCpu, 100) + '%';

  // RAM
  const memUsedMB  = Math.round(data.memory?.used  || 0);
  const memLimitMB = data.memory?.limit || 2048;
  const memPct     = Math.round((memUsedMB / memLimitMB) * 100);
  const sysMemUsed  = Math.round(data.sysMemory?.used  || 0);
  const sysMemTotal = Math.round(data.sysMemory?.total || 0);
  const sysMemPct   = sysMemTotal > 0 ? Math.round((sysMemUsed / sysMemTotal) * 100) : 0;
  const ramEl = document.getElementById('ram-value');
  if (ramEl) ramEl.innerHTML = `${memUsedMB} / ${memLimitMB} MB` + (sysMemTotal > 0 ? ` <span style="color:var(--text-muted);font-size:11px">| ${sysMemTotal} MB sys</span>` : '');
  const ramBar    = document.getElementById('ram-bar');
  const ramBarSys = document.getElementById('ram-bar-sys');
  ramBar.style.width    = Math.min(memPct, 100) + '%';
  ramBar.className      = 'progress-fill' + (memPct > 80 ? ' danger' : memPct > 60 ? ' warn' : '');
  ramBarSys.style.width = Math.min(sysMemPct, 100) + '%';

  // Details — static after first load, no need to update on every poll
  if (!_networkDetailsCached) {
    const net = data.network || {};
    const displayIp = net.joinIp || net.localIps?.[0] || '';
    if (displayIp) {
      _cachedLanIp = displayIp;
      setText('detail-join-ip',    displayIp);
      setText('detail-local-ips',  net.localIps?.[0] || displayIp);
      setText('detail-panel-port', net.panelPort || 18642);
      _networkDetailsCached = true;
    }
  }
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
  _gameProvider = data.gameProvider || 'steam';
  function _renderGameNotif(el) {
    if (!el) return;
    if (liveRunning && data.gameUpdateAvailable) {
      const builds   = data.gameUpdateBuilds || {};
      const sub      = builds.latest ? `Build ${builds.current || '?'} → ${builds.latest}` : 'A new version is available';
      const provider = _gameProvider === 'gog' ? 'GOG' : 'Steam';
      el.innerHTML = `
        <div class="update-notification" onclick="openGameUpdateModal()" title="Click to update">
          <div class="update-notification-icon">⬆</div>
          <div class="update-notification-text">
            <div class="update-notification-title">Stardew Valley update available</div>
            <div class="update-notification-sub">${escapeHtml(sub)} — click to update via ${provider}</div>
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

  // Config nav badge + Updates card dot — show whenever an update is available
  const hasUpdate = (liveRunning && data.panelUpdateAvailable) || (liveRunning && data.gameUpdateAvailable);
  const configBadge = document.getElementById('configNavBadge');
  if (configBadge) configBadge.style.display = hasUpdate ? '' : 'none';
  const updatesCardDot = document.getElementById('updatesCardDot');
  if (updatesCardDot) updatesCardDot.style.display = hasUpdate ? '' : 'none';
  _updateMenuToggleDot();

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
    const roomsHtml = Object.entries(cc.rooms).map(([room, info]) => {
      const done      = info.bundles.filter(b => b.complete).length;
      const total     = info.bundles.length;
      const pct       = total ? Math.round(done / total * 100) : 100;
      const complete  = info.complete;
      const bundleRows = info.bundles.map(b =>
        `<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;font-size:12px">
          <span style="color:${b.complete ? 'var(--accent)' : 'var(--text-secondary)'}">${escapeHtml(b.name || 'Bundle')}</span>
          <span style="color:${b.complete ? 'var(--accent)' : 'var(--text-muted)'}">${b.complete ? '✅' : `${b.itemsComplete ?? 0}/${b.itemsRequired ?? '?'}`}</span>
        </div>`
      ).join('');
      return `
        <details class="cc-room-details"${complete ? '' : ''}>
          <summary class="cc-room-summary">
            <span class="cc-room-name">${escapeHtml(room)}</span>
            <span class="cc-room-meta">
              <span style="color:${complete ? 'var(--accent)' : 'var(--text-muted)'};font-size:12px">${complete ? '✅ Complete' : `${done}/${total}`}</span>
              <span class="cc-room-bar"><span class="cc-room-fill" style="width:${pct}%;${complete ? 'background:var(--accent)' : ''}"></span></span>
              <span style="font-size:11px;color:var(--text-muted);min-width:30px;text-align:right">${pct}%</span>
            </span>
          </summary>
          <div style="padding:6px 0 2px">${bundleRows}</div>
        </details>`;
    }).join('');

    const summaryText = document.getElementById('farmCCSummaryText');
    const summaryFill = document.getElementById('farmCCSummaryFill');
    if (summaryText) summaryText.textContent = `${cc.completedRooms} / ${cc.totalRooms} rooms  ${cc.percentComplete}%`;
    if (summaryFill) {
      summaryFill.style.width = `${cc.percentComplete}%`;
      summaryFill.style.background = cc.percentComplete === 100 ? 'var(--accent)' : '';
    }
    ccEl.innerHTML = `<div style="display:flex;flex-direction:column;gap:4px">${roomsHtml}</div>`;
  } else {
    const summaryText = document.getElementById('farmCCSummaryText');
    if (summaryText) summaryText.textContent = '0 / 6 rooms  0%';
    ccEl.innerHTML = '<div class="empty-state">Community Center data not available</div>';
  }

  // Farm info — no Farmer field
  infoEl.innerHTML = `
    <div class="details-grid">
      <div class="detail-item" style="position:relative">
        <div class="detail-label">Farm Name</div>
        <div class="detail-value">${escapeHtml(data.farmName || '--')}</div>
        <button class="btn-detail-edit" onclick="openFarmNameModal()" title="Edit farm name" style="position:absolute;top:10px;right:10px;background:none;border:none;cursor:pointer;color:var(--text-muted);padding:2px;line-height:1;border-radius:4px" onmouseenter="this.style.color='var(--text-primary)'" onmouseleave="this.style.color='var(--text-muted)'">
          <svg class="icon" style="width:14px;height:14px"><use href="#icon-edit"></use></svg>
        </button>
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

// ─── Farm Name Edit ───────────────────────────────────────────────

let _pendingFarmName = null;

function openFarmNameModal() {
  const current = document.querySelector('#farmInfoData .detail-value')?.textContent || '';
  const input = document.getElementById('farmNameModalInput');
  input.value = current === '--' ? '' : current;
  document.getElementById('farmNameModal').style.display = 'flex';
  setTimeout(() => { input.focus(); input.select(); }, 50);
}

function closeFarmNameModal() {
  document.getElementById('farmNameModal').style.display = 'none';
}

function farmNameModalSubmit() {
  const name = document.getElementById('farmNameModalInput').value.trim();
  if (!name) return;
  closeFarmNameModal();
  _pendingFarmName = name;

  const isRunning = lastStatusData?.live?.serverState === 'running';
  const confirmModal = document.getElementById('farmNameConfirmModal');
  const btn = document.getElementById('farmNameConfirmBtn');

  if (isRunning) {
    document.getElementById('farmNameConfirmTitle').textContent = 'Restart Required';
    document.getElementById('farmNameConfirmMsg').textContent =
      `Rename farm to "${name}"? The server is running — it will be restarted to apply the change.`;
    btn.textContent = 'Confirm & Restart';
    btn.className = 'btn btn-sm btn-warning';
  } else {
    document.getElementById('farmNameConfirmTitle').textContent = 'Confirm Farm Name';
    document.getElementById('farmNameConfirmMsg').textContent = `Rename farm to "${name}"?`;
    btn.textContent = 'Confirm';
    btn.className = 'btn btn-sm btn-primary';
  }
  confirmModal.style.display = 'flex';
}

function farmNameConfirmCancel() {
  document.getElementById('farmNameConfirmModal').style.display = 'none';
  _pendingFarmName = null;
}

async function farmNameConfirmApply() {
  const name = _pendingFarmName;
  if (!name) return;
  _pendingFarmName = null;
  document.getElementById('farmNameConfirmModal').style.display = 'none';

  const isRunning = lastStatusData?.live?.serverState === 'running';
  const result = await API.post('/api/farm/name', { name }).catch(() => null);
  if (!result?.ok) { showToast('Failed to save farm name', 'error'); return; }

  if (isRunning) {
    confirmRestart();
  } else {
    showToast('Farm name saved');
    loadFarm();
  }
}

// ─── World Controls ───────────────────────────────────────────────

let _worldFrozen = false;
let _worldPaused = false;

// ─── Freeze message color picker ─────────────────────────────────
const _FREEZE_COLORS = [
  { name: 'white',       css: '#ffffff' },
  { name: 'red',         css: '#e84040' },
  { name: 'blue',        css: '#5b8dd9' },
  { name: 'green',       css: '#3cb04a' },
  { name: 'jade',        css: '#44b89b' },
  { name: 'yellowgreen', css: '#9acd32' },
  { name: 'pink',        css: '#e87bb0' },
  { name: 'purple',      css: '#9b59b6' },
  { name: 'yellow',      css: '#f0d000' },
  { name: 'orange',      css: '#e8841e' },
  { name: 'brown',       css: '#8b5e3c' },
  { name: 'gray',        css: '#888888' },
  { name: 'cream',       css: '#f5e6c8' },
  { name: 'salmon',      css: '#fa8072' },
  { name: 'peach',       css: '#ffb07a' },
  { name: 'aqua',        css: '#00bcd4' },
  { name: 'jungle',      css: '#2e7d4f' },
  { name: 'plum',        css: '#b065b0' },
];
let _freezeMsgColor = 'white';

function _initFreezeMsgColorPicker() {
  const picker = document.getElementById('worldFreezeMsgColorPicker');
  const dot    = document.getElementById('worldFreezeMsgColorBtn');
  if (!picker || !dot) return;
  picker.innerHTML = _FREEZE_COLORS.map(c =>
    `<button class="freeze-color-swatch${c.name === _freezeMsgColor ? ' selected' : ''}"
      style="background:${c.css}" title="${c.name}"
      onclick="selectFreezeMsgColor('${c.name}','${c.css}',this)"></button>`
  ).join('');
}

function toggleFreezeMsgColors(e) {
  e.stopPropagation();
  const picker = document.getElementById('worldFreezeMsgColorPicker');
  if (!picker) return;
  if (picker.style.display === 'none') {
    _initFreezeMsgColorPicker();
    picker.style.display = 'flex';
    setTimeout(() => document.addEventListener('click', _closeFreezeColorPicker, { once: true }), 0);
  } else {
    picker.style.display = 'none';
  }
}

function _closeFreezeColorPicker() {
  const picker = document.getElementById('worldFreezeMsgColorPicker');
  if (picker) picker.style.display = 'none';
}

function selectFreezeMsgColor(name, css, el) {
  _freezeMsgColor = name;
  const dot = document.getElementById('worldFreezeMsgColorBtn');
  if (dot) dot.style.background = css;
  document.querySelectorAll('.freeze-color-swatch').forEach(s => s.classList.remove('selected'));
  if (el) el.classList.add('selected');
  const picker = document.getElementById('worldFreezeMsgColorPicker');
  if (picker) picker.style.display = 'none';
}

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

const CABIN_LEVEL_NAMES = ['Basic', 'Kitchen', 'Kids Room', 'Full Upgrade'];
// Players awaiting reconnect after an upgrade kick — button stays locked until they're back online
const _cabinUpgradePending = new Set();

function populateUpgradeCabinDropdown() {
  const sel = document.getElementById('upgradeCabinPlayer');
  if (!sel) return;
  const cabins      = lastStatusData?.live?.cabins  || [];
  const onlineNames = new Set((lastStatusData?.live?.players || []).filter(p => p.isOnline && !p.isHost).map(p => p.name));
  const named       = cabins.filter(c => c.ownerName && c.ownerName !== 'Farmhouse');

  // Clear pending flag for anyone who has reconnected
  for (const name of [..._cabinUpgradePending])
    if (onlineNames.has(name)) _cabinUpgradePending.delete(name);

  const prev = sel.value;
  sel.innerHTML = '<option value="">— Select player —</option>' +
    named.map(c => {
      const lvl     = c.upgradeLevel ?? 0;
      const maxed   = lvl >= 3;
      const pending = _cabinUpgradePending.has(c.ownerName);
      const label   = `${c.ownerName} — Lv${lvl} ${CABIN_LEVEL_NAMES[lvl] ?? ''}${maxed ? ' (Max)' : pending ? ' (reconnecting…)' : ''}`;
      return `<option value="${c.ownerName}" data-level="${lvl}"${c.ownerName === prev ? ' selected' : ''}${maxed ? ' data-maxed="true"' : ''}${pending ? ' data-pending="true"' : ''}>${label}</option>`;
    }).join('');
  onUpgradeCabinSelect();
}

function onUpgradeCabinSelect() {
  const sel    = document.getElementById('upgradeCabinPlayer');
  const lvlSel = document.getElementById('upgradeCabinLevel');
  const btn    = document.getElementById('upgradeCabinBtn');
  if (!sel || !lvlSel || !btn) return;

  const opt     = sel.options[sel.selectedIndex];
  const curLvl  = parseInt(opt?.dataset?.level ?? '0') || 0;
  const maxed   = opt?.dataset?.maxed === 'true';
  const pending = opt?.dataset?.pending === 'true' || _cabinUpgradePending.has(sel.value);
  const blocked = !sel.value || maxed || pending;

  const prevLvl = parseInt(lvlSel.value) || 0;
  lvlSel.innerHTML = '';
  if (sel.value && !maxed && !pending) {
    for (let l = curLvl + 1; l <= 3; l++) {
      const o = document.createElement('option');
      o.value       = l;
      o.textContent = `Level ${l} — ${CABIN_LEVEL_NAMES[l]}`;
      if (l === prevLvl) o.selected = true;
      lvlSel.appendChild(o);
    }
  } else {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = maxed ? 'Max level reached' : pending ? 'Awaiting reconnect…' : '— level —';
    lvlSel.appendChild(o);
  }

  lvlSel.disabled = blocked;
  btn.disabled    = blocked;
  btn.title       = !sel.value ? 'Select a player' : maxed ? 'Already at max level' : pending ? 'Waiting for player to reconnect' : '';
}

async function upgradeCabin() {
  const ownerName   = document.getElementById('upgradeCabinPlayer')?.value;
  const targetLevel = parseInt(document.getElementById('upgradeCabinLevel')?.value);
  if (!ownerName || !targetLevel) return;

  const data = await API.post('/api/players/farmhands/upgrade', { ownerName, targetLevel }).catch(() => null);

  if (data?.success) {
    _cabinUpgradePending.add(ownerName);
    const sel = document.getElementById('upgradeCabinPlayer');
    const opt = sel?.options[sel.selectedIndex];
    if (opt) {
      opt.dataset.level   = targetLevel;
      opt.dataset.pending = 'true';
      if (targetLevel >= 3) opt.dataset.maxed = 'true';
      opt.textContent = `${ownerName} — Lv${targetLevel} ${CABIN_LEVEL_NAMES[targetLevel] ?? ''}${targetLevel >= 3 ? ' (Max)' : ' (reconnecting…)'}`;
    }
    onUpgradeCabinSelect();
  }

  const el = document.getElementById('worldCmdResult');
  if (!el) return;
  el.textContent      = data?.success
    ? `✓ ${ownerName}'s cabin upgraded to level ${targetLevel}. They will be disconnected in ~10s.`
    : `✗ ${data?.error || 'Failed — is the server running?'}`;
  el.style.color      = data?.success ? 'var(--accent)' : '#ef4444';
  el.style.background = data?.success ? 'rgba(167,139,250,0.08)' : 'rgba(239,68,68,0.08)';
  el.style.display    = '';
  setTimeout(() => { el.style.display = 'none'; }, 6000);
}

async function toggleWorldPause() {
  const cmd  = _worldPaused ? 'say /resume' : 'say /pause';
  const data = await API.post('/api/players/admin-command', { command: cmd }).catch(() => null);
  if (data?.success) {
    _worldPaused = !_worldPaused;
    const btn     = document.getElementById('worldPauseBtn');
    const stateEl = document.getElementById('worldPauseState');
    if (btn)     btn.textContent     = _worldPaused ? 'Resume' : 'Pause';
    if (stateEl) stateEl.textContent = _worldPaused ? '⏸ Paused' : '▶ Running';
  }
  const el = document.getElementById('worldCmdResult');
  if (!el) return;
  el.textContent    = data?.success ? `✓ ${_worldPaused ? 'Paused' : 'Resumed'}` : `✗ ${data?.error || 'Failed'}`;
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
    const msgEl = document.getElementById('worldFreezeMsg');
    const msg = (msgEl?.value || '').trim();
    if (msg) {
      const colored = _freezeMsgColor && _freezeMsgColor !== 'white' ? `[${_freezeMsgColor}]${msg}` : msg;
      API.post('/api/players/admin-command', { command: `say ${colored}` }).catch(() => null);
      if (msgEl) msgEl.value = '';
    }
  }
  const el = document.getElementById('worldCmdResult');
  if (!el) return;
  el.textContent  = data?.success ? `✓ Time ${_worldFrozen ? 'frozen' : 'unfrozen'}` : `✗ ${data?.error || 'Failed'}`;
  el.style.color  = data?.success ? 'var(--accent)' : '#ef4444';
  el.style.background = data?.success ? 'rgba(167,139,250,0.08)' : 'rgba(239,68,68,0.08)';
  el.style.display = '';
  setTimeout(() => { el.style.display = 'none'; }, 4000);
}

let _cropSaverEnabled = false;

async function initCropSaverState() {
  const cfg = await API.get('/api/config').catch(() => null);
  const gameplay = cfg?.groups?.find(g => g.name === 'Gameplay');
  _cropSaverEnabled = gameplay?.items?.find(i => i.key === 'CROP_SAVER_ENABLED')?.value === 'true';
  _updateCropSaverBtn();
}

function _updateCropSaverBtn() {
  const btn     = document.getElementById('worldCropSaverBtn');
  const stateEl = document.getElementById('worldCropSaverState');
  if (btn) btn.textContent = _cropSaverEnabled ? 'Disable' : 'Enable';
  if (stateEl) stateEl.textContent = _cropSaverEnabled ? '🌱 Active' : '○ Off';
}

async function toggleCropSaver() {
  const btn = document.getElementById('worldCropSaverBtn');
  if (btn) btn.disabled = true;
  const newVal = !_cropSaverEnabled;
  const cmd    = newVal ? 'stardrop_cropsaver on' : 'stardrop_cropsaver off';
  const [cfgRes, cmdRes] = await Promise.all([
    API.put('/api/config', { CROP_SAVER_ENABLED: String(newVal) }).catch(() => null),
    API.post('/api/players/admin-command', { command: cmd }).catch(() => null),
  ]);
  if (cfgRes?.success !== false) {
    _cropSaverEnabled = newVal;
    _updateCropSaverBtn();
  } else {
    showToast('Failed to update Crop Saver setting', 'error');
  }
  if (btn) btn.disabled = false;
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

function toggleLogsExpand() {
  const card = document.getElementById('logsCard');
  card.classList.toggle('expanded');
  if (card.classList.contains('expanded')) {
    setTimeout(() => card.scrollIntoView({ behavior: 'smooth', block: 'end' }), 0);
  }
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
    if (btn) { btn.disabled = false; btn.textContent = 'Game Update'; }
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
    if (btn) { btn.disabled = false; btn.textContent = 'Server'; }
  }
}

async function downloadSetupLog() {
  const btn = document.getElementById('logSetupDownload');
  if (btn) { btn.disabled = true; btn.textContent = 'Downloading...'; }
  try {
    const data = await API.get('/api/logs/setup?lines=5000');
    if (!data?.lines?.length) { showToast('No server setup log available', 'warn'); return; }
    const text = data.lines.map(l => l.text).join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.href = url; a.download = `stardrop-setup-${ts}.txt`; a.click();
    URL.revokeObjectURL(url);
  } catch {
    showToast('Failed to download server setup log', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Server Setup'; }
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
  document.getElementById('termInput').disabled   = true;
  document.getElementById('termSendBtn').disabled = true;
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
  const cells = [];

  if (p.location) cells.push(`
    <div class="player-stat-cell">
      <div class="player-stat-label">Location</div>
      <div class="player-stat-value">${escapeHtml(p.location)}</div>
    </div>`);

  if (p.health != null) cells.push(`
    <div class="player-stat-cell">
      <div class="player-stat-label">Health</div>
      <div class="player-stat-value">❤️ ${p.health} / ${p.maxHealth}</div>
    </div>`);

  if (p.stamina != null) cells.push(`
    <div class="player-stat-cell">
      <div class="player-stat-label">Stamina</div>
      <div class="player-stat-value">⚡ ${Math.round(p.stamina)} / ${p.maxStamina}</div>
    </div>`);

  if (separateWallets && p.money != null) cells.push(`
    <div class="player-stat-cell">
      <div class="player-stat-label">Money / Total Earned</div>
      <div class="player-stat-value">💰 ${p.money.toLocaleString()}g / ${p.totalEarned != null ? p.totalEarned.toLocaleString() + 'g' : '—'}</div>
    </div>`);

  const s = p.skills;
  if (s) cells.push(`
    <div class="player-stat-cell">
      <div class="player-stat-label">Skills</div>
      <div class="player-stat-value" style="letter-spacing:0.5px">🌱${s.farming} ⛏${s.mining} 🌲${s.foraging} 🎣${s.fishing} ⚔️${s.combat} 🍀${s.luck}</div>
    </div>`);

  if (p.daysPlayed != null) cells.push(`
    <div class="player-stat-cell">
      <div class="player-stat-label">Playtime</div>
      <div class="player-stat-value">${p.totalPlaytimeHours != null ? `⏱ ${p.totalPlaytimeHours}h · ` : ''}${p.daysPlayed} in-game days</div>
    </div>`);

  return cells.length ? `<div class="player-stats-grid">${cells.join('')}</div>` : '';
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
  loadFarmhands();

  const sw   = data.separateWallets === true;
  const list = document.getElementById('playersList');
  setText('playerCount', `${data.online ?? 0} / ${data.max ?? 8}`);

  if (!data.players?.length) {
    list.innerHTML = `<div class="empty-state">${icon('players', 'icon empty-icon')}<div>No players online</div></div>`;
  } else {
    list.innerHTML = data.players.map(p => `
      <div class="player-card">
        <div class="player-avatar">${icon('players', 'icon')}</div>
        <div class="player-body">
          <div class="player-name">${escapeHtml(p.name)}</div>
          ${(() => { const ips = p.knownIps || []; if (!ips.length) return ''; const current = ips[ips.length - 1]; const others = ips.slice(0, -1); return `<div class="player-ip-line"><span>Current IP: <strong>${escapeHtml(current)}</strong></span>${others.length ? `<span class="player-ip-sep">|</span><span>Other Known: ${others.map(ip => escapeHtml(ip)).join(', ')}</span>` : ''}</div>`; })()}
          ${renderPlayerStats(p, sw)}
        </div>
        <div class="player-actions">
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
  _renderNameIpMap(data.nameIpMap || {}, data.ipLocks || []);
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

// ─── Farmhand Slots ───────────────────────────────────────────────

async function loadFarmhands() {
  const data = await API.get('/api/players/farmhands').catch(() => null);
  const el = document.getElementById('farmhandSlots');
  const card = document.getElementById('farmhandsCard');
  if (!el || !card) return;

  const cabins = data?.cabins || [];

  if (cabins.length) _lastKnownCabinCount = cabins.length;

  if (!cabins.length) {
    card.style.display = '';
    const serverState = data?.serverState;
    const isLoading = serverState !== 'running' || _lastKnownCabinCount > 0;
    el.innerHTML = isLoading
      ? `<p class="text-muted" style="margin:0;font-size:13px">Game Loading…</p>`
      : `<p class="text-muted" style="margin:0;font-size:13px">No cabin slots found.</p>`;
    return;
  }
  card.style.display = '';

  el.innerHTML = cabins.map((c, i) => {
    const name      = c.ownerName || c.OwnerName;
    const online    = c.isOwnerOnline ?? c.IsOwnerOnline;
    const unclaimed = !name || name === 'Unclaimed';
    const onlineDot = online
      ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#22c55e;flex-shrink:0"></span>`
      : '';
    const deleteBtn = (!unclaimed && !online)
      ? `<button class="btn btn-sm btn-danger" onclick="deleteFarmhand(this,'${escapeHtml(name)}')">Delete</button>`
      : '';
    return `
      <div class="farmhand-slot${unclaimed ? ' farmhand-slot-empty' : ''}">
        <div class="farmhand-slot-info">
          <span class="farmhand-slot-num">Slot ${i + 1}</span>
          ${onlineDot}
          <span class="farmhand-slot-name">${unclaimed ? 'Unclaimed' : escapeHtml(name)}</span>
        </div>
        <div class="farmhand-slot-actions">${deleteBtn}</div>
      </div>`;
  }).join('');
}

async function deleteFarmhand(btn, ownerName) {
  if (!confirm(`Permanently delete "${ownerName}"?\n\nThis removes their character data. A server restart is required for the change to take effect.\n\nThis cannot be undone.`)) return;
  btn.disabled = true;
  const data = await API.post('/api/players/farmhands/delete', { ownerName }).catch(() => null);
  if (data?.success) {
    showToast(`${ownerName} deleted. Restart required.`, 'success');
    const slot = btn.closest('.farmhand-slot');
    if (slot) {
      slot.querySelector('.farmhand-slot-name').textContent = 'Unclaimed';
      slot.querySelector('.farmhand-slot-actions').innerHTML = '';
      slot.classList.add('farmhand-slot-empty');
    }
    showRestartModal(`Farmhand "${ownerName}" deleted. Restart the server to apply the change.`);
  } else {
    showToast(data?.error || 'Failed to delete farmhand', 'error');
    btn.disabled = false;
  }
}

// ─── Security (Block List / Allow List) ───────────────────────────

let _securityMode = 'block';

function renderSecurity(security, nameIpMap) {
  _securityMode = security.mode || 'block';

  const blockBtn  = document.getElementById('secModeBlockBtn');
  const allowBtn  = document.getElementById('secModeAllowBtn');
  const modeDesc  = document.getElementById('secModeDesc');
  const blockSection = document.getElementById('blocklistSection');
  const allowSection = document.getElementById('allowlistSection');

  if (blockBtn) blockBtn.classList.toggle('active', _securityMode === 'block');
  if (allowBtn) allowBtn.classList.toggle('active', _securityMode === 'allow');
  if (modeDesc) modeDesc.innerHTML = _securityMode === 'block'
    ? 'Block List Mode — everyone can join except blocked players.'
    : '<strong>Allow List Mode — only players on this list can join. If the list is empty, nobody can join.</strong>';

  // Show only the relevant section within the card
  if (blockSection) blockSection.style.display = _securityMode === 'block' ? '' : 'none';
  if (allowSection) allowSection.style.display = _securityMode === 'allow' ? '' : 'none';

  _renderSecurityList('blocklistEntries', security.blocklist || [], 'block', nameIpMap);
  _renderSecurityList('allowlistEntries', security.allowlist || [], 'allow', nameIpMap);
  _renderNameIpMap(nameIpMap, _lastPlayersData?.ipLocks || []);
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

function _renderNameIpMap(map, ipLocks) {
  const el = document.getElementById('knownIpsEntries');
  if (!el) return;
  const locks = ipLocks || [];
  const entries = Object.entries(map);
  if (!entries.length) {
    el.innerHTML = '<div class="security-empty">No players recorded yet. IPs are captured automatically when players join.</div>';
    return;
  }
  el.innerHTML = entries.map(([name, ips]) => {
    const ipList = Array.isArray(ips) ? ips : (ips ? [ips] : []);
    const isLocked = locks.includes(name);
    const lockBtn = isLocked
      ? `<button class="btn btn-sm" style="background:rgba(251,191,36,0.15);color:#fbbf24;border-color:rgba(251,191,36,0.4)" onclick="removeIpLock('${escapeHtml(name)}')">🔒 Unlock</button>`
      : `<button class="btn btn-sm" style="background:rgba(251,191,36,0.08);color:#fbbf24;border-color:rgba(251,191,36,0.25)" onclick="addIpLock('${escapeHtml(name)}')">🔓 Lock</button>`;
    const ipBadges = ipList.map(ip =>
      `<span class="sec-known-ip">${escapeHtml(ip)}
        <button class="btn btn-sm btn-danger" style="padding:1px 6px;font-size:11px;margin-left:4px" onclick="deleteNameIp('${escapeHtml(name)}','${escapeHtml(ip)}')">✕</button>
      </span>`
    ).join(' ');
    return `
    <div class="sec-entry" style="${isLocked ? 'border-left:2px solid #fbbf24;padding-left:8px' : ''}">
      <span class="sec-badge sec-badge-name">Name</span>
      <span class="sec-value">${escapeHtml(name)}</span>
      ${ipBadges || '<span style="font-size:11px;color:var(--text-muted)">no IPs recorded</span>'}
      ${lockBtn}
    </div>`;
  }).join('');
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
  if (data?.success) _renderNameIpMap(data.nameIpMap, _lastPlayersData?.ipLocks || []);
  else showToast('Failed to update IP', 'error');
}

async function deleteNameIp(name, ip) {
  if (!confirm(`Remove ${name} (${ip}) from known IPs?`)) return;
  const url = `/api/players/name-ip-map/${encodeURIComponent(name)}?ip=${encodeURIComponent(ip)}`;
  const data = await API.del(url).catch(() => null);
  if (data?.success) _renderNameIpMap(data.nameIpMap, _lastPlayersData?.ipLocks || []);
  else showToast('Failed to remove entry', 'error');
}

async function addIpLock(name) {
  if (!confirm(`Lock "${name}" to their known IPs? Anyone joining as "${name}" from a different IP will be kicked.`)) return;
  const data = await API.post('/api/players/ip-locks', { name }).catch(() => null);
  if (data?.success) {
    _lastPlayersData.ipLocks = data.ipLocks;
    _renderNameIpMap(_lastPlayersData?.nameIpMap || {}, data.ipLocks);
    showToast(`${name} locked to known IPs`, 'success');
  } else showToast('Failed to add lock', 'error');
}

async function removeIpLock(name) {
  if (!confirm(`Unlock "${name}"? They will be able to join from any IP again.`)) return;
  const data = await API.del(`/api/players/ip-locks/${encodeURIComponent(name)}`).catch(() => null);
  if (data?.success) {
    _lastPlayersData.ipLocks = data.ipLocks;
    _renderNameIpMap(_lastPlayersData?.nameIpMap || {}, data.ipLocks);
    showToast(`${name} unlocked`, 'success');
  } else showToast('Failed to remove lock', 'error');
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
let _lastKnownCabinCount = 0;
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

// Map host-only ConsoleCommands to per-farmhand stardrop_ equivalents
const _FARMHAND_CMD_MAP = {
  'player_sethealth':    (name, val) => `stardrop_sethealth ${name} ${val}`,
  'player_setmaxhealth': (name, val) => `stardrop_setmaxhealth ${name} ${val}`,
  'player_setstamina':   (name, val) => `stardrop_setstamina ${name} ${val}`,
  'player_setmaxstamina':(name, val) => `stardrop_setmaxstamina ${name} ${val}`,
  'player_setmoney':     (name, val) => `stardrop_setmoney ${name} ${val}`,
};

async function sendAdminCmd(base, value) {
  if (!value && value !== 0) return;
  const name = _adminPlayer?.name;
  const remap = name && _FARMHAND_CMD_MAP[base];
  const command = remap ? remap(name, value) : `${base} ${value}`;
  const data = await API.post('/api/players/admin-command', { command }).catch(() => null);
  _showAdminResult(data?.success, command, data?.error);
}

async function sendAdminGiveItem() {
  if (!_selectedItemId) { _showAdminResult(false, '', 'Browse and select an item first'); return; }
  const qty = parseInt(document.getElementById('adminItemQty').value || '1', 10) || 1;
  const name = _adminPlayer?.name;
  const command = name ? `stardrop_give ${name} ${_selectedItemId} ${qty}` : `player_add ${_selectedItemId} ${qty}`;
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

let _chatTarget        = null;   // null = broadcast to all; string = player name for private
let _chatLastTs        = 0;      // timestamp of newest message we've rendered
let _chatPollTimer     = null;
let _chatPlayers       = [];     // all DM-eligible names (online + recent)
let _chatOnlinePlayers = [];     // currently online player names only
let _chatPlayersTs     = 0;      // last time we fetched players for chat

// Notification state — persisted across refreshes in localStorage
let _chatNotifs   = (() => { try { return JSON.parse(localStorage.getItem('chat_notifs') || '{}'); } catch { return {}; } })();
let _chatBgLastTs = parseInt(localStorage.getItem('chat_bg_ts') || '0', 10);
let _chatBgPoll   = null;

function _persistChatState() {
  localStorage.setItem('chat_bg_ts',  String(_chatBgLastTs));
  localStorage.setItem('chat_notifs', JSON.stringify(_chatNotifs));
}

function startChatBackgroundPoll() {
  if (_chatBgPoll) return;
  _chatBgPoll = setInterval(_pollChatNotifs, 10000);
  _pollChatNotifs(); // immediate first check
}

async function _pollChatNotifs() {
  // Sync bg timestamp to foreground so we don't re-process already-rendered messages
  if (_chatLastTs > _chatBgLastTs) _chatBgLastTs = _chatLastTs;

  const data = await API.get(`/api/chat/messages?since=${_chatBgLastTs}&limit=100`).catch(() => null);
  if (!data?.messages?.length) return;
  let changed = false;
  for (const msg of data.messages) {
    if (msg.ts <= _chatBgLastTs) continue;
    _chatBgLastTs = msg.ts;
    const isDm  = msg.to && msg.to !== 'all';
    const isLog = !msg.from || msg.from === '#0' || msg.from.startsWith('#');
    if (isLog) continue;
    const channel = isDm ? (msg.isHost ? msg.to : msg.from) : 'world';
    const viewing = currentPage === 'chat' && (
      (isDm && _chatTarget === channel) || (!isDm && _chatTarget === null)
    );
    if (viewing) {
      // Actively clear stale notif if user is looking at this channel
      if (_chatNotifs[channel]) { delete _chatNotifs[channel]; changed = true; }
    } else {
      _chatNotifs[channel] = true; changed = true;
    }
  }
  if (changed) { _persistChatState(); _updateChatBadges(); }
}

function _updateChatBadges() {
  const hasAny = Object.values(_chatNotifs).some(Boolean);
  const sb = document.getElementById('chatNavBadge');
  if (sb) sb.style.display = hasAny ? '' : 'none';
  if (hasAny) API.post('/api/instances/chat-ts', { ts: Math.floor(Date.now() / 1000) }).catch(() => {});
  if (currentPage === 'chat') renderChatPlayerPills();
  _updateMenuToggleDot();
}

function _updateMenuToggleDot() {
  const dot = document.getElementById('menuToggleDot');
  if (!dot) return;
  const sidebarOpen  = document.getElementById('sidebar')?.classList.contains('open');
  if (sidebarOpen) { dot.style.display = 'none'; return; }
  const chatBadge   = document.getElementById('chatNavBadge');
  const configBadge = document.getElementById('configNavBadge');
  const hasChat   = chatBadge   && chatBadge.style.display   !== 'none';
  const hasUpdate = configBadge && configBadge.style.display !== 'none';
  dot.style.display = (hasChat || hasUpdate) ? '' : 'none';
}
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
  const worldDot = _chatNotifs['world'] ? '<span class="notif-dot"></span>' : '';
  let html = `<button class="chat-pill${worldActive}" onclick="clearChatTarget()">World Chat${worldDot}</button>`;
  if (_chatPlayers.length > 0) {
    html += `<span class="chat-dm-separator">Private Chats</span>`;
    for (const name of _chatPlayers) {
      const active   = (_chatTarget === name) ? ' active' : '';
      const dot      = _chatNotifs[name] ? '<span class="notif-dot"></span>' : '';
      const offline  = !_chatOnlinePlayers.includes(name);
      const offlineTxt = offline ? ' <span style="font-size:11px;opacity:0.6">(offline)</span>' : '';
      html += `<button class="chat-pill chat-pill-dm${active}" onclick="setChatTarget('${escapeHtml(name)}')">${escapeHtml(name)}${offlineTxt}${dot}</button>`;
    }
  }
  row.innerHTML = html;
  _updateChatScrollArrow();
  // Re-attach scroll listener each render
  row.onscroll = _updateChatScrollArrow;
}

function _updateChatScrollArrow() {
  const row    = document.getElementById('chatPlayerPills');
  const arrow  = document.getElementById('chatScrollArrow');
  const dot    = document.getElementById('chatScrollDot');
  if (!row || !arrow) return;
  const hasOverflow  = row.scrollWidth > row.clientWidth;
  const atEnd        = row.scrollLeft + row.clientWidth >= row.scrollWidth - 4;
  arrow.style.display = (hasOverflow && !atEnd) ? '' : 'none';
  // Show notif dot if any off-screen DM has a pending notif
  const hasOffscreenNotif = _chatPlayers.some(name => {
    if (!_chatNotifs[name]) return false;
    const btn = [...row.querySelectorAll('.chat-pill-dm')].find(b => b.textContent.startsWith(name));
    if (!btn) return false;
    return btn.offsetLeft + btn.offsetWidth > row.scrollLeft + row.clientWidth;
  });
  if (dot) dot.style.display = hasOffscreenNotif ? '' : 'none';
}

function _chatScrollToNotif() {
  const row = document.getElementById('chatPlayerPills');
  if (!row) return;
  // Find first off-screen pill with a notif, or just scroll right
  const target = _chatPlayers.find(name => {
    if (!_chatNotifs[name]) return false;
    const btn = [...row.querySelectorAll('.chat-pill-dm')].find(b => b.textContent.startsWith(name));
    return btn && btn.offsetLeft + btn.offsetWidth > row.scrollLeft + row.clientWidth;
  });
  if (target) {
    const btn = [...row.querySelectorAll('.chat-pill-dm')].find(b => b.textContent.startsWith(target));
    if (btn) { row.scrollTo({ left: btn.offsetLeft - 8, behavior: 'smooth' }); return; }
  }
  row.scrollBy({ left: 120, behavior: 'smooth' });
}

function setChatTarget(name) {
  _chatTarget = name;
  _chatLastTs = 0;
  const label = document.getElementById('chatTargetLabel');
  label.textContent = `Private Chat — ${name}`;
  label.classList.add('dm-active');
  _resetChatLines();
  const firstInput = document.getElementById('chatLines')?.querySelector('input');
  if (firstInput) { firstInput.placeholder = `Message ${name}…`; firstInput.focus(); }
  const feed = document.getElementById('chatFeed');
  if (feed) feed.innerHTML = '<div class="empty-state" id="chatEmpty">Loading…</div>';
  const colorRow = document.getElementById('chatColorRow');
  if (colorRow) colorRow.style.display = 'none';
  delete _chatNotifs[name];
  _persistChatState();
  _updateChatBadges();
  renderChatPlayerPills();
  _updateChatInputState();
  loadChatMessages();
}

function clearChatTarget() {
  _chatTarget = null;
  _chatLastTs = 0;
  const label = document.getElementById('chatTargetLabel');
  label.textContent = 'World Chat';
  label.classList.remove('dm-active');
  _resetChatLines();
  const feed = document.getElementById('chatFeed');
  if (feed) feed.innerHTML = '<div class="empty-state" id="chatEmpty">Loading…</div>';
  const colorRow = document.getElementById('chatColorRow');
  if (colorRow) colorRow.style.display = '';
  delete _chatNotifs['world'];
  _persistChatState();
  _updateChatBadges();
  renderChatPlayerPills();
  _updateChatInputState();
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
      const merged = [...new Set([...onlineNames, ...recentNames])];
      _chatOnlinePlayers = onlineNames;
      if (JSON.stringify(merged) !== JSON.stringify(_chatPlayers)) {
        _chatPlayers = merged;
        renderChatPlayerPills();
      }
      _updateChatInputState();
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

    const isDm    = msg.to && msg.to !== 'all';
    const isLog   = msg.from === '#0' || msg.from?.startsWith('#');

    // Skip "Unnamed Farmhand" join noise — real join message appears once name resolves
    if (isLog && msg.message?.includes('Unnamed Farmhand')) continue;

    if (_chatTarget) {
      // DM view: show messages to/from this player, plus log events mentioning them (join/quit/ban)
      const isPlayerLog = isLog && msg.message && (
        msg.message.startsWith(_chatTarget + ' ') || msg.message.startsWith(_chatTarget + '(')
      );
      if (!isPlayerLog && msg.from !== _chatTarget && msg.to !== _chatTarget) continue;
    } else {
      // World chat: DMs are completely separate — never show here
      if (isDm) continue;
    }

    const el = document.createElement('div');
    // System/log messages → right; host world → left (purple)
    el.className = 'chat-msg' +
      (isLog                     ? ' chat-msg-log'  :
       msg.isHost && !isDm       ? ' chat-msg-host' : '') +
      (isDm                      ? ' chat-msg-dm'   : '');

    const time = new Date(msg.ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    let meta;
    if (isLog) {
      meta = 'Log';
    } else if (msg.isHost && isDm) {
      meta = `<span class="chat-dm-sent">You → ${escapeHtml(msg.to)}</span>`;
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

  // Keep bg timestamp in sync so refresh doesn't re-process rendered messages
  if (_chatLastTs > _chatBgLastTs) {
    _chatBgLastTs = _chatLastTs;
    _persistChatState();
  }
}

function _makeLineInput(placeholder, removable) {
  const wrap  = document.createElement('div');
  wrap.className = 'chat-line-wrap';
  const input = document.createElement('input');
  input.type = 'text'; input.className = 'form-input chat-input';
  input.placeholder = placeholder; input.maxLength = 200; input.autocomplete = 'off';
  input.addEventListener('keydown', e => { if (e.key === 'Enter') sendChatMessage(); });
  wrap.appendChild(input);
  if (removable) {
    const rm = document.createElement('button');
    rm.className = 'btn btn-sm btn-secondary'; rm.textContent = '−'; rm.title = 'Remove line';
    rm.style.flexShrink = '0';
    rm.onclick = () => wrap.remove();
    wrap.appendChild(rm);
  }
  return wrap;
}

function _resetChatLines() {
  const container = document.getElementById('chatLines');
  if (!container) return;
  container.innerHTML = '';
  container.appendChild(_makeLineInput('Message all players…', false));
}

function addChatLine() {
  const container = document.getElementById('chatLines');
  if (!container) return;
  const wrap = _makeLineInput('Next line…', true);
  container.appendChild(wrap);
  wrap.querySelector('input').focus();
}

async function sendChatMessage() {
  const container = document.getElementById('chatLines');
  if (!container) return;
  const inputs  = [...container.querySelectorAll('input')];
  const messages = inputs.map(i => i.value.trim()).filter(Boolean);
  if (!messages.length) return;

  const sendBtn = document.getElementById('chatSendBtn');
  const addBtn  = document.getElementById('chatAddLineBtn');
  if (sendBtn) sendBtn.disabled = true;
  if (addBtn)  addBtn.disabled  = true;

  for (let i = 0; i < messages.length; i++) {
    let message = messages[i];
    // Apply color prefix (skip if /command)
    if (_chatColor && !message.startsWith('/')) {
      if (_chatColor === 'rainbow') {
        message = `[${CHAT_RAINBOW_SEQ[_chatRainbowIdx % CHAT_RAINBOW_SEQ.length]}]${message}`;
        _chatRainbowIdx++;
      } else {
        message = `[${_chatColor}]${message}`;
      }
    }
    const data = await API.post('/api/chat/send', { message, to: _chatTarget || 'all' }).catch(() => null);
    if (!data?.success) {
      showToast(data?.error || 'Failed to send message', 'error');
      break;
    }
    if (i < messages.length - 1) await new Promise(r => setTimeout(r, 600));
  }

  if (sendBtn) sendBtn.disabled = false;
  if (addBtn)  addBtn.disabled  = false;
  _resetChatLines();
  setTimeout(loadChatMessages, 300);
  container.querySelector('input')?.focus();
}

function _updateChatInputState() {
  const container = document.getElementById('chatLines');
  const sendBtn = document.getElementById('chatSendBtn');
  const addBtn  = document.getElementById('chatAddLineBtn');
  const note    = document.getElementById('chatOfflineNote');
  const offline = _chatTarget && !_chatOnlinePlayers.includes(_chatTarget);
  if (container) {
    const inputs = container.querySelectorAll('input');
    inputs.forEach((i, idx) => {
      i.disabled = offline;
      if (offline) {
        i.value = '';
        if (idx === 0) i.placeholder = `${_chatTarget} is offline`;
      } else {
        if (idx === 0) i.placeholder = _chatTarget ? `Message ${_chatTarget}…` : 'Message all players…';
      }
    });
  }
  if (sendBtn) sendBtn.disabled = offline;
  if (addBtn)  addBtn.disabled  = offline;
  if (note)    note.style.display = 'none';
}

async function clearCurrentChat() {
  const channel = _chatTarget || 'world';
  const label   = _chatTarget ? `DM with ${_chatTarget}` : 'World Chat';
  if (!confirm(`Clear ${label}? This cannot be undone.`)) return;
  const data = await API.del('/api/chat/messages', { channel }).catch(() => null);
  if (data?.success) {
    _chatLastTs = 0; _chatBgLastTs = 0;
    delete _chatNotifs[channel];
    _persistChatState();
    const feed = document.getElementById('chatFeed');
    if (feed) feed.innerHTML = `<div class="empty-state" id="chatEmpty">Chat cleared.</div>`;
    _updateChatBadges();
    showToast(`${label} cleared`, 'success');
  } else {
    showToast('Failed to clear chat', 'error');
  }
}

async function clearAllChat() {
  if (!confirm('Clear ALL chat history? This cannot be undone.')) return;
  const data = await API.del('/api/chat/messages', { all: true }).catch(() => null);
  if (data?.success) {
    _chatLastTs = 0; _chatBgLastTs = 0;
    _chatNotifs = {};
    _persistChatState();
    const feed = document.getElementById('chatFeed');
    if (feed) feed.innerHTML = `<div class="empty-state" id="chatEmpty">All chat history cleared.</div>`;
    _updateChatBadges();
    showToast('All chat history cleared', 'success');
    // Also clear in-game chat via SMAPI
    API.post('/api/players/admin-command', { command: 'say /clear' }).catch(() => null);
  } else {
    showToast('Failed to clear chat', 'error');
  }
}

async function downloadChatLog() {
  const res = await API.fetch('/api/chat/download').catch(() => null);
  if (!res || !res.ok) { showToast('Failed to download chat log', 'error'); return; }
  const text = await res.text();
  const blob = new Blob([text], { type: 'text/plain' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = 'chat-log.txt'; a.click();
  URL.revokeObjectURL(url);
}

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
    const badge = document.getElementById('backupCountBadge');
    if (badge) badge.textContent = `${backupsData.backups?.length ?? 0} backup${(backupsData.backups?.length ?? 0) !== 1 ? 's' : ''}`;
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
            <button class="btn btn-sm btn-secondary" onclick="restoreBackup('${escapeHtml(b.filename)}')">Restore</button>
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

let _pendingSaveUpload = null;

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
      const base64 = reader.result.split(',')[1];
      await _doSaveUpload(file.name, base64, setAsDefault, false, input);
    };
    reader.readAsDataURL(file);
  } catch (e) {
    setText('saveUploadStatus', '');
    showToast('Upload failed', 'error');
  }
}

async function _doSaveUpload(filename, base64, setAsDefault, overwrite, input) {
  const data = await API.post('/api/saves/upload', { filename, data: base64, setAsDefault, overwrite });
  setText('saveUploadStatus', '');
  if (input) input.value = '';

  if (data?.collision) {
    const name = data.collisionNames?.[0] || filename;
    _pendingSaveUpload = { filename, base64, setAsDefault };
    if (confirm(`A save named "${name}" already exists.\n\nOverwrite it with the uploaded file? A backup will be created automatically.`)) {
      await _doSaveUpload(filename, base64, setAsDefault, true, null);
    } else {
      _pendingSaveUpload = null;
    }
    return;
  }

  if (data?.success) {
    _pendingSaveUpload = null;
    let msg = 'Save uploaded. Restart the container to apply.';
    if (data.defaultApplied) msg = 'Save uploaded and set as active. Restart to apply.';
    if (data.defaultSkipped) msg += ' Multiple saves found — active save unchanged.';
    showToast(msg, 'success');
    showRestartModal('Save uploaded. Restart the container to apply.');
    loadSaves();
  } else {
    showToast(data?.error || 'Upload failed', 'error');
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

async function restoreBackup(filename) {
  if (!confirm(`Restore from "${filename}"?\n\nThis will overwrite all current saves and config, and stop the game. You will need to restart the server after.`)) return;
  const data = await API.post(`/api/saves/backups/${encodeURIComponent(filename)}/restore`);
  if (data?.success) {
    showToast('Backup restored', 'success');
    showRestartModal('Backup restored. Restart the server to apply.');
  } else {
    showToast(data?.error || 'Restore failed', 'error');
  }
}

async function handleBackupUpload(input) {
  if (!input.files?.[0]) return;
  const file = input.files[0];
  if (!file.name.endsWith('.zip')) { showToast('Only .zip backup archives supported', 'error'); return; }

  setText('backupUploadStatus', 'Uploading...');
  try {
    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = reader.result.split(',')[1];
      input.value = '';
      const data = await API.post('/api/saves/backups/upload', { filename: file.name, data: base64 });
      setText('backupUploadStatus', '');
      if (data?.success) {
        showToast('Backup restored', 'success');
        showRestartModal('Backup restored. Restart the server to apply.');
        loadSaves();
      } else {
        showToast(data?.error || 'Restore failed', 'error');
      }
    };
    reader.readAsDataURL(file);
  } catch {
    setText('backupUploadStatus', '');
    showToast('Upload failed', 'error');
  }
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

  const TOP_GROUPS        = new Set(['Server', 'Updates']);
  const ADVANCED_GROUPS   = new Set(['VNC & Display', 'Stability', 'Monitoring']);
  const COLLAPSIBLE_GROUPS = new Set(['Backup', 'Performance', 'Updates']);

  const deferredTzPickers = [];

  for (const group of data.groups) {
    if (ADVANCED_GROUPS.has(group.name)) continue; // handled separately below

    const target = (containerTop && TOP_GROUPS.has(group.name)) ? containerTop : container;

    let card, rowTarget;
    if (COLLAPSIBLE_GROUPS.has(group.name)) {
      card = document.createElement('details');
      card.className = 'card admin-cred-details';
      const sum = document.createElement('summary');
      sum.textContent = group.name;
      card.appendChild(sum);
      rowTarget = document.createElement('div');
      rowTarget.style.paddingTop = '12px';
      card.appendChild(rowTarget);
    } else {
      card = document.createElement('div');
      card.className = 'card config-group';
      card.innerHTML = `<div class="config-group-title">${escapeHtml(group.name)}</div>`;
      rowTarget = card;
    }

    for (const item of group.items) {
      const row = _buildConfigRow(item);
      if (item.type === 'timezone') {
        deferredTzPickers.push({ id: `cfg-tz-${item.key}`, value: item.value || item.default || 'UTC', key: item.key });
      }
      rowTarget.appendChild(row);
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
           <span id="configServerStatusBadge" style="display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--text-secondary);font-weight:500">
             <span class="status-dot ${statusCls}"></span>${escapeHtml(statusText)}
           </span>
           <button id="serverToggleBtn" class="btn btn-sm ${running ? 'btn-danger' : 'btn-success'}" type="button"
             onclick="${running ? 'stopServer()' : 'startServer()'}"${_dis}>${running ? 'Stop Server' : 'Start Server'}</button>
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
           <span id="configRemoteStatusBadge" style="display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--text-secondary);font-weight:500">
             <span class="status-dot ${remCls}"></span>${escapeHtml(remText)}
           </span>
           ${remBtnHtml}
         </div>`;

      card.insertBefore(remoteRow, card.firstChild.nextSibling);
      card.insertBefore(statusRow, card.firstChild.nextSibling);

      // Multi-Instance toggle row
      const multiRow = document.createElement('div');
      multiRow.className = 'config-item';
      multiRow.innerHTML =
        `<div>
           <div class="config-label">Multi-Instance</div>
           <div class="config-help">Show the Servers tab to manage and switch between multiple StardropHost instances on this machine.</div>
         </div>
         <div class="config-value">
           <label class="toggle">
             <input type="checkbox" ${_serversEnabled ? 'checked' : ''} onchange="_setMultiInstanceEnabled(this.checked)">
             <span class="toggle-slider"></span>
           </label>
         </div>`;
      card.appendChild(multiRow);

    }

    // Updates card — inject dot into summary, notifs + Check Now into rowTarget
    if (group.name === 'Updates') {
      const summaryEl = card.querySelector('summary');
      if (summaryEl) {
        const dot = document.createElement('span');
        dot.id = 'updatesCardDot';
        dot.className = 'notif-dot';
        dot.style.cssText = 'display:none;background:var(--danger,#ef4444);margin-right:8px;flex-shrink:0;vertical-align:middle';
        summaryEl.insertBefore(dot, summaryEl.firstChild);
      }

      const cfgPanelNotif = document.createElement('div');
      cfgPanelNotif.id = 'configPanelUpdateNotif';
      cfgPanelNotif.style.display = 'none';
      rowTarget.appendChild(cfgPanelNotif);

      const cfgGameNotif = document.createElement('div');
      cfgGameNotif.id = 'configGameUpdateNotif';
      cfgGameNotif.style.display = 'none';
      rowTarget.appendChild(cfgGameNotif);

      const checkRow = document.createElement('div');
      checkRow.style.cssText = 'padding:6px 0';
      checkRow.innerHTML = `<button class="btn btn-secondary" id="checkUpdatesBtn" type="button" onclick="checkAllUpdates()">Check Now</button>`;
      rowTarget.appendChild(checkRow);
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
    summary.innerHTML = `Advanced Settings <span style="font-size:12px;color:var(--text-muted);font-weight:400;margin-left:6px">Admin · VNC · Stability · Monitoring</span>`;
    details.appendChild(summary);

    const advInner = document.createElement('div');
    advInner.style.cssText = 'padding-top:12px;display:flex;flex-direction:column;gap:12px';

    // Admin credentials card
    const adminCard = document.createElement('details');
    adminCard.className = 'card admin-cred-details';
    adminCard.id = 'adminCredCard';
    adminCard.innerHTML = `
      <summary>Change Admin Credentials</summary>
      <div style="margin-top:14px">
        <div style="margin-bottom:10px">
          <label class="config-label" for="newUsername">New Username <span style="color:var(--text-muted);font-weight:400">(optional)</span></label>
          <div style="margin-top:6px"><input type="text" id="newUsername" class="input" placeholder="Leave blank to keep current" style="width:100%;max-width:300px"></div>
        </div>
        <div style="margin-bottom:10px">
          <label class="config-label" for="oldPassword">Current Password</label>
          <div style="margin-top:6px"><input type="password" id="oldPassword" class="input" placeholder="Required to confirm changes" style="width:100%;max-width:300px"></div>
        </div>
        <div style="margin-bottom:10px">
          <label class="config-label" for="newPassword">New Password</label>
          <div style="margin-top:6px"><input type="password" id="newPassword" class="input" placeholder="Minimum 8 characters" style="width:100%;max-width:300px"></div>
        </div>
        <div style="margin-bottom:14px">
          <label class="config-label" for="confirmNewPassword">Confirm New Password</label>
          <div style="margin-top:6px"><input type="password" id="confirmNewPassword" class="input" placeholder="Re-enter new password" style="width:100%;max-width:300px"></div>
        </div>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:14px;padding:10px 12px;background:var(--bg-tertiary);border-radius:6px;line-height:1.7">
          <div style="font-weight:600;margin-bottom:2px">Requirements</div>
          <div>• Username: at least 3 characters (letters, numbers, _ . -)</div>
          <div>• Password: minimum 8 characters</div>
          <div>• New passwords must match</div>
        </div>
        <button class="btn btn-primary" type="button" onclick="changePassword()">Update Credentials</button>
      </div>`;
    // VNC card — loadVnc() fills #vncPanel after we append to DOM
    const vncCard = document.createElement('div');
    vncCard.className = 'card';
    vncCard.innerHTML = '<div class="config-group-title">VNC Settings</div><div id="vncPanel"><div class="empty-state">Loading VNC status...</div></div>';
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

    // Admin credentials card — at the bottom
    advInner.appendChild(adminCard);

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
  // Optimistic UI — swap button immediately
  const btn = document.querySelector('#vncPanel .action-buttons button');
  if (btn) { btn.disabled = true; btn.textContent = 'Starting…'; }
  const vncBadge = document.getElementById('vncTopbarBadge');
  if (vncBadge) vncBadge.style.display = '';
  const data = await API.post('/api/vnc/enable');
  if (data?.success) { showToast('VNC enabled', 'success'); loadVnc(); }
  else {
    showToast(data?.error || 'Failed to enable VNC', 'error');
    if (vncBadge) vncBadge.style.display = 'none';
    loadVnc();
  }
}

async function vncDisable() {
  if (!confirm('Disable VNC? Active connections will be dropped.')) return;
  // Optimistic UI — swap button immediately
  const btn = document.querySelector('#vncPanel .action-buttons button');
  if (btn) { btn.disabled = true; btn.textContent = 'Stopping…'; }
  const vncBadge = document.getElementById('vncTopbarBadge');
  if (vncBadge) vncBadge.style.display = 'none';
  const data = await API.post('/api/vnc/disable');
  if (data?.success) { showToast('VNC disabled', 'success'); setTimeout(loadVnc, 1500); }
  else {
    showToast(data?.error || 'Failed to disable VNC', 'error');
    if (vncBadge) vncBadge.style.display = '';
    loadVnc();
  }
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
    : '<div class="mod-item"><div class="mod-info"><div class="mod-name" style="color:var(--text-secondary)">No user mods installed</div></div></div>';

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
      showRestartModal('Mod uploaded. Restart the server to load it.');
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
    showRestartModal('Mod removed. Restart the server to unload it.');
    loadMods();
  } else {
    showToast(data?.error || 'Delete failed', 'error');
  }
}

// ─── Actions ─────────────────────────────────────────────────────
async function triggerGameRestart() {
  isGameRestarting       = true;
  gameRestartInitiatedAt = Date.now();
  navigateTo('dashboard');
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
  document.getElementById('frStep1').style.display = '';
  document.getElementById('frStep2').style.display = 'none';
  document.getElementById('frConfirmInput').value = '';
  document.getElementById('frPasswordError').style.display = 'none';
}

function frNextStep() {
  document.getElementById('frStep1').style.display = 'none';
  document.getElementById('frStep2').style.display = '';
  document.getElementById('frPasswordError').style.display = 'none';
  document.getElementById('frConfirmInput').value = '';
  document.getElementById('frConfirmInput').focus();
}

function frCheckInput() {}

async function confirmFactoryReset() {
  const btn      = document.getElementById('frConfirmBtn');
  const pwInput  = document.getElementById('frConfirmInput');
  const pwErr    = document.getElementById('frPasswordError');
  const password = pwInput.value.trim();

  if (!password) { pwErr.textContent = 'Password required'; pwErr.style.display = ''; pwInput.focus(); return; }

  btn.disabled = true; btn.textContent = 'Verifying...';
  pwErr.style.display = 'none';

  const check = await API.post('/api/auth/verify-password', { password }).catch(() => null);
  if (!check?.valid) {
    pwErr.textContent = 'Incorrect password'; pwErr.style.display = '';
    btn.disabled = false; btn.textContent = 'Delete Everything';
    pwInput.select(); return;
  }

  btn.textContent = 'Resetting...';
  const data = await API.post('/api/wizard/factory-reset');
  if (data?.success) {
    closeFactoryResetModal();
    showToast('Reset complete — restarting setup wizard…', 'success');
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

// ── Update Screen ────────────────────────────────────────────────
let _updateElapsedTimer  = null;
let _updateStatusPoll    = null;
let _updatePanelWentDown = false;
let _updateLogLines      = [];
let _updateSteps         = [];  // accumulated step messages (trailing dots stripped)
let _updateDotInterval   = null;
let _updateDotCount      = 1;

function showUpdateScreen(startedAt) {
  const ts = startedAt || Date.now();
  localStorage.setItem('stardrop_updating', ts);

  document.getElementById('app').style.display        = 'none';
  const loader = document.getElementById('app-loader');
  if (loader) loader.classList.add('hidden');
  const screen = document.getElementById('update-screen');
  if (screen) screen.style.display = 'flex';

  _updatePanelWentDown = false;
  _updateLogLines      = [];
  _updateSteps         = [];
  if (_updateDotInterval) { clearInterval(_updateDotInterval); _updateDotInterval = null; }
  _updateDotCount = 1;
  _setUpdateStatus('Starting update...');

  // Start elapsed timer
  if (_updateElapsedTimer) clearInterval(_updateElapsedTimer);
  const _elapsedEl = document.getElementById('updateElapsed');
  if (_elapsedEl) {
    _elapsedEl.textContent = '0:00';
    _updateElapsedTimer = setInterval(() => {
      const secs = Math.floor((Date.now() - ts) / 1000);
      const m = Math.floor(secs / 60), s = secs % 60;
      _elapsedEl.textContent = `${m}:${String(s).padStart(2, '0')}`;
      // Auto-exit after 5 minutes — successful update takes under 2 min; longer means error
      if (secs >= 300) {
        clearInterval(_updateElapsedTimer);
        clearInterval(_updateStatusPoll);
        localStorage.removeItem('stardrop_updating');
        history.replaceState(null, '', '/#dashboard'); window.location.reload();
      }
    }, 1000);
  }

  _startUpdateStatusPoll();
}


function _startUpdateStatusPoll() {
  if (_updateStatusPoll) clearInterval(_updateStatusPoll);
  _updateStatusPoll = setInterval(async () => {
    let panelUp = false;
    try {
      const res = await fetch('/api/auth/status', { cache: 'no-store' });
      panelUp = res.ok;
    } catch { panelUp = false; }

    if (panelUp) {
      if (_updatePanelWentDown) {
        // Panel came back up after going down — update complete
        clearInterval(_updateStatusPoll);
        clearInterval(_updateElapsedTimer);
        localStorage.removeItem('stardrop_updating');
        history.replaceState(null, '', '/#dashboard'); window.location.reload();
        return;
      }
      // Panel still up — check if update is still active
      try {
        const r = await fetch('/api/server/update-status', {
          headers: { 'Authorization': 'Bearer ' + (API.token || '') }, cache: 'no-store' });
        const d = await r.json();
        if (d.active && d.message) {
          _setUpdateStatus(d.message);
        }
      } catch {}
    } else {
      if (!_updatePanelWentDown) {
        _updatePanelWentDown = true;
        _setUpdateStatus('Restarting containers...');
        _addUpdateLog('Dashboard offline — restarting containers');
      }
    }
  }, 2000);
}

function _renderUpdateSteps() {
  const el = document.getElementById('updateStepList');
  if (!el) return;
  el.innerHTML = _updateSteps.map((step, i) => {
    const isCurrent = i === _updateSteps.length - 1;
    const icon  = isCurrent
      ? ''
      : `<span style="color:#22c55e;flex-shrink:0;font-size:13px;line-height:1">✓</span>`;
    const color = isCurrent ? '#e5e3f0' : '#6b6490';
    // Dots live in their own fixed-width span so the row never shifts as they cycle
    const dotsSpan = isCurrent
      ? `<span id="update-step-dots" style="display:inline-block;width:2.2em">${'.'.repeat(_updateDotCount)}</span>`
      : '';
    return `<div style="display:flex;align-items:center;gap:8px;font-size:13px;color:${color};font-weight:${isCurrent ? 500 : 400}">${icon}<span>${escapeHtml(step)}${dotsSpan}</span></div>`;
  }).join('');
}

function _setUpdateStatus(msg) {
  if (!msg) return;
  // Strip trailing dots — we animate them ourselves
  const base = msg.replace(/\.+$/, '').trim();
  if (!base) return;
  // Deduplicate consecutive identical steps
  if (_updateSteps.length && _updateSteps[_updateSteps.length - 1] === base) return;

  // Clear previous dot animation
  if (_updateDotInterval) { clearInterval(_updateDotInterval); _updateDotInterval = null; }

  _updateSteps.push(base);
  _updateDotCount = 1;
  _renderUpdateSteps();

  // Animate dots on the current step: cycles 1 → 2 → 3 → 4 → 5 → 1 …
  _updateDotInterval = setInterval(() => {
    _updateDotCount = _updateDotCount >= 5 ? 1 : _updateDotCount + 1;
    const dots = document.getElementById('update-step-dots');
    if (dots) dots.textContent = '.'.repeat(_updateDotCount);
  }, 400);
}

function _addUpdateLog(msg) {
  _updateLogLines.push(msg);
  if (_updateLogLines.length > 30) _updateLogLines.shift();
  const el = document.getElementById('updateLog');
  if (!el) return;
  el.innerHTML = _updateLogLines.map(l => `<div>${escapeHtml(l)}</div>`).join('');
  el.scrollTop = el.scrollHeight;
}

async function reloadUpdateScreen() {
  const btn = document.querySelector('#update-screen button');
  try {
    const res = await fetch('/api/auth/status', { cache: 'no-store' });
    if (res.ok) {
      localStorage.removeItem('stardrop_updating');
      history.replaceState(null, '', '/#dashboard'); window.location.reload();
      return;
    }
  } catch {}
  // Not up yet
  if (btn) {
    const orig = btn.textContent;
    btn.textContent = 'Not ready yet — try again in a moment';
    setTimeout(() => { btn.textContent = orig; }, 3000);
  }
}

async function killUpdate() {
  if (!confirm(
    'Return to dashboard?\n\n' +
    'If an update is still in progress, a cancel signal will be sent to stop it.'
  )) return;

  try {
    await fetch('/api/server/cancel-update', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + (API.token || ''), 'Content-Type': 'application/json' },
      cache: 'no-store',
    });
  } catch {}

  clearInterval(_updateElapsedTimer);
  clearInterval(_updateStatusPoll);
  localStorage.removeItem('stardrop_updating');
  history.replaceState(null, '', '/#dashboard'); window.location.reload();
}

// Legacy alias — kept so any remaining callers don't break
function startUpdateReconnectPolling() { showUpdateScreen(); }

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

let _guIsGog = false;

function openGameUpdateModal() {
  _guGuardAttempted = false;
  _guIsGog = _gameProvider === 'gog';

  // Show the right step 1
  const gogStep1 = document.getElementById('guGogStep1');
  if (_guIsGog) {
    document.getElementById('guStep1').style.display = 'none';
    if (gogStep1) {
      gogStep1.style.display = '';
      // Populate auth URL
      API.get('/api/gog/auth-url').then(d => {
        const link = document.getElementById('guGogAuthUrl');
        if (link && d?.url) { link.href = d.url; link.textContent = 'Open GOG auth page'; }
      }).catch(() => {});
    }
  } else {
    document.getElementById('guStep1').style.display = '';
    if (gogStep1) gogStep1.style.display = 'none';
    document.getElementById('guUsername').value = '';
    document.getElementById('guPassword').value = '';
    if (document.getElementById('guGuardCode')) document.getElementById('guGuardCode').value = '';
  }

  document.getElementById('guStep2').style.display = 'none';
  document.getElementById('guStep3').style.display = 'none';
  const guLogEl = document.getElementById('guLog');
  if (guLogEl) { guLogEl.textContent = ''; delete guLogEl.dataset.lineCount; }
  document.getElementById('gameUpdateModal').style.display = '';
}

function closeGameUpdateModal() {
  document.getElementById('gameUpdateModal').style.display = 'none';
  if (_guPollTimer) { clearTimeout(_guPollTimer); _guPollTimer = null; }
}

async function gogUpdateLogin() {
  const gogStep1   = document.getElementById('guGogStep1');
  const redirectEl = document.getElementById('guGogRedirect');
  const errEl      = document.getElementById('guGogError');
  const btn        = document.getElementById('guGogLoginBtn');

  function showErr(msg) {
    if (errEl) { errEl.textContent = msg; errEl.style.display = ''; }
  }
  function clearErr() {
    if (errEl) { errEl.textContent = ''; errEl.style.display = 'none'; }
  }

  const redirectUrl = redirectEl?.value?.trim();
  if (!redirectUrl) { showErr('Paste the redirect URL first.'); return; }

  clearErr();
  if (btn) { btn.disabled = true; btn.textContent = 'Starting…'; }

  // Start container
  try {
    await API.post('/api/gog/container/start');
  } catch {
    showErr('❌ Could not start GOG service.');
    if (btn) { btn.disabled = false; btn.textContent = 'Login & Download Update'; }
    return;
  }

  // Wait for readiness (up to 20s)
  if (btn) btn.textContent = 'Waiting for service…';
  let ready = false;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try { const s = await API.get('/api/gog/status'); if (s?.state !== 'unavailable') { ready = true; break; } } catch {}
  }
  if (!ready) {
    showErr('❌ GOG service failed to start.');
    if (btn) { btn.disabled = false; btn.textContent = 'Login & Download Update'; }
    return;
  }

  // Login
  if (btn) btn.textContent = 'Logging in…';
  try {
    const data = await API.post('/api/gog/login', { redirectUrl });
    if (!data?.success) {
      showErr(`❌ ${data?.error || 'Login failed — check URL and try again.'}`);
      if (btn) { btn.disabled = false; btn.textContent = 'Login & Download Update'; }
      return;
    }
  } catch (e) {
    showErr(`❌ ${e.message || 'Network error'}`);
    if (btn) { btn.disabled = false; btn.textContent = 'Login & Download Update'; }
    return;
  }

  // Kick off download, transition to step 3
  try { await API.post('/api/gog/download'); } catch {}

  if (gogStep1) gogStep1.style.display = 'none';
  const step3 = document.getElementById('guStep3');
  if (step3) step3.style.display = '';
  const guStatus = document.getElementById('guStatus');
  if (guStatus) { guStatus.textContent = 'Downloading from GOG…'; guStatus.style.color = 'var(--accent)'; }
  const guLog = document.getElementById('guLog');
  if (guLog) { guLog.textContent = ''; delete guLog.dataset.lineCount; }
  const doneBtn    = document.getElementById('guDoneBtn');
  const restartBtn = document.getElementById('guRestartBtn');
  if (doneBtn)    doneBtn.style.display = 'none';
  if (restartBtn) restartBtn.style.display = 'none';

  _guStartPolling();
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
  navigateTo('dashboard');
  await API.post('/api/server/restart').catch(() => null);
  showToast('Server restarting with updated game files...', 'success');
  _pollServerState(true, 120000);
}

function _guStartPolling() {
  if (_guPollTimer) clearTimeout(_guPollTimer);
  _guPoll();
}

async function _guPoll() {
  const statusEl   = document.getElementById('guStatus');
  const logEl      = document.getElementById('guLog');
  const doneBtn    = document.getElementById('guDoneBtn');
  const restartBtn = document.getElementById('guRestartBtn');

  // ── GOG branch ─────────────────────────────────────────────────
  if (_guIsGog) {
    const gogData = await API.get('/api/gog/log').catch(() => null);
    if (!gogData) { _guPollTimer = setTimeout(_guPoll, 3000); return; }

    // Append new log lines
    if (logEl && gogData.lines?.length) {
      const existing = logEl.dataset.lineCount ? parseInt(logEl.dataset.lineCount) : 0;
      const newLines = gogData.lines.slice(existing);
      if (newLines.length) {
        if (existing === 0) logEl.textContent = '';
        newLines.forEach(line => {
          logEl.textContent += line + '\n';
        });
        logEl.dataset.lineCount = gogData.lines.length;
        logEl.scrollTop = logEl.scrollHeight;
      }
    }

    const state = gogData.state;
    if (statusEl) {
      statusEl.textContent =
        state === 'logging-in'  ? 'Logging in to GOG…' :
        state === 'logged-in'   ? 'Logged in — preparing download…' :
        state === 'downloading' ? 'Downloading game files…' :
        state === 'done'        ? 'Download complete!' :
        state === 'error'       ? `Error: ${gogData.error || 'Download failed'}` :
                                  'Working…';
      statusEl.style.color = state === 'error' ? '#ef4444' : 'var(--accent)';
    }

    if (state === 'done') {
      try { await API.post('/api/gog/record-version'); } catch {}
      API.post('/api/gog/container/stop').catch(() => null);
      if (doneBtn)    doneBtn.style.display = '';
      if (restartBtn) restartBtn.style.display = '';
      const notif = document.getElementById('gameUpdateNotification');
      if (notif) notif.style.display = 'none';
      return;
    }
    if (state === 'error') {
      API.post('/api/gog/container/stop').catch(() => null);
      if (doneBtn) doneBtn.style.display = '';
      return;
    }
    _guPollTimer = setTimeout(_guPoll, 3000);
    return;
  }
  // ── end GOG branch ─────────────────────────────────────────────

  const data = await API.get('/api/game-update/status').catch(() => null);
  if (!data) { _guPollTimer = setTimeout(_guPoll, 3000); return; }

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

  // Show "Update all instances" checkbox only when peers are registered.
  // _serversPeers is only loaded when the Servers tab has been visited,
  // so fetch from the API directly to get the current peer count.
  const allRow   = document.getElementById('selfUpdateAllRow');
  const allCheck = document.getElementById('selfUpdateAllCheck');
  if (allRow && allCheck && _serversEnabled) {
    try {
      const d = await API.get('/api/instances');
      const hasPeers = (d?.peers?.length || 0) > 0;
      allRow.style.display = hasPeers ? 'flex' : 'none';
      allCheck.checked     = hasPeers;
    } catch {
      allRow.style.display = 'none';
    }
  } else if (allRow) {
    allRow.style.display = 'none';
  }

  document.getElementById('selfUpdateModal').style.display = '';
}

function closeSelfUpdateModal() {
  document.getElementById('selfUpdateModal').style.display = 'none';
  const pwInput = document.getElementById('selfUpdatePasswordInput');
  const pwErr   = document.getElementById('selfUpdatePasswordError');
  if (pwInput) pwInput.value = '';
  if (pwErr)   pwErr.style.display = 'none';
}

async function confirmSelfUpdate() {
  const btn      = document.getElementById('selfUpdateConfirmBtn');
  const allCheck = document.getElementById('selfUpdateAllCheck');
  const pwInput  = document.getElementById('selfUpdatePasswordInput');
  const pwErr    = document.getElementById('selfUpdatePasswordError');

  const password = pwInput?.value?.trim() || '';
  if (!password) {
    if (pwErr) { pwErr.textContent = 'Password required'; pwErr.style.display = ''; }
    pwInput?.focus();
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Verifying...';
  if (pwErr) pwErr.style.display = 'none';

  const check = await API.post('/api/auth/verify-password', { password }).catch(() => null);
  if (!check?.valid) {
    if (pwErr) { pwErr.textContent = 'Incorrect password'; pwErr.style.display = ''; }
    btn.disabled = false;
    btn.textContent = 'Update Now';
    pwInput?.select();
    return;
  }

  btn.textContent = 'Updating...';
  const updateAll = !!(allCheck?.checked && allCheck.closest('#selfUpdateAllRow')?.style.display !== 'none');
  const data = await API.post('/api/server/update', { updateAll }).catch(() => null);
  if (data?.success || data?.action === 'update') {
    closeSelfUpdateModal();
    showUpdateScreen(Date.now());
  } else {
    showToast(data?.error || 'Update failed', 'error');
    btn.disabled = false;
    btn.textContent = 'Update Now';
  }
}

// ─── Install New Instance ─────────────────────────────────────────

let _installRunning  = false;
let _installPollTimer = null;
let _installKnownPeerCount = 0;

function openInstallModal() {
  _installRunning = false;
  document.getElementById('installConfirmView').style.display = '';
  document.getElementById('installProgressView').style.display = 'none';
  document.getElementById('installPasswordInput').value = '';
  document.getElementById('installPasswordError').style.display = 'none';
  document.getElementById('installConfirmBtn').disabled = false;
  document.getElementById('installConfirmBtn').textContent = 'Install';
  document.getElementById('installInstanceModal').style.display = '';
  setTimeout(() => document.getElementById('installPasswordInput').focus(), 50);
}

function closeInstallModal() {
  document.getElementById('installInstanceModal').style.display = 'none';
  if (_installPollTimer) { clearInterval(_installPollTimer); _installPollTimer = null; }
}

async function startInstallInstance() {
  const btn     = document.getElementById('installConfirmBtn');
  const pwInput = document.getElementById('installPasswordInput');
  const pwErr   = document.getElementById('installPasswordError');

  const password = pwInput?.value?.trim() || '';
  if (!password) {
    pwErr.textContent = 'Password required'; pwErr.style.display = '';
    pwInput?.focus(); return;
  }

  btn.disabled = true; btn.textContent = 'Verifying...';
  pwErr.style.display = 'none';

  const check = await API.post('/api/auth/verify-password', { password }).catch(() => null);
  if (!check?.valid) {
    pwErr.textContent = 'Incorrect password'; pwErr.style.display = '';
    btn.disabled = false; btn.textContent = 'Install';
    pwInput?.select(); return;
  }

  const data = await API.post('/api/install-instance').catch(() => null);
  if (!data?.success) {
    showToast(data?.error || 'Failed to start installation', 'error');
    btn.disabled = false; btn.textContent = 'Install'; return;
  }

  _installRunning = true;
  _installKnownPeerCount = _serversPeers.length;
  document.getElementById('installConfirmView').style.display = 'none';
  document.getElementById('installProgressView').style.display = '';
  document.getElementById('installLogBox').textContent = 'Starting…';

  _installPollTimer = setInterval(_pollInstall, 2000);
}

async function _pollInstall() {
  const data = await API.get('/api/install-instance/log').catch(() => null);
  if (!data) return;

  const box = document.getElementById('installLogBox');
  if (box && data.lines?.length) {
    box.textContent = data.lines.join('\n');
    box.scrollTop = box.scrollHeight;
  }

  const label = document.getElementById('installProgressLabel');

  if (data.status === 'done') {
    clearInterval(_installPollTimer); _installPollTimer = null;
    _installRunning = false;
    if (label) label.textContent = 'Installation complete — detecting new instance…';
    // Poll instances until a new peer appears, then refresh and close
    let attempts = 0;
    const detectTimer = setInterval(async () => {
      attempts++;
      const inst = await API.get('/api/instances').catch(() => null);
      const peerCount = inst?.peers?.length || 0;
      if (peerCount > _installKnownPeerCount || attempts > 15) {
        clearInterval(detectTimer);
        closeInstallModal();
        loadServersPage();
        if (peerCount > _installKnownPeerCount) showToast('New instance detected', 'success');
      }
    }, 2000);
  } else if (data.status === 'error') {
    clearInterval(_installPollTimer); _installPollTimer = null;
    _installRunning = false;
    if (label) label.textContent = 'Installation failed — see log above';
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

// ─── Admin password prompt (inline modal-free helper) ────────────
// Shows a browser prompt for password and verifies it server-side.
// Returns the password string on success, null on cancel/failure.
async function _promptAdminPassword(message) {
  const password = window.prompt(message || 'Enter admin password to confirm');
  if (!password) return null;
  const check = await API.post('/api/auth/verify-password', { password }).catch(() => null);
  if (!check?.valid) { showToast('Incorrect password', 'error'); return null; }
  return password;
}

// ─── Servers (multi-instance) ────────────────────────────────────

let _serversEnabled  = !!localStorage.getItem('stardrop_servers_enabled');
let _serversPeers    = [];  // loaded from API
let _selfContainerIp = '';  // container IP from /api/instances self.host
let _serversEditMode = false;

function _toggleServersMenu(e) {
  e.stopPropagation();
  const m = document.getElementById('serversMenu');
  if (!m) return;
  const open = m.style.display !== 'none';
  m.style.display = open ? 'none' : '';
  if (!open) { setTimeout(() => document.addEventListener('click', _closeServersMenu, { once: true }), 0); }
}
function _closeServersMenu() {
  const m = document.getElementById('serversMenu');
  if (m) m.style.display = 'none';
}
function _enterServersEditMode() { _serversEditMode = true;  loadServersPage(); }
function _exitServersEditMode()  { _serversEditMode = false; loadServersPage(); }

// On page load — if URL contains ?peers=... auto-import them then clean URL
async function _checkIncomingPeers() {
  const params = new URLSearchParams(window.location.search);
  const encoded = params.get('peers');
  if (!encoded) return;

  // Clean URL immediately before any async work
  const url = new URL(window.location.href);
  url.searchParams.delete('peers');
  history.replaceState(null, '', url.pathname + url.hash);

  try {
    const incoming = JSON.parse(atob(encoded));
    if (!Array.isArray(incoming) || !incoming.length) return;

    // Use the server's real panel port — window.location.port may be a
    // playit.gg tunnel port which would cause ghost peer entries.
    let selfPort = lastStatusData?.panelPort || null;
    if (!selfPort) {
      try { const d = await API.get('/api/instances'); selfPort = d?.self?.port || null; } catch {}
    }
    selfPort = selfPort || parseInt(window.location.port || '18642', 10);

    incoming.forEach(p => {
      if (!p.host || !p.port) return;
      if (p.port === selfPort) return;
      API.post('/api/instances/peer', { name: p.name || p.host, host: p.host, port: p.port })
        .catch(() => null);
    });
    if (!_serversEnabled) _setMultiInstanceEnabled(true);
  } catch {}
}

function _setMultiInstanceEnabled(enabled) {
  _serversEnabled = enabled;
  if (enabled) {
    localStorage.setItem('stardrop_servers_enabled', '1');
  } else {
    localStorage.removeItem('stardrop_servers_enabled');
    if (currentPage === 'servers') navigateTo('config');
  }
  _updateServersNav();
  // Re-render the config Server card to reflect the toggle state
  if (currentPage === 'config') loadConfig();
}

async function loadServersPage() {
  const container = document.getElementById('serversContainer');
  if (!container) return;

  let data;
  try { data = await API.get('/api/instances'); } catch { data = { self: {}, peers: [] }; }

  const self  = data.self  || {};
  const peers = data.peers || [];
  _serversPeers = peers;
  if (self.host) _selfContainerIp = self.host;

  const selfHost = _cachedLanIp || window.location.hostname;
  const selfPort = self.port || parseInt(window.location.port || '18642', 10);

  // Auto-scan sibling ports in background — registers any discovered instances silently
  _scanForInstances(selfHost, selfPort, peers);

  const selfFarmName = self.name || '';

  // -- Current instance card --
  let html = `
    <div class="card" style="margin-bottom:12px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
        <div>
          <div style="font-size:11px;font-weight:600;color:var(--accent);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Current Instance</div>
          ${selfFarmName ? `<div style="font-weight:600;font-size:15px;margin-bottom:2px">${escapeHtml(selfFarmName)}</div>` : ''}
          <div style="font-size:12px;color:var(--text-muted)">Port ${selfPort}</div>
        </div>
      </div>
    </div>`;

  // -- Manage toolbar (above peer cards) --
  html += `
    <div style="display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-bottom:12px">
      ${_serversEditMode ? `<button class="btn btn-sm btn-secondary" type="button" onclick="_exitServersEditMode()">Confirm</button>` : ''}
      <div style="position:relative">
        <button class="btn btn-sm btn-secondary" type="button" onclick="_toggleServersMenu(event)">Manage ▾</button>
        <div id="serversMenu" style="display:none;position:absolute;top:calc(100% + 4px);right:0;background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;min-width:150px;z-index:100;overflow:hidden">
          <div style="padding:8px 14px;cursor:pointer;font-size:13px" onmouseenter="this.style.background='var(--bg-tertiary)'" onmouseleave="this.style.background=''" onclick="_closeServersMenu();openInstallModal()">Install</div>
          <div style="padding:8px 14px;cursor:pointer;font-size:13px" onmouseenter="this.style.background='var(--bg-tertiary)'" onmouseleave="this.style.background=''" onclick="_closeServersMenu();_enterServersEditMode()">Edit</div>
        </div>
      </div>
    </div>`;

  // -- Peer cards --
  if (peers.length === 0) {
    html += `
    <div style="text-align:center;padding:40px 16px;color:var(--text-muted);font-size:13px">
      No other instances found yet.<br>
      <span style="font-size:12px">Scanning for instances on this machine…</span>
    </div>`;
  } else {
    peers.forEach((s, i) => {
      const alias    = s.remoteAlias || '';
      const peerName = /^Instance \(port \d+\)$/.test(s.name) ? 'Connect to Setup' : (s.name || 'Connect to Setup');
      html += `
      <div class="card" style="margin-bottom:12px">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
          <div style="min-width:0">
            <div style="font-weight:600;font-size:15px;margin-bottom:4px">${escapeHtml(peerName)}</div>
            <div style="display:flex;align-items:flex-start;gap:16px">
              <div>
                <div style="display:flex;align-items:center;gap:6px;margin-bottom:2px">
                  <span id="peer-status-dot-${i}" class="status-dot offline"></span>
                  <span id="peer-status-label-${i}" style="font-size:12px;color:var(--text-muted)">—</span>
                  <span id="peer-players-${i}" style="font-size:12px;color:var(--text-muted)"></span>
                </div>
                <div style="font-size:11px;color:var(--text-muted)">${escapeHtml(s.host)}</div>
                <div style="font-size:11px;color:var(--text-muted)">Port ${s.port}</div>
              </div>
              <div id="peer-chat-${i}" style="display:none">
                <div style="display:flex;align-items:center;gap:5px;margin-bottom:2px">
                  <span class="notif-dot"></span>
                  <span style="font-size:12px;color:#ef4444">Chat</span>
                </div>
                <div id="peer-chat-label-${i}" style="font-size:11px;color:var(--text-muted)"></div>
              </div>
            </div>
          </div>
          <div style="display:flex;gap:8px;align-items:center;flex-shrink:0">
            <button class="btn btn-sm btn-primary" type="button" onclick="_connectToServer(${i})">Connect</button>
            <button class="btn btn-sm btn-icon" type="button" onclick="_removeServer(${i})" title="Remove" style="display:${_serversEditMode && !s.autoDiscovered ? '' : 'none'}">×</button>
          </div>
        </div>
        <div style="margin-top:10px;display:flex;align-items:center;gap:6px">
          <span style="font-size:11px;color:var(--text-muted);white-space:nowrap;flex-shrink:0">Remote alias</span>
          <input id="alias-input-${i}" class="input" type="text"
            style="width:220px;flex-shrink:0;font-size:12px;padding:4px 8px;height:28px"
            placeholder="http://host.playit.plus:1049"
            value="${escapeHtml(alias)}"
            oninput="_onAliasInput(${i})"
            onkeydown="if(event.key==='Enter'){_saveRemoteAlias(${i},this.value.trim());this.blur();}">
          <button id="alias-save-${i}" class="btn btn-sm btn-primary"
            style="height:28px;padding:0 10px;font-size:12px;display:${alias ? '' : 'none'}"
            onclick="_saveRemoteAliasBtn(${i})">Save</button>
          <button id="alias-clear-${i}" class="btn btn-sm btn-icon"
            style="height:28px;width:28px;display:${alias ? '' : 'none'}"
            onclick="_clearRemoteAlias(${i})" title="Remove alias">×</button>
        </div>
      </div>`;
    });
  }

  // "+" add button shown in edit mode (right-aligned, below cards)
  if (_serversEditMode) {
    html += `
    <div style="display:flex;justify-content:flex-end;margin-top:4px">
      <button class="btn btn-sm btn-secondary" type="button" onclick="openAddServerModal()" title="Add instance" style="font-size:18px;line-height:1;padding:2px 12px">+</button>
    </div>`;
  }

  container.innerHTML = html;

  // Fetch live status for each peer in the background
  if (peers.length) _refreshPeerStatuses(selfHost, peers);
}

async function _refreshPeerStatuses(selfHost, peers) {
  peers.forEach(async (peer, i) => {
    try {
      const resp = await fetch(`http://${selfHost}:${peer.port}/api/instances`,
        { signal: AbortSignal.timeout(3000) });
      if (!resp.ok) return;
      const d = await resp.json();
      const s = d?.self || {};

      const running = s.serverState === 'running';
      const dot     = document.getElementById(`peer-status-dot-${i}`);
      const label   = document.getElementById(`peer-status-label-${i}`);
      const players = document.getElementById(`peer-players-${i}`);

      if (dot)   { dot.className = `status-dot ${running ? 'running' : 'offline'}`; }
      if (label) { label.textContent = running ? 'Online' : 'Offline'; label.style.color = running ? '#22c55e' : 'var(--text-muted)'; }
      if (players) {
        players.textContent = (running && s.playerCount > 0)
          ? `· ${s.playerCount} player${s.playerCount !== 1 ? 's' : ''}` : '';
      }

      // Chat notification
      const lastTs  = s.lastChatTs || 0;
      const seenKey = `peer-chat-ts-${peer.port}`;
      const seenTs  = parseInt(localStorage.getItem(seenKey) || '0', 10);
      const chatEl  = document.getElementById(`peer-chat-${i}`);
      const chatLbl = document.getElementById(`peer-chat-label-${i}`);
      if (chatEl && lastTs > seenTs) {
        chatEl.style.display = '';
        if (chatLbl) chatLbl.textContent = `${_timeAgo(lastTs)} ago`;
      } else if (chatEl) {
        chatEl.style.display = 'none';
      }
    } catch {}
  });
}

function _timeAgo(ts) {
  const secs = Math.floor(Date.now() / 1000) - ts;
  if (secs < 60)  return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

// Scan sibling ports (18642–18651) for other StardropHost instances.
// Any found that aren't already known get registered as peers automatically.
async function _scanForInstances(selfHost, selfPort, knownPeers) {
  const BASE_PORT = 18642;
  const knownPorts = new Set([selfPort, ...knownPeers.map(p => p.port)]);
  let found = false;

  const checks = [];
  for (let port = BASE_PORT; port <= BASE_PORT + 9; port++) {
    if (knownPorts.has(port)) continue;
    checks.push((async () => {
      try {
        const res = await fetch(`http://${selfHost}:${port}/api/instances`,
          { signal: AbortSignal.timeout(2000) });
        if (!res.ok) return;
        const d = await res.json();
        if (!d?.self) return; // not a StardropHost instance
        // Register it as a peer — prefer the instance's own container IP over the scan host
        await API.post('/api/instances/peer', {
          name: d.self.name || 'Connect to Setup',
          host: d.self.host || selfHost,
          port,
          autoDiscovered: true,
        });
        found = true;
      } catch { /* port not running or timeout */ }
    })());
  }

  await Promise.all(checks);
  if (found) loadServersPage(); // refresh to show newly discovered instances
}

function openAddServerModal() {
  document.getElementById('addServerModal').style.display = 'flex';
  document.getElementById('addServerName').value = '';
  document.getElementById('addServerHost').value = '';
  document.getElementById('addServerPort').value = '18642';
  document.getElementById('addServerRemoteAlias').value = '';
  setTimeout(() => document.getElementById('addServerName').focus(), 50);
}

function closeAddServerModal() {
  document.getElementById('addServerModal').style.display = 'none';
}

async function submitAddServer() {
  const name        = document.getElementById('addServerName').value.trim();
  const host        = document.getElementById('addServerHost').value.trim();
  const port        = parseInt(document.getElementById('addServerPort').value.trim(), 10) || 18642;
  const remoteAlias = document.getElementById('addServerRemoteAlias').value.trim();
  if (!name) { showToast('Server name is required', 'error'); return; }
  if (!host) { showToast('Container IP is required', 'error'); return; }
  try {
    await API.post('/api/instances/peer', { name, host, port, ...(remoteAlias && { remoteAlias }) });
    closeAddServerModal();
    loadServersPage();
  } catch {
    showToast('Failed to save server', 'error');
  }
}

function _onAliasInput(idx) {
  const val       = document.getElementById(`alias-input-${idx}`)?.value.trim() || '';
  const saveBtn   = document.getElementById(`alias-save-${idx}`);
  const clearBtn  = document.getElementById(`alias-clear-${idx}`);
  const hasValue  = val.length > 0;
  if (saveBtn)  saveBtn.style.display  = hasValue ? '' : 'none';
  if (clearBtn) clearBtn.style.display = hasValue ? '' : 'none';
}

async function _saveRemoteAliasBtn(idx) {
  const input = document.getElementById(`alias-input-${idx}`);
  if (!input) return;
  await _saveRemoteAlias(idx, input.value.trim());
  showToast('Remote alias saved', 'success');
}

async function _clearRemoteAlias(idx) {
  const input = document.getElementById(`alias-input-${idx}`);
  if (input) input.value = '';
  _onAliasInput(idx);
  await _saveRemoteAlias(idx, '');
}

async function _saveRemoteAlias(idx, alias) {
  const s = _serversPeers[idx];
  if (!s) return;
  try {
    await API.post('/api/instances/peer', { name: s.name, host: s.host, port: s.port, remoteAlias: alias });
  } catch {
    showToast('Failed to save remote alias', 'error');
  }
}

async function _removeServer(idx) {
  if (!confirm('Remove this server from the list?')) return;
  try {
    await API.del(`/api/instances/peer/${idx}`);
    loadServersPage();
  } catch {
    showToast('Failed to remove server', 'error');
  }
}

// Returns true when the browser is accessing this dashboard remotely
// (i.e. not via a private/LAN IP address).
function _isRemoteAccess() {
  const h = window.location.hostname;
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(h)) return false;
  return true;
}

async function _connectToServer(idx) {
  const s = _serversPeers[idx];
  if (!s) return;

  const remote = _isRemoteAccess();
  const targetBase = remote && s.remoteAlias
    ? s.remoteAlias.replace(/\/?$/, '')
    : `${window.location.protocol}//${window.location.hostname}:${s.port}`;

  if (!confirm(`Switch to ${s.name || s.host}?\n\n${escapeHtml(targetBase)}`)) return;

  // Mark chat as seen for this peer
  localStorage.setItem(`peer-chat-ts-${s.port}`, String(Math.floor(Date.now() / 1000)));

  // Build peer list to pass to destination — includes self + all current peers.
  // Use the browser's own hostname (what the user actually connects to), not the
  // container-internal IP that hostname -I returns inside Docker.
  const selfData = {
    host: _selfContainerIp || _cachedLanIp || window.location.hostname,
    port: lastStatusData?.panelPort || parseInt(window.location.port || '18642', 10),
    name: lastStatusData?.live?.farmName || lastStatusData?.farmName || 'StardropHost',
  };
  const allPeers = [selfData, ..._serversPeers.filter((_, i) => i !== idx)];
  const encoded  = btoa(JSON.stringify(allPeers));

  window.location.href = `${targetBase}/?peers=${encoded}`;
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

// Fetches each known peer's /api/instances from the browser (same mechanism
// as the Servers tab scan) and returns the first peer with remoteActive: true.
async function _checkPeerRemoteStatus() {
  try {
    const data  = await API.get('/api/instances');
    const peers = (data.peers || []);
    const selfHost = _cachedLanIp || window.location.hostname;
    for (const peer of peers) {
      try {
        const resp = await fetch(`http://${selfHost}:${peer.port}/api/instances`,
          { signal: AbortSignal.timeout(2000) });
        if (!resp.ok) continue;
        const d = await resp.json();
        if (d?.self?.remoteActive) return { running: true, peerName: d.self.name || peer.name };
      } catch {}
    }
  } catch {}
  return { running: false };
}

async function loadRemoteStatus() {
  const loading    = document.getElementById('remoteLoading');
  const noConfig   = document.getElementById('remoteNoConfig');
  const configured = document.getElementById('remoteConfigured');

  try {
    const [data, addrs] = await Promise.all([
      API.get('/api/remote/status'),
      API.get('/api/remote/addresses').catch(() => null),
    ]);

    if (addrs) {
      _remoteAddressCache.game      = addrs.game      || '';
      _remoteAddressCache.dashboard = addrs.dashboard || '';
    }
    _populateConnectionAddresses();

    if (loading) loading.style.display = 'none';

    if (data.configured) {
      lastRemoteData = data;
      _remoteOptimisticState = null;
      _updateRemoteBadge();
      if (noConfig)   noConfig.style.display   = 'none';
      if (configured) configured.style.display = '';
      const addrCard = document.getElementById('remoteAddressCard');
      if (addrCard) addrCard.style.display = '';
      _renderRemoteServices(data.services || [], data.anyRunning);
      _remoteYaml = data.yaml || '';
      _lockComposeEntry(true);
    } else {
      // Check if a peer instance has an active tunnel via their public /api/instances
      const peer = await _checkPeerRemoteStatus();
      if (peer?.running) {
        lastRemoteData = { configured: true, anyRunning: true, fromPeer: true };
        _remoteOptimisticState = null;
        _updateRemoteBadge();
        if (noConfig)   noConfig.style.display   = 'none';
        if (configured) configured.style.display = '';
        const addrCard = document.getElementById('remoteAddressCard');
        if (addrCard) addrCard.style.display = '';
        _renderPeerRemoteServices(peer.peerName);
        _lockComposeEntry(true, true);
      } else {
        lastRemoteData = data;
        _remoteOptimisticState = null;
        _updateRemoteBadge();
        if (noConfig)   noConfig.style.display   = '';
        if (configured) configured.style.display = 'none';
        const addrCard = document.getElementById('remoteAddressCard');
        if (addrCard) addrCard.style.display = 'none';
        _remoteYaml = '';
        hideConfigYaml();
        _lockComposeEntry(false);
      }
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

function _populateConnectionAddresses() {
  // Cache LAN IP on first valid read — never overwrite with remote domain
  const rawIp = lastStatusData?.network?.joinIp || lastStatusData?.network?.localIps?.[0] || '';
  if (rawIp && rawIp !== '--' && !_cachedLanIp) _cachedLanIp = rawIp;
  const lanIp = _cachedLanIp || rawIp || '--';
  const gamePort = 24642;
  const dashPort = lastStatusData?.panelPort || 18642;

  // Remote tab — playit inputs (don't overwrite while user is typing)
  const gameInput = document.getElementById('remote-playit-game');
  const dashInput = document.getElementById('remote-playit-dash');
  if (gameInput && gameInput !== document.activeElement) gameInput.value = _remoteAddressCache.game;
  if (dashInput && dashInput !== document.activeElement) dashInput.value = _remoteAddressCache.dashboard;

  // Dashboard — remote access card
  const hasGame = !!_remoteAddressCache.game;
  const hasDash = !!_remoteAddressCache.dashboard;
  const dashCard = document.getElementById('dashboard-remote-card');
  if (dashCard) dashCard.style.display = (hasGame || hasDash) ? '' : 'none';

  const gameRow  = document.getElementById('dashboard-remote-game-row');
  const dashRow  = document.getElementById('dashboard-remote-dash-row');
  const gameAddr = document.getElementById('dashboard-remote-game-addr');
  const dashAddr = document.getElementById('dashboard-remote-dash-addr');
  if (gameRow)  gameRow.style.display  = hasGame ? '' : 'none';
  if (dashRow)  dashRow.style.display  = hasDash ? '' : 'none';
  if (gameAddr) gameAddr.textContent   = _remoteAddressCache.game;
  if (dashAddr) dashAddr.textContent   = _remoteAddressCache.dashboard;

}

function _remoteAddrDirty(type) {
  const btn = document.getElementById(type === 'game' ? 'remote-save-game-btn' : 'remote-save-dash-btn');
  if (btn) btn.style.display = '';
}

async function saveRemoteAddress(type) {
  const isGame = type === 'game';
  const input  = document.getElementById(isGame ? 'remote-playit-game' : 'remote-playit-dash');
  const btn    = document.getElementById(isGame ? 'remote-save-game-btn' : 'remote-save-dash-btn');
  const key    = isGame ? 'PLAYIT_GAME_ADDRESS' : 'PLAYIT_DASHBOARD_ADDRESS';
  const val    = input?.value?.trim() || '';

  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    await API.post('/api/remote/addresses', { [isGame ? 'game' : 'dashboard']: val });
    _remoteAddressCache[isGame ? 'game' : 'dashboard'] = val;
    if (btn) btn.style.display = 'none';
    showToast('Address saved', 'success');
  } catch {
    showToast('Failed to save address', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
  }
}

async function clearRemoteAddr(type) {
  const isGame = type === 'game';
  const input  = document.getElementById(isGame ? 'remote-playit-game' : 'remote-playit-dash');
  if (input) input.value = '';
  await API.post('/api/remote/addresses', { [isGame ? 'game' : 'dashboard']: '' });
  _remoteAddressCache[isGame ? 'game' : 'dashboard'] = '';
  _populateConnectionAddresses();
}

function copyRemoteAddr(elId) {
  const el  = document.getElementById(elId);
  const val = el?.value ?? el?.textContent ?? '';
  if (!val || val === '--') { showToast('Nothing to copy', 'warn'); return; }
  navigator.clipboard.writeText(val).then(() => showToast('Copied!', 'success')).catch(() => showToast('Copy failed', 'error'));
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

function _renderPeerRemoteServices(peerName) {
  const el        = document.getElementById('remoteServiceStatus');
  const startBtn  = document.getElementById('remoteStartBtn');
  const stopBtn   = document.getElementById('remoteStopBtn');
  const removeBtn = document.getElementById('remoteRemoveBtn');
  const revealDiv = document.getElementById('remoteConfigReveal');
  if (startBtn)  startBtn.style.display  = 'none';
  if (stopBtn)   stopBtn.style.display   = 'none';
  if (removeBtn) removeBtn.style.display = 'none';
  if (revealDiv) revealDiv.style.display = 'none';
  if (el) el.innerHTML = `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
    <span class="status-dot running"></span>
    <span style="font-size:13px;color:var(--text-secondary);font-family:monospace">playit.gg</span>
    <span style="font-weight:500;color:#22c55e">Active</span>
    <span style="font-size:12px;color:var(--text-muted)">— shared from ${peerName || 'Instance 1'}</span>
  </div>`;
}

function _lockComposeEntry(locked, peerMode = false) {
  const textarea    = document.getElementById('remoteComposeInput');
  const btn         = document.getElementById('remoteApplyBtn');
  const msgEl       = document.getElementById('remoteApplyMsg');
  const inputWrap   = document.getElementById('remoteComposeInputWrap');
  const composeCard = document.getElementById('remoteComposeCard');
  if (textarea) textarea.disabled        = locked;
  if (inputWrap) inputWrap.style.display = locked ? 'none' : '';
  if (btn) btn.style.display             = locked ? 'none' : '';
  if (composeCard) composeCard.open      = !locked;
  if (msgEl) {
    if (locked) {
      msgEl.innerHTML     = peerMode
        ? '<strong style="color:var(--text-primary);font-size:14px">&#x2713; Remote Active.</strong> <span style="color:var(--text-secondary)">Tunnel is running on the primary instance. Enter your playit.gg addresses below.</span>'
        : '<strong style="color:var(--text-primary);font-size:14px">&#x2713; Service configured.</strong> <span style="color:var(--text-secondary)">Stop &amp; Remove the current service to start a new one.</span>';
      msgEl.style.display = '';
    } else {
      msgEl.style.display = 'none';
    }
  }
}

async function applyRemoteCompose() {
  const textarea = document.getElementById('remoteComposeInput');
  const btn      = document.getElementById('remoteApplyBtn');
  const yaml     = textarea?.value?.trim();

  if (!yaml) { _showRemoteMsg('Paste a docker compose snippet first.', 'error'); return; }
  if (!yaml.includes('services:')) { _showRemoteMsg('YAML must contain a services: block.', 'error'); return; }

  const password = await _promptAdminPassword('Confirm with admin password to apply compose config');
  if (!password) return;

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