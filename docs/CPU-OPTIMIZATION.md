# CPU Optimization — LOW_PERF_MODE

**Date:** 2026-03-09
**Applies to:** StardropHost v1.0.0+

---

## Overview

`LOW_PERF_MODE=true` is an opt-in flag that reduces CPU and memory overhead for the containerised server. Default behavior is unchanged when unset or set to `false`.

---

## What Changes in LOW_PERF_MODE

### 1. Xvfb render cost reduction

Implemented in `docker/scripts/entrypoint.sh`:

- Resolution: `800×600` (vs default `1280×720`)
- Color depth: `16-bit` (vs default `24-bit`)
- Framebuffer directory: `/dev/shm/xvfb` via `-fbdir` (reduces backing-store overhead)

Expected CPU savings: ~15–30% on software-rendered Xvfb paths.

### 2. SDL and graphics tuning

In low-perf mode the following env vars are exported before game launch:

- `SDL_VIDEODRIVER=x11` — explicit Linux backend (avoids probe overhead)
- `SDL_AUDIODRIVER=dummy` — disables audio output (server is unattended)
- `LIBGL_ALWAYS_SOFTWARE=1` — only applied when `USE_GPU != true`; avoids failed hardware GL probing on Xvfb

> `SDL_VIDEODRIVER=dummy` was **not** used here. It would remove the visible X11 surface and break VNC. `x11` preserves full VNC compatibility.

Expected savings: ~2–5% from dummy audio driver; stabilises software GL path.

### 3. Mono / .NET GC tuning

- `MONO_GC_PARAMS=nursery-size=8m` — reduces minor GC collection frequency
- `DOTNET_GCHeapHardLimit=0x30000000` (768 MiB) — caps managed heap growth

Expected savings: ~0–5% CPU, mainly fewer minor collections. Slight memory tradeoff.

### 4. Startup preferences alignment

When `LOW_PERF_MODE=true`, `startup_preferences` is rewritten to match the lower resolution:

- Fullscreen and preferred resolution → `800×600`
- `vsyncEnabled=true`
- `startMuted=true`
- Music and sound volumes → `0`

Without this, the game config can keep requesting `1280×720` after the X server has been reduced to `800×600`, causing unnecessary resize attempts.

---

## Always On Server Mod

The `AlwaysOnServer` DLL was reviewed for tick-throttling or FPS-cap config options:

- No exposed `targetFPS` config key found
- No exposed render-skip or tick-throttle option

Internal symbols (`Rendered`, `skipTicks`, `UpdateTicked`) exist in the DLL but are not safely configurable through `config.json`. The mod config is left unchanged.

---

## What Was Considered But Not Enabled

| Option | Reason not used |
|---|---|
| `SDL_VIDEODRIVER=dummy` | Breaks visible rendering and VNC |
| Enabling low-perf globally | Would change default behavior; opt-in only |
| Forcing mod-level FPS cap | No safe Always On Server config found |

---

## Restart Requirements

A container restart is required when changing:

- `LOW_PERF_MODE`
- `USE_GPU`
- Any `SDL_*` env var
- `LIBGL_ALWAYS_SOFTWARE`
- `MONO_GC_PARAMS`
- `DOTNET_GCHeapHardLimit`

Startup preferences are rewritten automatically on restart when `LOW_PERF_MODE=true` — no manual file edits needed.

---

## Estimated Impact

| Deployment type | Expected CPU reduction |
|---|---|
| Best-case (software Xvfb, no GPU) | 20–40% |
| Typical steady-state | 15–25% |

These are engineering estimates based on the changes above. Direct benchmarks have not been run in this repository.

---

## Future Work

- Benchmark actual CPU deltas: `LOW_PERF_MODE=false` vs `true`
- Expose `LOW_PERF_RESOLUTION` and `LOW_PERF_DEPTH` as first-class env vars if finer control is needed
- Investigate whether a newer Always On Server release exposes a frame-cap config
- If a safe headless MonoGame path is confirmed, evaluate `SDL_VIDEODRIVER=dummy` behind a separate experimental flag

---

## References

- [Xvfb man page](https://www.x.org/archive/X11R7.0/doc/html/Xvfb.1.html)
- [SDL hint docs — SDL_HINT_VIDEODRIVER](https://wiki.libsdl.org/SDL2/SDL_HINT_VIDEODRIVER)
- [Mono SGen GC docs](https://www.mono-project.com/docs/advanced/garbage-collector/sgen/)
- [.NET GCHeapHardLimit docs](https://learn.microsoft.com/en-us/dotnet/core/runtime-config/garbage-collector)
