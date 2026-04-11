# Development Guide

---

## Repository Layout

```
StardropHost/
├── docker/
│   ├── Dockerfile                  # Main game server image
│   ├── config/
│   │   ├── startup_preferences     # Template for Stardew launch prefs
│   │   └── 10-monitor.conf         # Xorg modesetting config
│   ├── mods/                       # Pre-built SMAPI mods (copied into image)
│   │   ├── AlwaysOnServer/
│   │   ├── AutoHideHost/
│   │   ├── ServerAutoLoad/
│   │   └── SkillLevelGuard/
│   ├── mods-source/
│   │   ├── AutoHideHost_v1.0.1/    # C# source for AutoHideHost (reference)
│   │   ├── StardropDashboard/        # C# source — built at container startup (Step 3.5)
│   │   └── FarmAutoCreate/         # C# source — built at container startup (Step 3.6)
│   ├── scripts/
│   │   ├── entrypoint.sh           # Container startup (main logic)
│   │   ├── init-container.sh       # One-shot: permissions + directory setup
│   │   ├── crash-monitor.sh        # Rate-limited auto-restart
│   │   ├── status-reporter.sh      # Prometheus metrics + JSON status
│   │   ├── save-selector.sh        # SAVE_NAME → startup_preferences
│   │   ├── auto-backup.sh          # Timed save backups + rotation
│   │   ├── log-manager.sh          # Log rotation
│   │   ├── log-monitor.sh          # Live log tailing
│   │   ├── event-handler.sh        # Game event dispatch with cooldowns
│   │   ├── vnc-monitor.sh          # VNC lifecycle management
│   │   └── set-resolution.sh       # Xvfb resolution control
│   ├── manager/
│   │   └── server.js               # Manager sidecar (port 18700 internal)
│   ├── steam-auth/
│   │   └── server.js               # Steam auth sidecar — invite codes only (port 18700 internal)
│   └── web-panel/
│       ├── server.js               # Express entry point (port 18642)
│       ├── auth.js                 # JWT + bcrypt auth
│       └── api/
│           ├── wizard.js           # 5-step first-run setup wizard
│           ├── status.js           # Live server status + start/stop/restart
│           ├── logs.js             # Log streaming (SMAPI, setup, mods, game)
│           ├── mods.js             # Mod management (install, delete, pending state)
│           ├── saves.js            # Save management (upload, backup, delete)
│           ├── farm.js             # Farm overview + live status
│           ├── players.js          # Player list, kick, ban
│           ├── config.js           # Runtime config (env file read/write)
│           ├── vnc.js              # VNC toggle + one-time password
│           ├── terminal.js         # WebSocket PTY terminal
│           └── steam.js            # Steam invite-code relay (steam-auth sidecar proxy)
├── tests/
│   ├── test-new-features.sh        # Offline script logic tests
│   ├── test-steam-guard.sh         # steam-auth API tests (needs container)
│   ├── cleanup-tests.sh            # Remove test containers + tmp dirs
│   └── README.md
├── docs/
├── docker-compose.yml
├── verify-deployment.sh
└── backup.sh
```

---

## Container Architecture

```
┌──────────────────────────────────────────────┐
│  stardrop-init  (one-shot, exits 0)           │
│  init-container.sh: mkdir, chown data volumes │
└─────────────────────┬────────────────────────┘
                      │ completes successfully
                      ▼
┌──────────────────────────────────────────────┐
│  stardrop-server  (main game container)       │
│  entrypoint.sh → Xvfb → SMAPI → game         │
│  web-panel on :18642                          │
│  Prometheus on :9090 (optional)               │
│  VNC on :5900 (optional)                      │
└──────────────┬───────────────────────────────┘
               │ REST calls
               ▼
┌──────────────────────────────────────────────┐
│  stardrop-manager  (sidecar)                  │
│  Accepts start/stop/restart from web panel    │
│  :3001                                        │
└──────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐
│  stardrop-steam-auth  (optional sidecar)      │
│  Isolated Steam login + guard code relay      │
│  :3000                                        │
└──────────────────────────────────────────────┘
```

---

## Startup Sequence

```
entrypoint.sh
  Phase 1 (root):   GPU Xorg config (if USE_GPU=true) → switch to steam user

  Phase 2 (steam):  [Step 0]   Start web panel early (port 18642)
                               Wizard is reachable before game files exist
                    [Step 1]   Load runtime.env overrides
                    [Step 2]   Setup game files:
                                 - Already present → continue
                                 - GAME_PATH set → copy from path
                                 - STEAM_DOWNLOAD=true → run steamcmd
                                 - None → wait loop (re-reads env every 30s,
                                   picks up credentials written by wizard)
                    [Step 3]   Install SMAPI (skip if already installed)
                    [Step 3.5] Build StardropDashboard mod from source
                               (needs game DLLs, so runs after Step 2)
                    [Step 3.6] Build FarmAutoCreate mod from source
                               (headless new-farm creation, no xdotool)
                    [Step 4]   Install preinstalled mods + custom mods
                    [Step 5]   Start Xvfb (or use GPU Xorg if running)
                    [Step 6]   Start x11vnc (if ENABLE_VNC=true)
                    [Step 7]   Write startup_preferences (resolution, display)
                    [Step 7.5] Run save-selector.sh (if SAVE_NAME set)
                    [Step 8]   Start log-monitor.sh (if ENABLE_LOG_MONITOR=true)
                    [Step 9]   Launch StardewModdingAPI --server
                               (wrapped in crash-monitor.sh if ENABLE_CRASH_RESTART=true)
```

