<div align="center">

# StardropHost

### Self-hosted Stardew Valley dedicated server — managed from your browser

*24/7 server your friends can join any time, even when you're offline.*

**v1.0.0** · [Report a Bug](https://github.com/alutke/StardropHost-dev/issues)

---

*Try the interactive demo and see more guides and info at* **[stardrophost.dev](https://stardrophost.dev)**

</div>

---

## Overview

StardropHost is a Dockerized Stardew Valley server with a full browser-based management panel. Set it up once on a Linux machine or VM — everything after that is managed from the web UI. No SSH, no terminal, no config file editing required.

This repository supports **external Compose deployment**: images are built by GitHub Actions, published to GHCR, and deployed by an external Compose tool to a remote Docker host. The Docker host never needs git, source checkout, or local builds.

---

## Deployment Architecture

```
GitHub repo
    |
    v
GitHub Actions  -- builds + pushes images -->  GHCR
                                                  |
                                                  v
External Compose tool  -- deploys Compose file -->  Remote Docker host
                                                  |
                                                  v
                                           Containers run from
                                           pre-built images only
```

The remote Docker host does **not** need:

- git
- A clone of this repository
- Local build context
- `docker build`
- Source files mounted from the deployment tool

The remote Docker host **does** need:

- Docker Engine and Docker Compose plugin
- Registry access to GHCR (login required if images are private)
- Persistent host directories under `/srv/stardrophost/`
- Environment variables supplied by the deployment tool

---

## Features

### Server

| Feature | Status |
|---|---|
| First-run setup wizard (browser-based) | ✅ |
| Start / stop / restart | ✅ |
| Auto-restart on crash | ✅ |
| Game update (Steam & GOG) from web panel | ✅ |
| VNC remote desktop (auto-shutoff, disabled by default) | ✅ |
| Auto-boot via systemctl on startup | ✅ |

### Multiplayer

| Feature | Status |
|---|---|
| LAN co-op (up to 4 players per instance) | ✅ |
| Remote play via playit.gg tunnel | ✅ |
| Steam game download (install wizard) | ✅ |
| GOG game download (code login, ephemeral credentials) | ✅ |

### Farm & World Controls

| Feature | Status |
|---|---|
| Live farm status (season, time, weather, players, location) | ✅ |
| Community Center progress tracking | ✅ |
| Shared money · pause · freeze time | ✅ |
| Crop Saver | ✅ |
| Build permissions & cabin type control | ✅ |
| Progressive cabin upgrade (with in-cabin check) | ✅ |
| Clear farm by location and object type | ✅ |

### Players

| Feature | Status |
|---|---|
| Online player list with location | ✅ |
| Kick · ban · admin grant | ✅ |
| Block list / allow list with IP tracking | ✅ |
| Known player IP log | ✅ |
| Farmhand slot management | ✅ |
| Mod enforcement on join | ✅ |
| Per-farmhand admin commands (via SMAPI mod) | ✅ |

### Saves & Backups

| Feature | Status |
|---|---|
| Browse, upload, select, delete saves | ✅ |
| Tagged auto-backups (manual / auto / stop / restart / update) | ✅ |
| Backup download and restore | ✅ |
| Configurable backup frequency and max count | ✅ |

### Mods

| Feature | Status |
|---|---|
| SMAPI mod upload via web panel | ✅ |
| Bundled mods: StardropHost.Dependencies, StardropDashboard | ✅ |
| Pending-restart badge after upload or delete | ✅ |

### Chat

| Feature | Status |
|---|---|
| World chat + private DMs per player | ✅ |
| DM notification badges | ✅ |
| Color picker · multi-line input | ✅ |
| Notification dots (sidebar + DM pills) | ✅ |
| Background poll every 10s | ✅ |

### Console & Logs

| Feature | Status |
|---|---|
| SMAPI terminal (auto-connect on tab open) | ✅ |
| Log viewer with filters (Game / Errors / SMAPI / All) | ✅ |
| Log search and download | ✅ |

### Security

| Feature | Status |
|---|---|
| bcrypt password hashing | ✅ |
| JWT auth (1h idle timeout) | ✅ |
| Login rate limiting (5 attempts / 15 min) | ✅ |
| Register rate limiting (10 / min / IP) | ✅ |
| Wizard endpoint guards (wizardCompleteGuard) | ✅ |
| Import path validation + WIZARD_ALLOWED_ROOTS allowlist | ✅ |
| panel.json mode 0o600 | ✅ |
| GOG credential URL stripping on error | ✅ |

---

## Quick Start (External Compose)

1. **Fork or use this repository** as the source for your deployment.

2. **Set up GHCR access**:
   - Ensure the GitHub repository is public, or create a PAT with `read:packages` scope for the Docker host.
   - On the Docker host: `echo "TOKEN" | docker login ghcr.io -u USERNAME --password-stdin`

3. **Create host directories** on the remote Docker host:
   ```bash
   sudo mkdir -p /srv/stardrophost/data/{saves,game,logs,backups,panel,custom-mods}
   sudo chown -R 1000:1000 /srv/stardrophost/data
   ```

4. **Configure your deployment tool** (e.g. Dockhand, Portainer, Dockge) to deploy `compose.external.yml` with an `.env` file based on `.env.example`.

5. **Deploy**. The deployment tool will pull images from GHCR and start the stack.

6. **Open** `http://your-server-ip:18642` and follow the setup wizard.

For detailed setup, update flows, rollback, and troubleshooting, see [`docs/external-compose-deployment.md`](docs/external-compose-deployment.md).

---

## Containers

| Container | Role | Image |
|---|---|---|
| `stardrop` | Game server — Stardew Valley + SMAPI + web panel | `ghcr.io/alutke/stardrophost-dev:latest` |
| `stardrop-manager` | Sidecar with Docker socket access for container lifecycle | `ghcr.io/alutke/stardrophost-dev-manager:latest` |
| `stardrop-init` | One-shot init — sets up volumes and permissions, exits 0 | `ghcr.io/alutke/stardrophost-dev:latest` |
| `stardrop-steam-auth` | Steam 2FA auth helper | `ghcr.io/alutke/stardrophost-dev-steam-auth:latest` |
| `stardrop-gog-downloader` | GOG game downloader | `ghcr.io/alutke/stardrophost-dev-gog-downloader:latest` |

**Ports:**

| Port | Purpose |
|---|---|
| `18642` | Web panel |
| `24642` | Game server (UDP — open in firewall) |
| `5900` | VNC (disabled by default) |
| `9090` | Prometheus metrics (optional) |

---

## Requirements

- Linux (VM or bare metal — Proxmox, Ubuntu, Debian, etc.)
- Docker Engine + Docker Compose plugin
- 2 CPU cores · 2 GB RAM minimum (4 GB recommended for 4 players)
- A copy of Stardew Valley (Steam, GOG, or existing game files)
- For external Compose deployments: a deployment tool (e.g. Dockhand, Portainer, Dockge) with access to the target Docker host

---

## Update Flow

1. Push changes to the `main` branch.
2. GitHub Actions builds new images and pushes them to GHCR with `latest` and `sha-<short-sha>` tags.
3. The deployment tool detects the new image (or trigger a redeploy).
4. The deployment tool runs `docker compose pull` and `docker compose up -d` on the remote host.
5. The init container fixes permissions, then the main server starts with the new image.

**Rollback:** Pin the image tag to a specific SHA in your deployment tool, then redeploy.

---

## Multi-Instance

Run multiple independent instances on the same host by deploying separate Compose stacks. Each stack needs:

- Unique `CONTAINER_PREFIX` (e.g. `stardrop-2`)
- Unique ports (`PANEL_PORT`, `GAME_PORT`, `VNC_PORT`, `METRICS_PORT`)
- Unique `SERVER_IP` inside a unique `NETWORK_SUBNET`
- Unique host data paths (e.g. `/srv/stardrophost-2/data/...`)

See `.env.example` for a commented example.

---

## Local Development

For local development and testing, use the legacy `docker-compose.yml`:

```bash
docker compose up -d --build
```

See `docs/DEVELOPMENT.md` for build details.

---

## Uninstall

```bash
docker compose -f compose.external.yml down
```

Delete the data directory. Saves are in `/srv/stardrophost/data/saves/` — back these up first.

---

## References

Projects and mods referenced during development. All used under free/open-source licenses.

| Project | Author | License | Notes |
|---|---|---|---|
| [puppy-stardew-server](https://github.com/truman-world/puppy-stardew-server) | truman-world | MIT | Base Docker structure — heavily modified |
| [JunimoHost](https://github.com/JunimoHost/junimohost-stardew-server) | JunimoHost | — | Reference for headless server approach |
| [stardew-valley-dedicated-server](https://github.com/stardew-valley-dedicated-server/server) | stardew-valley-dedicated-server | — | Reference for SMAPI server mod patterns |
| [SMAPI Dedicated Server Mod](https://github.com/alanperrow/StardewModding) | alanperrow | MIT | Reference for headless host automation |
| [Always On Server](https://www.nexusmods.com/stardewvalley/mods/2677) | funny-snek & Zuberii | Public Domain | Reference for always-on server mod |
| [SMAPI](https://smapi.io/) | Pathoschild | MIT + Apache 2.0 | Modding platform powering the server |
| [GogDownloader](https://github.com/RikudouSage/GogDownloader) | RikudouSage | MIT | GOG game downloader used in gog-downloader container |
