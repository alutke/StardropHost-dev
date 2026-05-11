# StardropHost — Agent Context

Dockerized Stardew Valley dedicated server with a browser-based management panel.

## Architecture

- **Docker Compose** multi-service app. Key services:
  - `stardrop-server` — main game server (Stardew + SMAPI + web panel + background services)
  - `stardrop-manager` — Docker socket sidecar for container lifecycle control (port 18700 internal)
  - `stardrop-init` — one-shot root container that fixes permissions (UID 1000:1000) then exits
  - `stardrop-web-panel` — Express + WebSocket panel (port 18642)
  - `stardrop-steam-auth` — Steam invite-code relay sidecar
  - `stardrop-gog-downloader` — GOG download sidecar (PHP + Node)
- **Game files are NOT in the image.** Provided via `./data/game/` volume or downloaded via the setup wizard.
- **C# SMAPI mods** in `docker/mods-source/` are built at container startup, not at image build time.

## Developer Commands

| Task | Command |
|---|---|
| Start everything | `docker compose up -d` |
| Build server image only | `docker build -t stardrop-server:dev -f docker/Dockerfile docker/` |
| Run dev container (no game) | `docker compose up stardrop-init stardrop-manager` then `docker compose up stardrop-server` |
| Incremental update | `sudo bash update.sh` |
| Clean rebuild (10–20 min) | `sudo bash scripts/rebuild-fresh.sh` |
| Live deployment verification | `bash scripts/verify-deployment.sh` |
| Health check | `bash scripts/health-check.sh` |
| Offline script tests | `bash tests/test-new-features.sh` (if present) |
| Test steam-auth sidecar | `docker compose up stardrop-steam-auth` then `bash tests/test-steam-guard.sh` |

## Code Style

- **Shell**: quote all expansions (`"$VAR"`), use `local`, prefer explicit error handling over `set -e`, log via `log_info` / `log_warn` / `log_error`.
- **Node.js**: `const`/`let` only (no `var`), early returns, async/await over raw Promises.
- **Dockerfile**: combine related `RUN` steps, clean up caches in the same layer, pin versions (no `latest`).
- **Commits**: conventional style — `type(scope): description` (`feat`, `fix`, `docs`, `refactor`, `test`, `chore`).

## Important Constraints

- `.env` is gitignored but contains no secrets; it allows local customization. `cp .env.example .env` to start.
- Container startup order matters: `stardrop-init` must complete before `stardrop-server` starts.
- The web panel reads/writes `.env` at runtime via `docker/web-panel/api/config.js`.
- Multi-instance support exists (up to 10 stacks, ports 18642–18651). Scripts read `CONTAINER_PREFIX` from `.env`.
- Node.js in the main image is installed from a binary tarball (`v20.19.1`) in the Dockerfile, not via apt.

## Entry Points

- **Web panel API**: `docker/web-panel/server.js`
- **Manager sidecar**: `docker/manager/server.js`
- **Steam auth sidecar**: `docker/steam-auth/server.js`
- **Container entrypoint**: `docker/scripts/entrypoint.sh`
- **Init script**: `docker/scripts/init-container.sh`

## Testing

There is no traditional unit-test framework. Verification is script-based:
- `scripts/verify-deployment.sh` checks a running container
- `scripts/health-check.sh` checks Docker and container state
- `tests/test-new-features.sh` for offline bash logic tests (may not exist in all branches)

## References

- `docs/DEVELOPMENT.md` — full repo layout and build details
- `docs/CONTRIBUTING.md` — PR process and style guide
- `README.md` — feature overview and user-facing docs
