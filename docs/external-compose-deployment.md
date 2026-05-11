# External Compose Deployment Guide

This document explains how to deploy StardropHost using an external Docker Compose tool on a remote Docker host. Compatible tools include Dockhand, Portainer, Dockge, Docker Compose over SSH, Docker contexts, and any CI/CD pipeline that can deploy a Compose file.

## Architecture

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

## One-Time Setup

### 1. GHCR Visibility and Access

Images are published to `ghcr.io/alutke/stardrophost-dev` and related packages.

- If the GitHub repository is **public**, the images are public by default. No registry login is required on the Docker host.
- If the GitHub repository is **private**, the images are private. You must grant the Docker host access:
  1. Create a Personal Access Token (classic) with `read:packages` scope.
  2. On the Docker host, run:
     ```bash
     echo "YOUR_TOKEN" | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
     ```
  3. To make the login persistent across reboots, store the token in `/root/.docker/config.json` or use a credentials helper.

### 2. Create Host Directories

On the remote Docker host, create the data directories that will be bind-mounted into containers:

```bash
sudo mkdir -p /srv/stardrophost/data/{saves,game,logs,backups,panel,custom-mods}
sudo chown -R 1000:1000 /srv/stardrophost/data
```

The `1000:1000` ownership matches the `steam` user inside the container. The init container will fix permissions on first run, but pre-creating the directories with the correct owner avoids root-owned files.

### 3. Prepare Environment Variables

Copy `.env.example` from this repository, fill in the values, and store it in your deployment tool's secrets or environment configuration.

Critical variables:

| Variable | Purpose | Example |
|----------|---------|---------|
| `CONTAINER_PREFIX` | Container name prefix | `stardrop` |
| `SERVER_IP` | Static IP inside Docker network | `172.30.0.10` |
| `NETWORK_SUBNET` | Subnet for the compose network | `172.30.0.0/24` |
| `PANEL_PORT` | Host port for web panel | `18642` |
| `GAME_PORT` | Host port for game server | `24642` |
| `MANAGER_SECRET` | Shared secret for manager auth | `generate-a-strong-secret` |
| `TZ` | Timezone | `Europe/London` |

Do not commit secrets to Git. Supply them through your deployment tool's environment or secrets mechanism.

## Deployment Tool Setup

Configure your external Compose tool to deploy the stack using `compose.external.yml`.

### Compose File

Use the file `compose.external.yml` from this repository. **Do not** use `docker-compose.yml` — that file is for local development and includes `build:` directives and relative bind mounts.

Key characteristics of `compose.external.yml`:

- Every service uses `image:` pointing to GHCR. There are no `build:` blocks.
- Bind mounts use absolute host paths under `/srv/stardrophost/`.
- The manager sidecar uses pure `docker` commands (no `docker compose`, no repo checkout).
- `security_opt: ["no-new-privileges:true"]` is set on all services.
- `TZ=Europe/London` is set on all services.
- `DEPLOYMENT_MODE=external-compose` is passed to the main server so the web panel hides unsupported actions.

### Unsupported Web Panel Actions in External Compose Mode

When `DEPLOYMENT_MODE=external-compose` is set, the web panel automatically hides or disables features that require local source checkout or compose management:

| Feature | Behaviour | Reason |
|---|---|---|
| **Self-update button** | Hidden | Updates are managed by GitHub Actions + external redeploy |
| **Check for Updates quick action** | Hidden | Same as above |
| **Servers (multi-instance) tab** | Hidden | Multi-instance is handled via separate Compose stacks |
| **Remote Compose card** | Hidden | Remote compose management requires `docker compose` on the manager |
| **Remote start/stop/remove buttons** | Hidden | Managed by the external deployment tool, not the web panel |

Game updates (Steam/GOG) and all farm/server management features remain fully available.

### Image Reference

Your deployment tool should deploy these images:

| Service | Image |
|---------|-------|
| stardrop-server | `ghcr.io/alutke/stardrophost-dev:latest` |
| stardrop-init | `ghcr.io/alutke/stardrophost-dev:latest` |
| stardrop-manager | `ghcr.io/alutke/stardrophost-dev-manager:latest` |
| stardrop-steam-auth | `ghcr.io/alutke/stardrophost-dev-steam-auth:latest` |
| stardrop-gog-downloader | `ghcr.io/alutke/stardrophost-dev-gog-downloader:latest` |

### Why the Docker Host Does Not Need Git

