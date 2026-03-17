<div align="center">

![StardropHost](https://github.com/Tomomoto10/StardropHost/blob/main/banner.png)

### Self-hosted Stardew Valley server, managed entirely from your browser


[![Docker](https://img.shields.io/badge/docker-tomomotto%2Fstardrophost-a78bfa?style=flat-square)](https://hub.docker.com/r/tomomotto/stardrophost)
[![GitHub](https://img.shields.io/badge/github-StardropHost-a78bfa?style=flat-square)](https://github.com/Tomomoto10/StardropHost)

--------------

*Run a 24/7 cross-platform Stardew Valley farm for you and your friends.*

<sub>Play together on PC, mobile, and any platform Stardew Valley Co-op supports</sub>

</sub>

---

**No Steam account required**

<sub>

Only needed if you don’t already have the game files installed  

Optional for generating a share code for remote play  

Not required for LAN play  

</sub>


</div>

---
## ✨ What is StardropHost?

StardropHost is a self-hosted Stardew Valley server that your friends can join **any time, even when you're not playing**.

It runs quietly in the background, and everything — players, saves, mods, and settings — is managed from a clean web interface in your browser.

Set it up once. Control everything from the Web Dashbord, minimal technical skills required.

---

## 🌿 Features

### 🖥️ A Web Dashboard that does everything
Once installed there is no terminal commands, no config file editing, no SSH or VNC sessions. The web panel gives you full control over your server from any browser on your network.

### 🔐 Steam account *OPTIONAL*
Drop your game files in during first-run setup and you're good to go. No Steam account is required to run the server.

### ⏱️ Always-on multiplayer
Keeps the server running around the clock. Friends can drop in and out whenever they want — no host needed.

### 👥 Up to 8 players
Invite up to 8 friends to join your farm. Connect over LAN, or share a Steam invite code for internet play.

### 💾 Save management
Create backups, download saves, upload your own, or switch between multiple farms — all from the **Saves** tab.

### 📊 Live server view
The **Farm** tab shows real-time data — current season, weather, in-game time, and active players.

### 🧩 Mod support
Upload any SMAPI-compatible mod as a `.zip` directly from the web panel. No extracting or manual file handling required. *Some mods need to be installed on host and client devices

### 🧪 Real-time logs and terminal
View the SMAPI console live, filter logs, and run commands — all from your browser.

### 🖥️ VNC when you need it
Remote desktop access is available for technical bug fixing cases. Enable it with one click; it automatically shuts off after 30 minutes.

---

## 🚀 Getting Started

### One-command install

```bash
curl -fsSL https://raw.githubusercontent.com/Tomomoto10/StardropHost/main/quick-start.sh | bash
```

The script handles:
- Docker installation  
- Directory setup  
- Image pulling  
- Container startup  

Once complete, open:

```
http://your-server-ip:18642
```

---

### First-run wizard

The web panel guides you through setup:

1. Set your admin password  
2. Drop in your Stardew Valley game files  
3. Choose server resource limits  
4. (Optional) Password-protect your server  
5. Start your server  

---

## 🎮 How Friends Connect

### Same network (LAN)
Open Stardew Valley → **Co-op → Join LAN Game**

- Your server will appear automatically in the list  
- Or connect manually by entering the server’s IP address  

### Over the internet
Sign into Steam once in the **Config** tab to generate a shareable invite code.  
No port forwarding required.

---

## 🧩 What's Included

StardropHost comes with pre-installed and pre-configured server mods:

| Mod | What it does |
|-----|-------------|
| **Always On Server** | Keeps the farm running 24/7 |
| **AutoHideHost** | Hides the host character and handles sleep transitions |
| **ServerAutoLoad** | Automatically loads your save on restart |
| **SkillLevelGuard** | Prevents known skill desync issues |
| **ServerDashboard** | Powers real-time data in the web panel |

---

## 🖥️ Requirements

- Linux machine, VPS, or home server  
- 2GB RAM minimum (4GB recommended for 4+ players)  
- A copy of Stardew Valley (Steam, GOG, or otherwise)

---

<div align="center">

Built on [puppy-stardew-server](https://github.com/truman-world/puppy-stardew-server)  
Powered by [SMAPI](https://smapi.io/)

</div>

---

## 📄 License

MIT — see [LICENSE](LICENSE)

Stardew Valley is © ConcernedApe.  
This project is not affiliated with or endorsed by ConcernedApe.