---

## Key Design Decisions

### StardropDashboard and FarmAutoCreate mods (built at container startup)

Both mods are built from source inside the running container (Steps 3.5/3.6 in entrypoint.sh), **not** at image build time. This is intentional: `ModBuildConfig` needs `StardewValley.dll` and `StardewModdingAPI.dll`, which only exist after game files are mounted at runtime. NuGet packages are pre-restored during `docker build` (the `dotnet restore` layer in Dockerfile) so the runtime builds work offline.

**StardropDashboard** writes live server status to `/home/steam/web-panel/data/live-status.json`, which the web panel reads for the dashboard.

**FarmAutoCreate** reads `/home/steam/web-panel/data/new-farm.json` when the title screen appears and creates a new multiplayer farm programmatically using Stardew's own C# API — no xdotool or VNC interaction required. Technique adapted from Junimo Host's `GameCreatorService`.

### Player ID regex

SMAPI logs player IDs as large negative integers (e.g. `-123456789012345`). All player-count parsing uses `[-0-9]+`, not `[0-9]+`.

### CPU percentage

`ps` reports per-core CPU. `status-reporter.sh` divides by `$(nproc)` to get a host-normalised percentage.

### Atomic status writes

`StardropDashboard` and `status-reporter.sh` write files via a `.tmp` + `mv` pattern to prevent the web panel reading a partial file mid-write.

### `/api/vnc/connected` — no auth

This endpoint is called by `vnc-monitor.sh` running inside the container and does not go through the JWT middleware. This is intentional.

### Two separate Steam integrations

There are two distinct Steam integrations that serve different purposes:

1. **steamcmd (game container)** — Downloads Stardew Valley game files during first-run setup. The wizard writes credentials to `runtime.env`; the entrypoint.sh waiting loop reads them and runs `steamcmd +app_update 413150`. Credentials are deleted from the env file immediately after the download attempt, successful or not.

2. **stardrop-steam-auth (sidecar)** — Handles Steam network authentication for generating invite codes so players can join via Steam friends. This is entirely separate from game download. The auth sidecar is only used post-setup when the server is running and players want a Steam invite link.

---

## Local Development

### Build the image

```bash
docker build -t stardrop-server:dev -f docker/Dockerfile docker/
```

### Start with a local game copy

```bash
# Put Stardew Valley files in ./data/game/
docker compose up
```

### Run script tests (no Docker needed)

```bash
bash tests/test-new-features.sh
```

### Watch web panel logs

```bash
docker logs -f stardrop
```

### Exec into the running container

```bash
docker exec -it stardrop bash
```

### Check SMAPI log

```bash
docker exec stardrop cat /home/steam/.config/StardewValley/ErrorLogs/SMAPI-latest.txt
```

---

## Common Troubleshooting

### Game doesn't start

```bash
docker logs stardrop | grep -i "error\|failed\|not found"
```

Check: game files present at `/home/steam/stardewvalley`, SMAPI installed, mods copied.

### Mods not loading

```bash
docker exec stardrop ls /home/steam/stardewvalley/Mods/
docker exec stardrop cat /home/steam/stardewvalley/Mods/AlwaysOnServer/manifest.json
```

### Web panel unreachable

```bash
docker exec stardrop pgrep -f "node.*server.js"
curl -s http://localhost:18642/api/auth/status
```

### Permission errors on data volumes

```bash
sudo chown -R 1000:1000 ./data/
```

---

## Release Checklist

- [ ] Update `version` label in `docker/Dockerfile`
- [ ] Update `Docs/CHANGELOG.md`
- [ ] Run `bash tests/test-new-features.sh`
- [ ] `docker build` succeeds cleanly
- [ ] Setup wizard completes end-to-end
- [ ] Game launches and players can connect
- [ ] `./verify-deployment.sh` passes

---

## Performance Notes

Typical resource usage:

| Resource | Idle | 4 players |
|---|---|---|
| RAM | ~1.5 GB | ~2.2 GB |
| CPU | 1–5% | 15–40% |
| Disk | ~2.5 GB image | +save files |
| Upload | — | ~50–100 Kbps/player |

See `Docs/CPU-OPTIMIZATION.md` for `LOW_PERF_MODE` details.

---

**Last Updated:** 2026-03-17
**Version:** v1.0.0