All application code, scripts, web panel assets, and mod sources are baked into the images at build time. The Docker host only pulls pre-built images from GHCR. There is no `git clone`, no source checkout, and no local build step.

The web panel writes runtime settings (display resolution, backup schedule, etc.) to `/srv/stardrophost/data/panel/runtime.env`, which is mounted into the container. This is the only mutable state on the host.

## Update Flow

1. Push changes to the `main` branch.
2. GitHub Actions builds new images and pushes them to GHCR with tags:
   - `latest`
   - `sha-<short-commit-sha>`
3. Your deployment tool detects the new `latest` image (or you trigger a redeploy).
4. The deployment tool runs `docker compose pull` and `docker compose up -d` on the remote host.
5. The init container runs again to fix permissions, then the main server starts with the new image.

### Rollback

If a new image causes issues, rollback to a known-good SHA-tagged image:

1. In your deployment tool, pin the image tag to a specific SHA, for example:
   ```yaml
   image: ghcr.io/alutke/stardrophost-dev:sha-abc1234
   ```
2. Redeploy. Docker will pull and run the pinned image.
3. To rollback the entire stack, pin all five images to their respective SHA tags.

## Troubleshooting

### GHCR Auth Failures

**Symptom:** `Error response from daemon: unauthorized` when pulling images.

**Fix:**
- Verify `docker login ghcr.io` on the Docker host.
- Check that the token has `read:packages` scope.
- If the repository is private, ensure the token's owner has access to the repository.
- Check image visibility in GitHub Packages settings.

### Missing Host Directories

**Symptom:** Container fails to start with "no such file or directory" for a volume mount.

**Fix:**
- Create the directories before deploying:
  ```bash
  sudo mkdir -p /srv/stardrophost/data/{saves,game,logs,backups,panel,custom-mods}
  ```
- Docker creates missing bind-mount directories as root, which causes permission issues. Always pre-create them.

### Volume Permission Issues

**Symptom:** The game or web panel cannot write to data directories.

**Fix:**
- Ensure directories are owned by UID 1000:
  ```bash
  sudo chown -R 1000:1000 /srv/stardrophost/data
  ```
- The init container runs as root and fixes permissions on startup, but if the init container is skipped or fails, manual fixing may be needed.

### Healthcheck Failures

**Symptom:** Container shows as `unhealthy`.

**Fix:**
- The server healthcheck waits for `StardewModdingAPI` process. On first run, the game files may need to be downloaded via the setup wizard, which can take several minutes. The healthcheck has a 900-second start period.
- If the container stays unhealthy, check logs:
  ```bash
  docker logs stardrop
  ```
- Ensure the game files are present in `/srv/stardrophost/data/game`.

### Confusion Between Deployment Tool Paths and Docker Host Paths

**Symptom:** Compose file references paths that do not exist.

**Important:** `compose.external.yml` uses absolute paths like `/srv/stardrophost/data/game`. These paths refer to the **remote Docker host filesystem**, not the deployment tool's filesystem. The deployment tool does not need to have these directories; it only needs to pass the compose file to the Docker host. The Docker host is responsible for creating and owning these paths.

If your deployment tool validates paths locally before deployment, you may need to disable path validation or create stub directories on the deployment server to satisfy its checks. The actual data lives on the Docker host.

### C# Mod Build at Startup

**Symptom:** Container logs show `Building StardropDashboard...` and `Building StardropHost.Dependencies...` on every startup.

**Explanation:** The bundled SMAPI mods (`StardropDashboard` and `StardropHost.Dependencies`) are compiled at container startup, not at image build time. This is necessary because they reference `StardewValley.dll`, which is only available via the mounted game volume. The Dockerfile pre-restores NuGet packages so the build works offline, but the actual compilation requires the game DLL.

**Expected behaviour:**
- First start (no game files): the build will fail with a warning. The server will still start, but live dashboard data and some server-management features will not work until game files are provided.
- Subsequent starts (with game files): the build succeeds in a few seconds. The compiled DLLs are written to the volume and persist across restarts.
- If `StardropHost.Dependencies.dll` already exists in the volume, that mod is skipped on restart.

**Fix:** Ensure game files are present in `/srv/stardrophost/data/game` before starting the server, or use the setup wizard to download them via Steam/GOG.

## Legacy Local Deployment

The files `docker-compose.yml`, `update.sh`, and `quick-start.sh` remain in the repository for local development and testing. They are **not** used by external Compose deployments. `quick-start.sh` performs a `git clone` on the target machine, which violates the remote-deployment constraint and should not be used for production external Compose deployments.
