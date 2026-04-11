# Contributing to StardropHost

Thanks for your interest in contributing.

---

## Reporting Bugs

Before filing an issue:

1. **Search existing issues** to avoid duplicates.
2. **Collect logs:**
   ```bash
   docker logs stardrop > stardrop.log
   docker exec stardrop cat /home/steam/.config/StardewValley/ErrorLogs/SMAPI-latest.txt > smapi.log
   ```
3. **Note your environment:** Docker version, host OS, whether you're using GPU mode, VNC, etc.
4. **Open an issue** with the above attached. Do not paste full logs inline — use attachments or a gist.

---

## Feature Requests

Please describe:
- What the feature does
- Why it's needed (use case)
- Any implementation thoughts (optional)

---

## Pull Requests

1. Fork the repo and create a branch: `git checkout -b fix/your-description`
2. Make your changes and test locally (see below).
3. Commit with a short, descriptive message.
4. Open a PR against `main` with a clear description of what changed and why.

---

## Development Setup

### Build the image

```bash
# From the repo root
docker build -t stardrop-server:dev -f docker/Dockerfile docker/
```

### Run a dev container (no game files)

```bash
docker compose up stardrop-init stardrop-manager
docker compose up stardrop-server
```

### Run offline script tests (no Docker or game required)

```bash
bash tests/test-new-features.sh
```

### Test the steam-auth sidecar API

```bash
docker compose up stardrop-steam-auth
bash tests/test-steam-guard.sh
```

### Verify a live deployment

```bash
./verify-deployment.sh
```

---

## Code Style

### Shell scripts

- Quote all variable expansions: `"$VAR"`, not `$VAR`
- Use `local` for function-scoped variables
- Prefer explicit error handling over `set -e`
- Log via the existing `log_info` / `log_warn` / `log_error` functions
- Keep functions small and named clearly

### Node.js (web panel / sidecars)

- `const`/`let` only — no `var`
- Early returns over nested conditionals
- Async/await over raw Promise chains

### Dockerfile

- Combine related `RUN` steps to minimise layers
- Clean up apt caches and build artefacts in the same layer they are created
- Pin versions (`SMAPI-4.3.2`, `dotnet-sdk-6.0`) — do not use `latest`

### Commit messages

```
type(scope): short description

Optional longer explanation.
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`

---

## Testing Checklist (before opening a PR)

- [ ] `bash tests/test-new-features.sh` passes
- [ ] `bash -n docker/scripts/*.sh` passes (syntax check)
- [ ] Image builds without error: `docker build -t stardrop-server:dev -f docker/Dockerfile docker/`
- [ ] Web panel loads and setup wizard completes
- [ ] Relevant docs updated (`CHANGELOG.md`, `KNOWN_ISSUES.md` if applicable)

---

## License

By contributing you agree that your changes will be licensed under the project's MIT license.
