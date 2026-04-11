# StardropHost — Security Audit (April 2026)

All findings and fixes from the pre-beta security review. Covers three areas:
1. Credential & auth flows (Steam + GOG)
2. Web dashboard API security
3. Install/update scripts (`quick-start.sh`, `update.sh`)

---

## 1. Credential & Auth Flows

### Steam auth container
**Risk reviewed:** Steam 2FA credentials leaking to disk or logs.

**Findings — all OK:**
- Credentials are memory-only inside `stardrop-steam-auth`; never written to any volume.
- Container has `restart: no` — exits after wizard completes, wiping all in-memory state.
- `wizComplete()` explicitly calls the manager to stop the container after the wizard flow ends.
- No `/Configs` or credential volume mounted; only the game download output (`./data/game`) is mounted.

**No changes required.**

---

### GOG auth container (`stardrop-gog-downloader`)
**Risk reviewed:** OAuth tokens or login credentials leaking via error messages, logs, or volumes.

**Finding — FIXED:** The `/api/gog/login` error handler was returning raw output from the `code-login` command, which could include the full OAuth redirect URL (containing the auth code) in the error text.

**Fix applied** (`docker/gog-downloader/server.js`):
```js
const sanitized = (output || 'Login failed — check the redirect URL and try again')
  .replace(/https?:\/\/\S+/gi, '[url]')
  .trim();
state     = 'error';
lastError = sanitized;
sendJson(res, 400, { success: false, error: sanitized });
```
All URLs are stripped from error messages before they reach the client.

**Architecture (no credentials at rest):**
- `/configs` (GOG OAuth token) is NOT mounted to host — ephemeral container filesystem only.
- Container has `restart: no`; tokens are gone when the container exits.
- `/downloads` (game files) IS mounted — that's the output, not credentials.
- User re-authenticates via code-login each time they download or update.

---

## 2. Web Dashboard API Security

### Auth system (`auth.js`)
**Finding 1 — FIXED:** `panel.json` (contains bcrypt hash + JWT secret) was written with default file permissions (world-readable on some systems).

**Fix:** `saveConfig()` now passes `{ mode: 0o600 }` to `writeFileSync` — owner read/write only.

**Finding 2 — FIXED:** `changePassword` had a minimum password length of 6 characters, inconsistent with `setup` which enforced 8.

**Fix:** Minimum raised to 8 in `changePassword`.

**Already in place:**
- JWT-based auth, 24h expiry, signed with per-instance random secret.
- Bcrypt with cost factor 12.
- Rate limiting: 5 attempts → 15-minute lockout per IP.
- All sensitive endpoints require `verifyMiddleware`.

---

### Wizard endpoints (`wizard.js`)
**Risk reviewed:** Wizard endpoints are intentionally unauthenticated (no JWT exists at wizard time). After setup, they must be inaccessible.

**Finding 1 — FIXED:** Wizard endpoints (`scanInstalls`, `browseDir`, `scanSaveImport`, `importSave`, etc.) remained callable after setup was complete. Any unauthenticated client could enumerate filesystem paths.

**Fix:** Added `wizardCompleteGuard(req, res)` — returns 403 if `auth.isSetupComplete()`. Applied to all wizard-only endpoints.

**Finding 2 — FIXED:** `scanSaveImport` used a blocklist approach to prevent path traversal (blocking `/etc`, `/root`, etc.). Blocklists are fragile; new paths could be added that bypass them.

**Fix:** Replaced with allowlist `WIZARD_ALLOWED_ROOTS = ['/host-parent', '/home/steam']`. `isUnderAllowedRoot(resolvedPath)` checks `path.resolve()` output against this list — no blocklist.

**Finding 3 — FIXED:** `importSave` had no path validation on the source path and no sanitization on the save name, allowing directory traversal into the destination saves folder.

**Fix:**
```js
const resolvedSrc = path.resolve(savePath);
if (!isUnderAllowedRoot(resolvedSrc)) {
  return res.status(403).json({ error: 'Source path not allowed' });
}
const cleanName = path.basename(saveName);
if (!cleanName || cleanName !== saveName) {
  return res.status(400).json({ error: 'Invalid save name' });
}
```

---

### Public peer registration endpoint (`instances.js`)
**Risk reviewed:** `POST /api/instances/register` is intentionally unauthenticated (used by cross-instance discovery). Without rate limiting, it can be abused to spam the peers file.

**Finding — FIXED:** No rate limiting on the public endpoint.

**Fix:** Added per-IP rate limiter — max 10 registrations per IP per 60-second window:
```js
const _registerAttempts = new Map();
function registerRateLimit(req) {
  const ip   = req.ip || req.socket?.remoteAddress || 'unknown';
  const now  = Date.now();
  const entry = _registerAttempts.get(ip) || { count: 0, window: now };
  if (now - entry.window > 60000) { entry.count = 0; entry.window = now; }
  entry.count += 1;
  _registerAttempts.set(ip, entry);
  return entry.count > 10;
}
```

