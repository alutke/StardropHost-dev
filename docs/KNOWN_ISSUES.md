# Known Issues

Bug testing is ongoing. Known issues are listed below and will be fixed in upcoming updates.

## Open Issues

| # | Area | Description |
|---|---|---|
| 1 | Backups | Auto-backup fires at startup before `StardropDashboard` has written `farmName` — backup is created with slug `unknown`. Interval backups (after first game load) are unaffected. |
| 2 | Saves | Uploading a save zip whose folder name already exists silently renames it instead of prompting to overwrite — game cannot load the renamed save. |
| 3 | Saves | Save files in renamed folders (e.g. `StardropFarm_434722410 (1)`) display as `0 B · unknown` in the Saves tab. |
| 4 | Players | Deleting a farmhand slot requires a server restart. No confirmation or pending-restart prompt is shown. |
| 5 | Players | "Remove" on Known Players is lost on restart — the list is in-memory only and does not persist. |

---

## Reporting a Bug

If you encounter an issue, please open a report at:
**https://github.com/Tomomoto10/StardropHost-dev/issues**

Include the following with your report:

**Log files** — The easiest way to get logs is from the web panel **Console** tab, which lets you download them directly. Attach the file to your issue rather than pasting inline.

If you need to retrieve logs manually over SSH:

| Log | Host path | SSH command |
|-----|-----------|-------------|
| SMAPI (game) | `data/saves/ErrorLogs/SMAPI-latest.txt` | `cat data/saves/ErrorLogs/SMAPI-latest.txt` |
| Setup / entrypoint | `data/logs/setup.log` | `cat data/logs/setup.log` |
| Container output | _(Docker)_ | `docker logs stardrop` |

To save a log to a file for attaching:
```bash
docker logs stardrop > stardrop.log
cat data/saves/ErrorLogs/SMAPI-latest.txt > smapi.log
```

**Environment details:**
- Host OS and Docker version
- How StardropHost was installed (quick-start, manual)
- Steps to reproduce the issue
- What you expected to happen vs. what actually happened

---

**Last Updated:** 2026-04-12
**Version:** v1.0.0
