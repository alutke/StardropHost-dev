# StardropHost Web Panel

The control centre for your Stardew Valley dedicated server.
Access at `http://your-server-ip:18642`

---

## First Run

The setup wizard handles everything on first visit:

1. Create your admin password
2. Install game files (local copy or Steam download)
3. Set CPU and RAM limits
4. Optionally configure Steam for invite codes

---

## What You Can Do

**Dashboard** — Live server stats, player list, in-game time, weather and farm overview

**Host Controls** — Start, stop, restart, update, system health check, VNC toggle

**Players** — See who's online, kick, ban, grant admin

**Saves** — Browse, backup, download and switch save files

**Logs** — Live log stream, filtered by errors, mods, server or game events

**Mods** — View installed mods, upload custom mods

**Settings** — Configure resources, server name, multi-server connections

---

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/login` | Login |
| POST | `/api/auth/change-password` | Change password |
| GET | `/api/status` | Server status |
| POST | `/api/server/start` | Start server |
| POST | `/api/server/stop` | Stop server |
| POST | `/api/server/restart` | Restart server |
| POST | `/api/server/update` | Update server |
| GET | `/api/logs` | All logs |
| GET | `/api/logs/errors` | Errors only |
| GET | `/api/logs/server` | Connection logs |
| GET | `/api/players` | Connected players |
| POST | `/api/players/kick` | Kick player |
| POST | `/api/players/ban` | Ban player |
| GET | `/api/saves` | List saves |
| POST | `/api/saves/backup` | Create backup |
| GET | `/api/saves/download` | Download backup |
| PUT | `/api/saves/select` | Set active save |
| GET | `/api/config` | Get config |
| PUT | `/api/config` | Update config |
| GET | `/api/mods` | List mods |
| POST | `/api/mods/upload` | Upload mod |
| GET | `/api/vnc/status` | VNC status |
| POST | `/api/vnc/enable` | Enable VNC |
| POST | `/api/vnc/disable` | Disable VNC |
| GET | `/api/farm/live` | Live game data |
| GET | `/api/farm/overview` | Save file overview |

**WebSocket** — `/ws` for real-time log streaming and live status

---

## Security

- bcrypt password hashing
- JWT authentication with 1 hour idle timeout
- Login rate limited to 5 attempts per 15 minutes
- VNC off by default, toggle via dashboard