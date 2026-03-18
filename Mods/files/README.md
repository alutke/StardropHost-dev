# ServerDashboard — SMAPI Mod

A lightweight SMAPI mod for the Puppy Stardew Server fork.  
It writes live game data to `live-status.json` every 10 seconds so the web panel can display real-time information without needing VNC or log scraping.

---

## What it outputs

`~/.local/share/puppy-stardew/live-status.json`

```json
{
  "timestamp": 1718000000,
  "serverState": "running",
  "farmName": "Sunflower Farm",
  "season": "summer",
  "day": 12,
  "year": 2,
  "gameTimeMinutes": 1300,
  "dayTimeFormatted": "1:00 PM",
  "weather": "sunny",
  "isFestivalDay": false,
  "festivalName": "",
  "sharedMoney": 48200,
  "players": [
    {
      "name": "Hazel",
      "uniqueId": "123456789",
      "isHost": true,
      "isOnline": true,
      "health": 100,
      "maxHealth": 100,
      "stamina": 270,
      "maxStamina": 270,
      "money": 48200,
      "totalEarned": 120000,
      "locationName": "Desert",
      "skills": {
        "farming": 10,
        "mining": 5,
        "foraging": 4,
        "fishing": 7,
        "combat": 3,
        "luck": 0
      },
      "daysPlayed": 40
    }
  ],
  "cabins": [
    {
      "ownerName": "FriendPlayer",
      "isOwnerOnline": true,
      "tileX": 21,
      "tileY": 6,
      "isUpgraded": true
    }
  ]
}
```

---

## File structure

```
ServerDashboard/
├── ModEntry.cs           ← Main mod logic
├── Models.cs             ← Data classes (LiveStatus, PlayerData, etc.)
├── ModConfig.cs          ← User config
├── manifest.json         ← SMAPI manifest
└── ServerDashboard.csproj
```

---

## Building

### Prerequisites

- [.NET 6 SDK](https://dotnet.microsoft.com/download/dotnet/6.0)
- Stardew Valley installed (Steam or GOG)
- SMAPI installed

### Steps

```bash
# 1. Clone / copy this folder somewhere
cd ServerDashboard

# 2. Build
dotnet build

# 3. The built mod will be copied to your game's Mods folder automatically
#    (the Pathoschild.Stardew.ModBuildConfig NuGet handles this)
```

### Building inside the Docker container (for the server fork)

The puppy-stardew-server Dockerfile already builds the other C# mods.
Add this mod to the same build step:

```dockerfile
# In the Dockerfile, alongside the other mod builds:
COPY docker/mods/ServerDashboard /build/ServerDashboard
RUN dotnet build /build/ServerDashboard -c Release -o /build/ServerDashboard/bin
RUN cp -r /build/ServerDashboard/bin/ServerDashboard \
    /home/steam/stardewvalley/Mods/ServerDashboard
```

---

## Configuration

On first run SMAPI creates `config.json` in the mod folder:

```json
{
  "UpdateIntervalSeconds": 10,
  "OutputDirectory": ""
}
```

- **UpdateIntervalSeconds** — how often to write the file. 5–15 seconds is ideal.
- **OutputDirectory** — leave blank to use `~/.local/share/puppy-stardew/`. 
  Override if your web panel reads from a different path.

---

## How the web panel reads it

The `live-status.json` file is in the same Docker volume that the web panel already has access to (`./data/logs` maps to `~/.local/share/puppy-stardew/`).

In the Node.js web panel, read it like:

```javascript
const fs = require('fs');

function getLiveStatus() {
  try {
    const raw = fs.readFileSync('/home/steam/.local/share/puppy-stardew/live-status.json', 'utf8');
    return JSON.parse(raw);
  } catch {
    return { serverState: 'offline' };
  }
}
```

Or watch for changes with `fs.watch()` to push updates to the browser via WebSocket without polling.

---

## Console command

In the SMAPI console (or via the web panel terminal):

```
dashboard_status
```

Forces an immediate write of `live-status.json`. Useful for testing.

---

## Compatibility

- Stardew Valley 1.6.0+
- SMAPI 4.0.0+
- Server-side only — farmhand clients do NOT need this mod
- Compatible with AlwaysOnServer, AutoHideHost, ServerAutoLoad, SkillLevelGuard
