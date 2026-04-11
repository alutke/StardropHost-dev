# Changelog

All notable changes to StardropHost are documented here.

---

## v1.0.0 (2026-03-17)

Initial release of StardropHost — a fork of `puppy-stardew-server` (v1.0.77) rebuilt around a web-panel-first workflow.

### Architecture

- **4-container design**: `stardrop-server` (game), `stardrop-manager` (sidecar control), `stardrop-init` (one-shot permission init), `stardrop-steam-auth` (optional Steam login sidecar)
- **Web panel** (port 18642): 5-step first-run setup wizard, JWT auth, WebSocket live status, mod/save/backup management
- **Manager sidecar** (port 3001): Accepts runtime commands (start/stop/restart game, apply config changes) from the web panel without requiring Docker socket access in the game container
- **steam-auth sidecar** (port 3000): Isolated Node.js service for Steam login — credentials never enter the game container

### Web Panel

- First-run wizard: admin password → game files → resource limits → server settings → confirm
- Live status dashboard backed by `StardropDashboard` SMAPI mod writing `live-status.json`
- Log streaming via WebSocket
- Mod management: list, enable/disable, upload custom mods
- Save management: browse, select active save, upload archives, download backups
- VNC toggle and viewer
- Player list via SMAPI log parsing

### Mods

- **AlwaysOnServer** — keeps the server running when no players are connected
- **AutoHideHost** (v1.0.1) — teleports the host character off-screen so they don't interfere
- **ServerAutoLoad** — auto-loads the last Co-op save on startup
- **SkillLevelGuard** — enforces a minimum skill level for players joining
- **StardropDashboard** (custom) — built from source at image build time; writes `live-status.json` for the web panel

### Scripts

- `entrypoint.sh` — container startup, SMAPI install, mod deployment, Xvfb/VNC launch, game launch
- `init-container.sh` — one-shot permission and directory setup
- `crash-monitor.sh` — rate-limited auto-restart on game crash (max 5 per 5 min)
- `status-reporter.sh` — Prometheus metrics on port 9090, JSON status file
- `save-selector.sh` — sets `saveFolderName` in startup preferences from `SAVE_NAME` env var
- `auto-backup.sh` — timed save backups with rotation
- `log-manager.sh` / `log-monitor.sh` — log rotation and live tailing
- `event-handler.sh` — game event processing with cooldown logic
- `vnc-monitor.sh` / `set-resolution.sh` — VNC lifecycle and resolution management

### Bug Fixes (pre-release)

- Fixed `docker-compose.yml` truncated mid-definition — `stardrop-server` service was missing `depends_on`, `environment`, `volumes`, and `ports`
- Fixed `docker-compose.yml` `stardrop-steam-auth` build path: `./steam-auth` → `./docker/steam-auth`
- Fixed `Dockerfile` dotnet build copy: `cp -r bin/Release/net6.0/StardropDashboard` (directory doesn't exist) → copy DLL and manifest separately
- Fixed `web-panel/api/wizard.js` importing `hashPassword` which was never exported from `auth.js` (runtime crash on Step 1)
- Fixed `wizard.js` writing password to `auth.json` while `auth.js` reads `panel.json` — routed through `auth.setupPassword()`
- Created missing `docker/steam-auth/package.json` (Dockerfile ran `npm ci` against a non-existent manifest)

### Configuration

New environment variables:

| Variable | Default | Description |
|---|---|---|
| `ENABLE_VNC` | `false` | Start x11vnc on port 5900 |
| `VNC_PASSWORD` | `stardew1` | VNC password (truncated to 8 chars) |
| `ENABLE_AUTO_BACKUP` | `false` | Enable timed save backups |
| `ENABLE_CRASH_RESTART` | `false` | Auto-restart game on crash |
| `ENABLE_LOG_MONITOR` | `false` | Enable log rotation |
| `LOW_PERF_MODE` | `false` | Xvfb + GC tuning for low-resource hosts |
| `USE_GPU` | `false` | Enable hardware GPU via modesetting driver |
| `SAVE_NAME` | _(none)_ | Auto-select this save folder on startup |
| `SERVER_PASSWORD` | _(none)_ | In-game server password |
| `PUBLIC_IP` | _(none)_ | Shown in web panel for connection info |
| `METRICS_PORT` | `9090` | Prometheus metrics port |
| `PANEL_PORT` | `18642` | Web panel port |
| `MAX_CRASH_RESTARTS` | `5` | Max restarts per 5-minute window |

### Ports

| Port | Protocol | Purpose |
|---|---|---|
| 24642 | UDP | Stardew Valley game server |
| 18642 | TCP | Web panel |
| 5900 | TCP | VNC (optional) |
| 9090 | TCP | Prometheus metrics (optional) |
| 3001 | TCP | Manager sidecar (internal) |
| 3000 | TCP | Steam auth sidecar (optional) |
