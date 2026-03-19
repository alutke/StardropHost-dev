/**
 * StardropHost | mods-source/FarmAutoCreate/ModEntry.cs
 *
 * Headless co-op farm creation mod.
 *
 * When /home/steam/web-panel/data/new-farm.json exists and no saves are
 * present, this mod creates a new multiplayer farm programmatically as soon
 * as the title screen appears — no player interaction, no VNC, no xdotool.
 *
 * The technique is adapted from Junimo Host's GameCreatorService:
 *   github.com/Chikakoo/junimohost-stardew-server
 *
 * After creation:
 *   - new-farm.json is deleted (so it never runs again)
 *   - startup_preferences is updated with the save folder name
 *     (AlwaysOnServer / ServerAutoLoad pick it up on subsequent boots)
 */

using System;
using System.IO;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;
using StardewValley.Menus;

namespace FarmAutoCreate
{
    // ── Config model ─────────────────────────────────────────────────────────
    // Must match the JSON written by wizard.js submitNewFarm()
    internal sealed class NewFarmConfig
    {
        public string FarmName    { get; set; } = "Stardrop Farm";
        public string FarmerName  { get; set; } = "Host";
        public int    FarmType    { get; set; } = 0;   // 0=Standard 1=Riverland 2=Forest 3=Hill-top 4=Wilderness 5=Four Corners 6=Beach
        public int    CabinCount  { get; set; } = 1;   // 0-3
        public string PetType     { get; set; } = "cat";
    }

    // ── Mod entry point ───────────────────────────────────────────────────────
    public class ModEntry : Mod
    {
        private static readonly string ConfigPath =
            "/home/steam/web-panel/data/new-farm.json";
        private static readonly string SavesDir =
            "/home/steam/.config/StardewValley/Saves";
        private static readonly string StartupPrefsPath =
            "/home/steam/.config/StardewValley/startup_preferences";

        private bool _done = false;

        public override void Entry(IModHelper helper)
        {
            helper.Events.GameLoop.UpdateTicked += OnUpdateTicked;
            Monitor.Log("FarmAutoCreate loaded — watching for new-farm.json", LogLevel.Info);
        }

        // ── Poll once per second on the title screen ──────────────────────────
        private void OnUpdateTicked(object? sender, UpdateTickedEventArgs e)
        {
            if (_done) return;
            if (!e.IsOneSecond) return;

            // Only act while the title menu is shown
            if (Game1.activeClickableMenu is not TitleMenu) return;

            // Nothing to do if config file isn't present
            if (!File.Exists(ConfigPath)) return;

            _done = true; // prevent re-entry even if something throws

            try
            {
                var json = File.ReadAllText(ConfigPath);
                var cfg  = JsonSerializer.Deserialize<NewFarmConfig>(
                    json,
                    new JsonSerializerOptions { PropertyNameCaseInsensitive = true }
                );

                if (cfg == null)
                {
                    Monitor.Log("new-farm.json deserialized to null — skipping farm creation.", LogLevel.Warn);
                    File.Delete(ConfigPath);
                    return;
                }

                // If saves already exist we don't need to create one
                if (Directory.Exists(SavesDir) &&
                    Directory.GetDirectories(SavesDir).Length > 0)
                {
                    Monitor.Log("Save files already present — skipping farm auto-create.", LogLevel.Info);
                    File.Delete(ConfigPath);
                    return;
                }

                Monitor.Log(
                    $"[FarmAutoCreate] Creating \"{cfg.FarmName}\" " +
                    $"(type={cfg.FarmType}, farmer={cfg.FarmerName}, " +
                    $"cabins={cfg.CabinCount}, pet={cfg.PetType})",
                    LogLevel.Info
                );

                CreateFarm(cfg);

                File.Delete(ConfigPath);
                Monitor.Log("[FarmAutoCreate] Farm created and new-farm.json removed.", LogLevel.Info);
            }
            catch (Exception ex)
            {
                Monitor.Log($"[FarmAutoCreate] Failed: {ex}", LogLevel.Error);
                // Leave new-farm.json in place so the user can retry
                _done = false;
            }
        }

        // ── Programmatic farm creation (adapted from Junimo Host) ─────────────
        private void CreateFarm(NewFarmConfig cfg)
        {
            // Player identity
            Game1.player.Name                = cfg.FarmerName;
            Game1.player.displayName         = cfg.FarmerName;
            Game1.player.farmName.Value      = cfg.FarmName;
            Game1.player.favoriteThing.Value = "Farming";
            Game1.player.catPerson           = !string.Equals(cfg.PetType, "dog",
                                                   StringComparison.OrdinalIgnoreCase);
            Game1.player.isCustomized.Value  = true;
            Game1.player.ConvertClothingOverrideToClothesItems();

            // Farm settings
            Game1.startingCabins      = cfg.CabinCount;
            Game1.whichFarm           = cfg.FarmType;
            Game1.spawnMonstersAtNight = cfg.FarmType == 4; // Wilderness farm
            Game1.multiplayerMode     = 2;                  // Enable multiplayer hosting

            // ── Create game — mirrors TitleMenu.createdNewCharacter ──────────
            Game1.loadForNewGame(false);
            Game1.saveOnNewDay = true;

            // Skip the prologue cutscene
            Game1.player.eventsSeen.Add(60367);

            // Put farmer to bed so the first day begins immediately
            Game1.player.currentLocation = Utility.getHomeOfFarmer(Game1.player);
            Game1.player.Position        = new Vector2(9f, 9f) * 64f;
            Game1.player.isInBed.Value   = true;

            // Advance to Day 1 — this triggers the save-to-disk
            Game1.NewDay(0f);
            Game1.exitActiveMenu();
            Game1.setGameMode(3);

            // ── Persist the save name ────────────────────────────────────────
            // Constants.SaveFolderName contains the freshly-written folder name.
            // We record it in startup_preferences so AlwaysOnServer / ServerAutoLoad
            // can load the correct save on every subsequent container boot.
            var saveName = Constants.SaveFolderName;
            if (!string.IsNullOrEmpty(saveName))
            {
                Monitor.Log($"[FarmAutoCreate] Save folder: {saveName}", LogLevel.Info);
                WriteStartupPreferences(saveName);
            }
            else
            {
                Monitor.Log("[FarmAutoCreate] WARNING: Could not determine save folder name.", LogLevel.Warn);
            }
        }

        // ── Write startup_preferences ─────────────────────────────────────────
        private void WriteStartupPreferences(string saveFolderName)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(StartupPrefsPath)!);

                string content = File.Exists(StartupPrefsPath)
                    ? File.ReadAllText(StartupPrefsPath)
                    : "";

                var newLine = $"saveFolderName={saveFolderName}";

                if (Regex.IsMatch(content, @"^saveFolderName\s*=",
                        RegexOptions.Multiline))
                {
                    content = Regex.Replace(content,
                        @"^saveFolderName\s*=.*$",
                        newLine,
                        RegexOptions.Multiline);
                }
                else
                {
                    content = content.TrimEnd() + "\n" + newLine + "\n";
                }

                File.WriteAllText(StartupPrefsPath, content);
                Monitor.Log($"[FarmAutoCreate] startup_preferences updated: {newLine}", LogLevel.Info);
            }
            catch (Exception ex)
            {
                Monitor.Log($"[FarmAutoCreate] Could not write startup_preferences: {ex.Message}", LogLevel.Warn);
            }
        }
    }
}
