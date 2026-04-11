# StardropHost — Mod Reference

All server mod functionality is built from source in `docker/mods-source/`.
Full attribution and licensing details will be covered in `README.md`.

## Shipped Mods (built from source)

| Mod | UniqueID | Purpose |
|---|---|---|
| StardropHost.Dependencies | `stardrop.Dependencies` | Core server mod — headless operation, host hiding, save loading, auto-sleep, network tuning, chat bridge, kick/ban |
| StardropDashboard | `stardrop.StardropDashboard` | Writes live game data to `live-status.json` every 10s — feeds the Farm tab in the web panel |

## Previously Shipped (replaced by Dependencies)

| Mod | Replaced by |
|---|---|
| AlwaysOnServer (mikko.Always_On_Server) | HeadlessServer service in Dependencies |
| AutoHideHost (stardrop.AutoHideHost) | HostBot service in Dependencies |
| ServerAutoLoad (stardrop.ServerAutoLoad) | GameLoader service in Dependencies |
| SkillLevelGuard (stardrop.SkillLevelGuard) | HeadlessServer service in Dependencies |
