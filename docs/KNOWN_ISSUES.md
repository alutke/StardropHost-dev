# Known Issues

Known limitations, first-build pitfalls, and workarounds.

---

## First Build Issues

### StardropDashboard mod fails to build

**Symptom:** `docker build` fails at the `dotnet build` step with a restore or compile error.

**Cause:** `dotnet-sdk-6.0` must be installed in the image and the `StardropDashboard.csproj` NuGet restore requires internet access during build.

**Workaround:**
- Ensure your Docker build host has internet access.
- If behind a proxy, pass `--build-arg HTTP_PROXY=...` to `docker build`.
- If the SDK version changes, update the `dotnet-sdk-6.0` package name in `docker/Dockerfile`.

---

### `npm ci` fails in web-panel layer

**Symptom:** Build fails with `npm ci` error — `ENOENT: no such file or directory, open 'package-lock.json'`.

**Cause:** `node_modules/` exists locally but `package-lock.json` was not committed, or the lock file is out of sync with `package.json`.

**Workaround:**
- Run `cd docker/web-panel && npm install` locally to regenerate `package-lock.json`, then commit it.
- Alternatively, change `npm ci` to `npm install` in the Dockerfile temporarily for the first build.

---

### Image build takes a long time or runs out of disk

**Cause:** The image installs `.NET 6 SDK`, `dotnet runtime`, `Node.js`, `Xvfb`, and the full Xorg modesetting stack. Uncompressed build layers exceed 2 GB.

**Requirements:**
- At least 4 GB free disk on the Docker build host.
- At least 3 GB free for the final image layers.

---

### Game server health check fails on first start

**Symptom:** `docker ps` shows `(health: starting)` for the first 2 minutes; container may show `unhealthy` before the game loads.

**Cause:** The health check (`pgrep -f StardewModdingAPI`) has a 120 s start period. SMAPI install + first game launch can take 60–90 s.

**Workaround:** This is expected. Wait for `(healthy)` before connecting. The check will pass once SMAPI is running.

---

### `data/game` volume is empty — server won't start

**Symptom:** Game never launches; logs show `Game files not found`.

**Cause:** StardropHost does not bundle or auto-download Stardew Valley. You must supply the game files.

**Workaround:**
1. Copy your Stardew Valley installation into `./data/game/` (the folder should contain the `StardewValley` binary).
2. Or complete the setup wizard (`:18642`) and use the Steam download option — this requires `stardrop-steam-auth` to be running and valid Steam credentials.

---

### Setup wizard Step 1 token not returned

**Symptom:** After setting the admin password the wizard doesn't advance; browser console shows a 500 error.

**Cause (fixed in v1.0.0):** Earlier builds had `wizard.js` calling `hashPassword` which was not exported from `auth.js`. This is resolved.

**If you see this on a clean build:** Verify you are running the v1.0.0 image and that `docker/web-panel/auth.js` exports `setupPassword`.

---

### `stardrop-init` container exits non-zero

**Symptom:** `docker compose up` shows `stardrop-init exited with code 1`; `stardrop-server` never starts.

**Cause:** `stardrop-server` depends on `stardrop-init` completing successfully. If `init-container.sh` fails (e.g. a `chown` on a root-owned volume), the main container won't start.

**Workaround:**
```bash
docker logs stardrop-init
```
Common cause: `./data/` subdirectories are owned by root. Fix with:
```bash
sudo chown -R 1000:1000 ./data/
```

---

## Runtime Issues

### Multiplayer requires manual Co-op reload after restart

**Symptom:** After any container restart, players cannot connect even though the game is running.

**Cause:** `ServerAutoLoad` reloads the save file via reflection, but this bypasses the Co-op networking initialisation path (`Game1.server`). The server is technically running but not listening for players.

**Workaround:**
1. Connect via VNC (port 5900).
2. Press `ESC` to return to the title screen.
3. Click **Co-op → Load** and select your save.
4. Players can now connect (~30 s).

**Status:** Known limitation of the `ServerAutoLoad` mod architecture. A permanent fix would require mod-level changes to call the Co-op init flow explicitly.

---

### First time setup requires VNC

**Symptom:** No save file exists; the server idles at the title screen.

**Cause:** Stardew Valley requires a Co-op save to be created through the in-game menu. There is no headless API for this.

**Workaround:**
1. Enable VNC: set `ENABLE_VNC=true` in your `.env` and restart.
2. Connect to `your-server-ip:5900` (password from `VNC_PASSWORD`).
3. Click **Co-op → Start new co-op farm**, configure, and start.
4. Once the save exists you can disable VNC to save ~50 MB RAM.

---

### Audio warnings in logs

**Symptom:** Log lines like:
```
OpenAL device could not be initialized
Steam achievements won't work because Steam isn't loaded
```

**Cause:** The server runs headless — no audio hardware, no Steam client.

**Impact:** None. These are harmless and do not affect gameplay or server functionality.

---

### Prometheus metrics show stale CPU values

**Symptom:** `stardrop_cpu_percent` reads unusually high (e.g. 400%).

**Cause (fixed in v1.0.0):** `ps` reports per-core CPU. Earlier builds did not divide by `nproc`. This is now corrected in `status-reporter.sh`.

---

### Player count stuck at 0

**Symptom:** Web panel shows 0 players even when connected.

**Cause (fixed in v1.0.0):** Player count was read from Docker stdout instead of the SMAPI log file. SMAPI uses large negative integers for player IDs; the old regex `[0-9]+` didn't match. Both issues are resolved — player count now reads from `SMAPI-latest.txt` with regex `[-0-9]+`.

---

### VNC shows black screen

**Symptom:** VNC connects but the display is black.

**Cause:** Xvfb has not started yet, or the game is still initialising.

**Workaround:** Wait ~60 s after container start and reconnect. If still black:
```bash
docker exec stardrop pgrep Xvfb
docker exec stardrop pgrep x11vnc
```
If either is missing, check the entrypoint logs.

---

## Reporting New Issues

Please report issues at: https://github.com/tomomotto/StardropHost/issues

Include:
- Container logs: `docker logs stardrop`
- SMAPI log: `docker exec stardrop cat /home/steam/.config/StardewValley/ErrorLogs/SMAPI-latest.txt`
- Docker and host OS version
- Steps to reproduce

---

**Last Updated:** 2026-03-17
**Version:** v1.0.0