---

### Manager sidecar (`stardrop-manager`)
**Risk reviewed:** Manager has Docker socket access and can start/stop/rebuild containers. No auth on manager endpoints — relies on Docker network isolation.

**Status — accepted risk (homelab):**
- Manager is not exposed outside the Docker bridge network.
- All manager calls originate from inside the `stardrop` container (same network).
- Manager uses an `ALLOWED_SERVICES` allowlist — only named containers can be controlled.
- Adding a shared secret between panel and manager is deferred to post-beta hardening.

---

## 3. Install & Update Scripts

### `quick-start.sh`
**Risk reviewed:** Script runs as root during initial install (user SSHs in and runs it). Potential for log file exposure, leftover credentials, or insecure defaults.

**Finding 1 — FIXED:** Install log was created without explicit permissions — root's umask determines the mode, which could make it group/world-readable.

**Fix:**
```bash
touch "$LOG_FILE" && chmod 600 "$LOG_FILE"
exec > >(tee -a "$LOG_FILE") 2>&1
```

**Finding 2 — FIXED:** `mkdir -p data/{saves,...,steam-session}` included `steam-session`, a directory not mounted in `docker-compose.yml` (leftover from an earlier design). Created unnecessary surface area.

**Fix:** `steam-session` removed from the `mkdir` list.

**Finding 3 — ADDED:** No auto-start-on-boot — if the host rebooted, the user had to manually start Docker and the containers.

**Fix:** Added to `check_docker()`, with a systemd guard so it's a no-op on non-systemd systems:
```bash
if command -v systemctl &>/dev/null && systemctl is-system-running --quiet 2>/dev/null; then
    systemctl enable docker     2>/dev/null || true
    systemctl enable containerd 2>/dev/null || true
    print_success "Docker enabled at boot (systemd)"
fi
```
Skipped automatically on non-Debian/non-systemd hosts.

---

### `update.sh`
**Risk reviewed:** Script runs as root (launched from the manager inside `docker run --rm alpine`). Used to `source .env` which executes arbitrary shell code from a file in the project directory.

**Finding — FIXED:** `source "$SCRIPT_DIR/.env"` executes `.env` as a shell script with full root privileges and Docker socket access. A malicious or corrupted `.env` could run anything.

**Fix:** Replaced `source` with safe per-variable grep extraction:
```bash
_env_get() {
    grep -E "^${1}=" "$SCRIPT_DIR/.env" 2>/dev/null \
        | head -1 | cut -d= -f2- | tr -d '"' | sed "s/^'//;s/'$//"
}
if [ -f "$SCRIPT_DIR/.env" ]; then
    _env_panel_port=$(_env_get PANEL_PORT)
    [ -n "$_env_panel_port" ] && PANEL_PORT="$_env_panel_port"
fi
```
Only `PANEL_PORT` is extracted; no arbitrary code can execute.

**Note on sudo:** `update.sh` contains an `exec sudo bash` line. This line is never reached from the dashboard path — the manager already spawns `update.sh` inside a `docker run --rm alpine` container which is already root. The line is only a fallback if `update.sh` is run manually outside Docker by a non-root user.

---

## Summary Table

| Area | Finding | Severity | Status |
|------|---------|----------|--------|
| GOG error messages | OAuth URL leaked in error response | Medium | Fixed |
| `panel.json` permissions | World-readable bcrypt hash + JWT secret | Medium | Fixed |
| Password minimum | `changePassword` allowed 6-char passwords | Low | Fixed |
| Wizard endpoints post-setup | Unauthenticated filesystem browse after setup | High | Fixed |
| `importSave` path traversal | Arbitrary directory copy into saves | High | Fixed |
| `scanSaveImport` blocklist | Fragile path restriction approach | Medium | Fixed |
| `/register` rate limiting | Unauthenticated endpoint, no rate limit | Low | Fixed |
| Install log permissions | Log world-readable depending on umask | Low | Fixed |
| `steam-session` dir | Leftover unmounted directory created | Info | Fixed |
| `source .env` as root | Arbitrary code execution from .env file | High | Fixed |
| Auto-boot | No systemd enable for Docker on restart | Info | Added |
| Manager auth | No shared secret (Docker network only) | Low | Deferred |

---

## Deferred (Post-Beta)

- **Manager shared secret** — add `MANAGER_SECRET` env var; panel sends it in every manager request; manager validates it. Blocks lateral movement from within the Docker network.
- **HTTPS / TLS** — playit.gg tunnel provides TLS for remote access, but LAN access is plain HTTP. Add Certbot support (blocked on PWA work).
- **Content Security Policy headers** — add `helmet.js` or manual CSP headers to the Express app.
