<div align="center">

# StardropHost

### Self-hosted Stardew Valley dedicated server — managed from your browser

*24/7 server your friends can join any time, even when you're offline.*

**v1.0.0** · [stardrophost.dev](https://stardrophost.dev) · [Report a Bug](https://github.com/Tomomoto10/StardropHost-dev/issues)

</div>

---

## Overview

StardropHost is a Dockerized Stardew Valley server with a full browser-based management panel. Set it up once on a Linux machine or VM — everything after that is managed from the web UI. No SSH, no terminal, no config file editing required.

---

## Features

### Server

| Feature | Status |
|---|---|
| First-run setup wizard (browser-based) | ✅ |
| Start / stop / restart | ✅ |
| Auto-restart on crash | ✅ |
| Game update (Steam & GOG) from web panel | ✅ |
| Panel self-update | ✅ |
| VNC remote desktop (auto-shutoff, disabled by default) | ✅ |
| Multi-instance support (up to 10 stacks, ports 18642–18651) | ✅ |
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

## Architecture

Five Docker containers:

| Container | Role |
|---|---|
| `stardrop` | Game server — Stardew Valley + SMAPI |
| `stardrop-manager` | Web panel — Node.js API + frontend |
| `stardrop-steam-auth` | Steam 2FA auth — `restart:no`, started on demand by wizard |
| `stardrop-gog-downloader` | GOG downloader — `restart:no`, ephemeral credentials, port 18701 internal |
| `stardrophost-playit-1` | playit.gg remote tunnel |

**Ports:**

| Port | Purpose |
|---|---|
| `18642` | Web panel |
| `24642` | Game server (UDP — open in firewall) |
| `5900` | VNC (disabled by default) |

---

## Requirements

- Linux (VM or bare metal — Proxmox, Ubuntu, Debian, etc.)
- Docker + Docker Compose
- 2 CPU cores · 2 GB RAM minimum (4 GB recommended for 4 players)
- A copy of Stardew Valley (Steam, GOG, or existing game files)

---

## Getting Started

```bash
curl -fsSL https://raw.githubusercontent.com/Tomomoto10/StardropHost-dev/main/quick-start.sh | bash
```

Open `http://your-server-ip:18642` and follow the setup wizard.

**Rebuild (development):**
```bash
docker compose down && docker compose up -d --build
```

---

## Uninstall

```bash
cd StardropHost
docker compose down
```

Delete the `StardropHost/` directory. Saves are in `StardropHost/data/saves/` — back these up first.

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
| [playit.gg](https://playit.gg/) | PlayIt LLC | Free tier | Remote tunnel service |

---

## License

MIT — see [LICENSE](LICENSE)

Stardew Valley is © ConcernedApe. This project is not affiliated with or endorsed by ConcernedApe.
