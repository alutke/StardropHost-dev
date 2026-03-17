<div align="center">

# 🌟 StardropHost

### Your Stardew Valley dedicated server, managed entirely from your browser.

[![Docker](https://img.shields.io/badge/docker-tomomotto%2Fstardrophost-a78bfa?style=flat-square)](https://hub.docker.com/r/tomomotto/stardrophost)
[![GitHub](https://img.shields.io/badge/github-StardropHost-a78bfa?style=flat-square)](https://github.com/Tomomoto10/StardropHost)

*Run a 24/7 Stardew Valley farm for you and your friends — no command line required.*

</div>

---

## ✨ What is StardropHost?

StardropHost is a dedicated Stardew Valley server that your friends can join **any time, even when you're not playing**. It runs quietly in the background and everything — players, saves, mods, settings — is managed from a clean web interface in your browser.

Set it up once. Control everything from the web panel forever after.

> 🎮 **You need to own Stardew Valley.** Drop your game files in during first-run setup and you're good to go. No Steam account required to run the server.

---

## 🌿 Features

### A web panel that does everything
No terminal commands, no config file editing, no SSH sessions. The web panel gives you full control over your server from any browser on your network.

### Always-on multiplayer
Keeps server running around the clock. Friends can drop in and out whenever they want, no host needed. 

### Up to 8 players
Invite up to 8 friends to join your farm. Connect over LAN automatically, or share a Steam invite code for anyone joining over the internet.

### Save management
Create backups, download your saves, upload a save from your own PC, or switch between multiple farms — all from the Saves tab.

### Mod support
Upload any SMAPI-compatible mod as a `.zip` directly from the web panel. No extracting, no copying files — just upload and restart.

### Live server view
The Farm tab shows you what's happening right now — current season, weather, in-game time, and which players are online. No need to load up the game to check on things.

### Real-time logs and terminal
Watch the SMAPI console live, filter by errors or mod output, and run console commands — all from the browser without ever attaching to the container.

### VNC when you need it
Remote desktop access is available for edge cases, but you'll rarely need it. Enable it from the web panel with one click and it auto-shuts off after 30 minutes.

---

## 🚀 Getting Started

### One-command install

```bash
curl -fsSL https://raw.githubusercontent.com/Tomomoto10/StardropHost/main/quick-start.sh | bash
```

The script handles everything — Docker installation, directory setup, pulling images and starting containers. When it's done, open your browser to:

```
http://your-server-ip:18642
```

### First-run wizard

The web panel walks you through setup step by step:

1. Set your admin password
2. Drop in your Stardew Valley game files
3. Choose your server resource limits
4. Optionally password-protect your server
5. Your server starts — you're done

---

## 🎮 How Friends Connect

**Same network:**
Open Stardew Valley → Co-op → Join LAN Game. Your server appears automatically.

**Over the internet:**
Sign into Steam once in the Config tab and get a shareable invite code your friends can use directly from the Co-op menu — no port forwarding needed.

---

## 🧩 What's Included

StardropHost comes with a set of server mods pre-installed and pre-configured. You don't need to touch any of them — they just work.

| Mod | What it does |
|---|---|
| **Always On Server** | Keeps the farm running 24/7 without you needing to be in-game |
| **AutoHideHost** | Hides the host character and handles instant sleep transitions |
| **ServerAutoLoad** | Automatically loads your save on every server restart |
| **SkillLevelGuard** | Keeps skill levels accurate and prevents a known bug with Always On Server |
| **ServerDashboard** | Powers the live Farm tab in the web panel with real-time game data |

---

## 🖥️ Requirements

- A Linux machine, VPS, or home server
- 2GB RAM minimum (4GB recommended for 4+ players)
- A copy of Stardew Valley (Steam or GOG, Or elsewhere, ahrrr)

---

<div align="center">

Built on [puppy-stardew-server](https://github.com/truman-world/puppy-stardew-server) · Powered by [SMAPI](https://smapi.io/)

</div>

---

## 📄 License

MIT — see [LICENSE](LICENSE).
Stardew Valley is © ConcernedApe. This project is not affiliated with or endorsed by ConcernedApe.