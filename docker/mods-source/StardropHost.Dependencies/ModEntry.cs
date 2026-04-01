/**
 * StardropHost | mods-source/StardropHost.Dependencies/ModEntry.cs
 *
 * Combined server management mod. Replaces:
 *   - AlwaysOnServer      (headless server, auto-sleep, friendship decay)
 *   - AutoHideHost        (host hiding, instant sleep, menu handling, event skipping)
 *   - StardropGameManager (save loading, farm creation)
 *   - SkillLevelGuard     (not needed — we do not set skills to 10)
 *
 * StardropDashboard remains a separate mod (web panel Farm tab data writer).
 *
 * License acknowledgements:
 *   - AlwaysOnServer by funny-snek & Zuberii (Unlicense / public domain)
 *   - WaitCondition helper pattern adapted from SMAPIDedicatedServerMod
 *     by ObjectManagerManager (MIT) — https://github.com/ObjectManagerManager/SMAPIDedicatedServerMod
 */

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using HarmonyLib;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;
using StardewValley.Locations;
using StardewValley.Menus;
using StardewValley.Objects;

namespace StardropHostDependencies
{
    public class ModEntry : Mod
    {
        // ── Constants ────────────────────────────────────────────────────────
        private const string NewFarmConfigPath   = "/home/steam/web-panel/data/new-farm.json";
        private const string ChatLogPath         = "/home/steam/.local/share/stardrop/chat.log";
        private const int    AutoSleepTime       = 2600;  // 2:00 AM in-game clock
        private const int    GuardWindowSeconds  = 60;
        private const int    SkipCooldownSeconds = 5;

        private static readonly JsonSerializerOptions _chatJsonOpts = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        };

        // ── Game Loader state ────────────────────────────────────────────────
        private bool           _farmStageEnabled = false;
        private readonly WaitCondition _titleMenuCondition = new(() => Game1.activeClickableMenu is TitleMenu, 5);
        private NewFarmConfig? _cfg         = null;
        private bool           _petHandled  = false;
        private bool           _caveHandled = false;
        private int            _runtimeTick = 0;

        private static readonly FieldInfo _namingMenuTextBoxField =
            typeof(NamingMenu).GetField("textBox", BindingFlags.NonPublic | BindingFlags.Instance)!;

        // ── Host Bot state ───────────────────────────────────────────────────
        private bool      _hasTriggeredSleep  = false;
        private bool      _isSleepInProgress  = false;
        private bool      _handledReadyCheck  = false;
        private DateTime? _guardWindowEnd     = null;
        private bool      _needRehide         = false;
        private int       _rehideTicks        = 0;
        private string?   _lastSkippedEventId = null;
        private DateTime? _lastSkipTime       = null;

        // ── Security config (blocklist/allowlist from web panel) ────────────────
        private const string SecurityConfigPath = "/home/steam/web-panel/data/security.json";
        private const string NameIpMapPath      = "/home/steam/web-panel/data/name-ip-map.json";
        private const int    SecCacheTtlSeconds = 15;

        private SecurityConfig?            _secConfig        = null;
        private DateTime                   _secConfigLoadTime = DateTime.MinValue;
        private Dictionary<string, string> _nameIpMap        = new();

        // ── Ban map (name → all bannedUsers keys for this ban: name + IP) ───────
        private const string BanMapPath = "/home/steam/.local/share/stardrop/ban-map.json";
        // bansByName["Tom"] = ["Tom", "192.168.0.140"]
        private Dictionary<string, List<string>> _bansByName = new();
        // idToName["1314339377246380246"] = "Tom"
        private Dictionary<string, string> _idToName = new();

        private void LoadBanMap()
        {
            try
            {
                if (!File.Exists(BanMapPath)) return;
                var doc = JsonSerializer.Deserialize<JsonElement>(File.ReadAllText(BanMapPath));
                if (doc.TryGetProperty("bansByName", out var bbn))
                    _bansByName = JsonSerializer.Deserialize<Dictionary<string, List<string>>>(bbn.GetRawText()) ?? new();
                if (doc.TryGetProperty("idToName", out var itn))
                    _idToName = JsonSerializer.Deserialize<Dictionary<string, string>>(itn.GetRawText()) ?? new();
            }
            catch { _bansByName = new(); _idToName = new(); }
        }

        private void SaveBanMap()
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(BanMapPath)!);
                File.WriteAllText(BanMapPath, JsonSerializer.Serialize(new { bansByName = _bansByName, idToName = _idToName }));
            }
            catch { }
        }

        // ── Headless Server state ────────────────────────────────────────────
        private readonly Dictionary<string, int> _prevFriendships = new();

        // ── Rendering state (shared by Harmony patches) ──────────────────────
        private static bool _shouldDrawFrame = false;
        private static ModEntry _instance;

        // ── DesyncKicker ─────────────────────────────────────────────────────
        private System.Threading.CancellationTokenSource? _desyncBarrierCts;
        private System.Threading.CancellationTokenSource? _desyncSaveCts;

        // ════════════════════════════════════════════════════════════════════
        // ENTRY
        // ════════════════════════════════════════════════════════════════════

        public override void Entry(IModHelper helper)
        {
            _instance = this;
            LoadNameIpMap();
            // Headless server optimisations — disable rendering, sound, and input.
            // Approach from JunimoServer (MIT): patch at MonoGame level using SuppressDraw()
            // so frame presentation is suppressed, not just the game's draw method.
            // Each patch is individually try-caught so a single failure can't prevent mod load.
            var harmony = new Harmony(ModManifest.UniqueID);

            try
            {
                harmony.Patch(
                    AccessTools.Method(typeof(Game), "BeginDraw"),
                    prefix: new HarmonyMethod(typeof(ModEntry), nameof(BeginDraw_Prefix)));
            }
            catch (Exception ex) { Monitor.Log($"[HeadlessServer] BeginDraw patch failed: {ex.Message}", LogLevel.Warn); }

            foreach (var sig in new[]
            {
                "StardewValley.Game1:updateMusic",
                "StardewValley.Game1:initializeVolumeLevels",
                "StardewValley.Audio.SoundsHelper:PlayLocal",
                "StardewValley.Game1:UpdateControlInput",
                "StardewValley.BellsAndWhistles.Butterfly:update",
                "StardewValley.BellsAndWhistles.AmbientLocationSounds:update",
            })
            {
                try
                {
                    harmony.Patch(AccessTools.Method(sig),
                        prefix: new HarmonyMethod(typeof(ModEntry), nameof(Disable_Prefix)));
                }
                catch (Exception ex) { Monitor.Log($"[HeadlessServer] Patch '{sig}' skipped: {ex.Message}", LogLevel.Trace); }
            }

            try
            {
                harmony.Patch(
                    AccessTools.Method(typeof(ChatBox), "receiveChatMessage"),
                    postfix: new HarmonyMethod(typeof(ModEntry), nameof(ReceiveChatMessage_Postfix)));
            }
            catch (Exception ex) { Monitor.Log($"[ChatBridge] receiveChatMessage patch failed: {ex.Message}", LogLevel.Warn); }

            helper.Events.GameLoop.SaveLoaded       += OnSaveLoaded;
            helper.Events.GameLoop.DayStarted       += OnDayStarted;
            helper.Events.GameLoop.UpdateTicked     += OnUpdateTicked;
            helper.Events.GameLoop.TimeChanged      += OnTimeChanged;
            helper.Events.GameLoop.Saving           += OnSaving;
            helper.Events.GameLoop.Saved            += OnSaved;
            helper.Events.GameLoop.DayEnding        += OnDayEnding;
            helper.Events.Display.MenuChanged       += OnMenuChanged;
            helper.Events.Multiplayer.PeerConnected      += OnPeerConnected;
            helper.Events.Multiplayer.PeerDisconnected   += OnPeerDisconnected;
            helper.Events.Player.Warped                  += OnWarped;

            helper.ConsoleCommands.Add("kick",  "Kick a connected farmhand. Usage: kick <name|id>",          OnKickCommand);
            helper.ConsoleCommands.Add("ban",   "Ban a connected farmhand. Usage: ban <name|id>",             OnBanCommand);
            helper.ConsoleCommands.Add("unban", "Unban a player by name. Usage: unban <name|id>",             OnUnbanCommand);
            helper.ConsoleCommands.Add("say",   "Broadcast a chat message as host. Usage: say <message>",    OnSayCommand);
            helper.ConsoleCommands.Add("tell",  "Send a private message. Usage: tell <player> <message>",    OnTellCommand);

            // Per-farmhand admin commands (used by web panel admin modal)
            helper.ConsoleCommands.Add("stardrop_sethealth",   "Set a farmhand's health. Usage: stardrop_sethealth <name> <amount>",     OnSetHealthCommand);
            helper.ConsoleCommands.Add("stardrop_setstamina",  "Set a farmhand's stamina. Usage: stardrop_setstamina <name> <amount>",   OnSetStaminaCommand);
            helper.ConsoleCommands.Add("stardrop_give",        "Give item to a farmhand. Usage: stardrop_give <name> <itemId> <count>",  OnGiveItemCommand);
            helper.ConsoleCommands.Add("stardrop_emote",       "Play emote for a farmhand. Usage: stardrop_emote <name> <emoteId>",     OnEmoteCommand);

            // CropSaver — crops don't die when cabin owner is offline
            try
            {
                harmony.Patch(
                    AccessTools.Method(typeof(StardewValley.Crop), "Kill"),
                    prefix: new HarmonyMethod(typeof(ModEntry), nameof(CropKill_Prefix)));
            }
            catch (Exception ex) { Monitor.Log($"[CropSaver] Crop.Kill patch failed: {ex.Message}", LogLevel.Warn); }

            Monitor.Log("StardropHost.Dependencies loaded.", LogLevel.Info);
        }

        // ════════════════════════════════════════════════════════════════════
        // SMAPI EVENTS
        // ════════════════════════════════════════════════════════════════════

        private void OnSaveLoaded(object? sender, SaveLoadedEventArgs e)
        {
            LoadBanMap();

            // Remove built-in player cap so any number of farmhands can connect
            try { Game1.netWorldState.Value.CurrentPlayerLimit = int.MaxValue; }
            catch (Exception ex) { Monitor.Log($"Could not remove player limit: {ex.Message}", LogLevel.Warn); }

            // Apply move-build permission from farm config (new-farm.json)
            if (_cfg?.MoveBuildPermission is string perm && perm != "off")
            {
                try { (Game1.chatBox as ChatBox)?.textBoxEnter($"/mbp {perm}"); }
                catch { /* chatBox not ready yet */ }
            }

            if (Context.IsMainPlayer)
            {
                HideHost();
                _hasTriggeredSleep = false;
                _isSleepInProgress = false;
                _handledReadyCheck = false;
            }

            Monitor.Log("[StardropHost.Dependencies] Server ready for connections.", LogLevel.Info);
        }

        private void OnDayStarted(object? sender, DayStartedEventArgs e)
        {
            _shouldDrawFrame = false; // re-suppress after DayEnding enabled it for save
            if (!Context.IsMainPlayer) return;

            HideHost();
            _hasTriggeredSleep  = false;
            _isSleepInProgress  = false;
            _handledReadyCheck  = false;
            _lastSkippedEventId = null;
            _lastSkipTime       = null;

            // Guard window at day start — players may already be online
            _guardWindowEnd = DateTime.Now.AddSeconds(GuardWindowSeconds);
        }

        private void OnUpdateTicked(object? sender, UpdateTickedEventArgs e)
        {
            // Network tuning — re-applied every tick because the game reverts these.
            // Broadcast periods at 3 (20/s) rather than default 1 (60/s).
            if (Context.IsWorldReady)
            {
                Game1.Multiplayer.defaultInterpolationTicks      = 7;
                Game1.Multiplayer.farmerDeltaBroadcastPeriod     = 3;
                Game1.Multiplayer.locationDeltaBroadcastPeriod   = 3;
                Game1.Multiplayer.worldStateDeltaBroadcastPeriod = 3;
            }

            // Keep host alive (prevents pass-out blocking end-of-day)
            if (Context.IsWorldReady && Context.IsMainPlayer)
            {
                Game1.player.health  = Game1.player.maxHealth;
                Game1.player.stamina = Game1.player.maxStamina.Value;

                // Freeze game time when no farmhands are connected.
                // Without this, time ticks freely all day with no players online.
                // Matches AlwaysOnServer behaviour: gameTimeInterval reset to 0 each tick
                // prevents the minute counter from advancing until someone joins.
                bool hasFarmhands = Game1.getOnlineFarmers()
                    .Any(f => f.UniqueMultiplayerID != Game1.player.UniqueMultiplayerID);
                if (!hasFarmhands && !_isSleepInProgress)
                    Game1.gameTimeInterval = 0;
            }

            // Runtime dialogue handling — pet/cave choice for new farm creation
            if (Context.IsWorldReady && _cfg != null)
            {
                if (++_runtimeTick >= 60) { _runtimeTick = 0; HandleRuntimeDialogues(); }
            }

            // Title screen: detect and run farm stage once TitleMenu is stable
            if (!_farmStageEnabled && _titleMenuCondition.IsMet())
            {
                _farmStageEnabled = true;
                RunFarmStage();
            }

            if (!Context.IsMainPlayer) return;

            // Delayed re-hide after peer connect
            if (_needRehide && _rehideTicks > 0 && --_rehideTicks == 0)
            {
                HideHost();
                _needRehide = false;
            }

            // Sleep state maintenance — keep host in bed during overnight transition
            if (_isSleepInProgress)
            {
                if (!Game1.player.isInBed.Value || Game1.player.timeWentToBed.Value == 0)
                {
                    Game1.player.isInBed.Value       = true;
                    Game1.player.timeWentToBed.Value = Game1.timeOfDay;
                }
                EnsureSleepLocation();
                return;
            }

            // ReadyCheck + event skip (every 0.5s)
            if (e.Ticks % 30 == 0)
            {
                HandleReadyCheck();
                SkipCurrentEvent();
            }

            // Auto-sleep when all players in bed (every 0.25s)
            if (e.Ticks % 15 == 0)
                CheckAndSleepWhenPlayersReady();

            // Friendship decay prevention (every second)
            if (e.IsOneSecond && Context.IsWorldReady)
                PreventFriendshipDecay();
        }

        private void OnTimeChanged(object? sender, TimeChangedEventArgs e)
        {
            if (!Context.IsMainPlayer || !Context.IsWorldReady) return;

            // Auto-sleep at 2AM regardless of player state
            if (Game1.timeOfDay >= AutoSleepTime && !_hasTriggeredSleep && !_isSleepInProgress)
            {
                Monitor.Log($"[HeadlessServer] Auto-sleep at {AutoSleepTime}.", LogLevel.Info);
                GoToBed();
                _hasTriggeredSleep = true;
            }
        }

        private void OnSaving(object? sender, SavingEventArgs e)
        {
            _shouldDrawFrame = true; // safety net — DayEnding should have already set this

            // DesyncKicker: cancel barrier timer (we're past it), start save timeout.
            _desyncBarrierCts?.Cancel();
            if (Context.IsMainPlayer && Game1.otherFarmers.Count > 0)
            {
                _desyncSaveCts?.Cancel();
                _desyncSaveCts = new System.Threading.CancellationTokenSource();
                var token = _desyncSaveCts.Token;
                System.Threading.Tasks.Task.Run(async () =>
                {
                    await System.Threading.Tasks.Task.Delay(60000);
                    if (token.IsCancellationRequested) return;
                    try
                    {
                        foreach (var farmer in Game1.otherFarmers.Values.ToArray())
                        {
                            var status = Game1.player.team.endOfNightStatus.GetStatusText(farmer.UniqueMultiplayerID);
                            if (status != "ready")
                            {
                                Monitor.Log($"[DesyncKicker] Kicking {farmer.Name} — not ready after 60s.", LogLevel.Warn);
                                Game1.server?.kick(farmer.UniqueMultiplayerID);
                            }
                        }
                    }
                    catch (Exception ex) { Monitor.Log($"[DesyncKicker] Save kick error: {ex.Message}", LogLevel.Warn); }
                });
            }

            if (!Context.IsMainPlayer) return;

            // Ensure host wakes in FarmHouse, not the Desert
            if (Game1.player.currentLocation?.Name != "FarmHouse")
            {
                var (bx, by) = GetBedCoords();
                Game1.player.lastSleepLocation.Value = "FarmHouse";
                Game1.player.lastSleepPoint.Value    = new Point(bx, by);
            }

            // Auto-close ShippingMenu if it's open during save
            if (Game1.activeClickableMenu is ShippingMenu)
            {
                try { Helper.Reflection.GetMethod(Game1.activeClickableMenu, "okClicked").Invoke(); }
                catch (Exception ex) { Monitor.Log($"ShippingMenu close failed: {ex.Message}", LogLevel.Warn); }
            }

            // Auto-dismiss any blocking DialogueBox during save
            if (Game1.activeClickableMenu is DialogueBox)
                Game1.activeClickableMenu.receiveLeftClick(10, 10);
        }

        private void OnDayEnding(object? sender, DayEndingEventArgs e)
        {
            // Re-enable drawing before the end-of-night save sequence.
            _shouldDrawFrame = true;
            GC.Collect();

            // DesyncKicker: if a player doesn't reach the sleep barrier within 20s, kick them.
            if (!Context.IsMainPlayer || Game1.otherFarmers.Count == 0) return;
            _desyncBarrierCts?.Cancel();
            _desyncBarrierCts = new System.Threading.CancellationTokenSource();
            var token = _desyncBarrierCts.Token;
            System.Threading.Tasks.Task.Run(async () =>
            {
                await System.Threading.Tasks.Task.Delay(20000);
                if (token.IsCancellationRequested) return;
                try
                {
                    var readyPlayers = Helper.Reflection
                        .GetMethod(Game1.newDaySync, "barrierPlayers")
                        .Invoke<System.Collections.Generic.HashSet<long>>("sleep");
                    foreach (var id in Game1.otherFarmers.Keys.ToArray())
                    {
                        if (!readyPlayers.Contains(id))
                        {
                            Monitor.Log($"[DesyncKicker] Kicking {id} — not past sleep barrier.", LogLevel.Warn);
                            Game1.server?.kick(id);
                        }
                    }
                }
                catch (Exception ex) { Monitor.Log($"[DesyncKicker] Barrier kick error: {ex.Message}", LogLevel.Warn); }
            });
        }

        private void OnSaved(object? sender, SavedEventArgs e)
        {
            _desyncSaveCts?.Cancel();
        }

        private void OnMenuChanged(object? sender, MenuChangedEventArgs e)
        {
            if (!Context.IsMainPlayer) return;

            // Reset ready-check flag when the dialog closes
            if (e.OldMenu?.GetType().Name == "ReadyCheckDialog")
                _handledReadyCheck = false;

            if (e.NewMenu == null) return;

            // ShippingMenu → auto-click OK
            if (e.NewMenu is ShippingMenu sm)
            {
                try { Helper.Reflection.GetMethod(sm, "okClicked").Invoke(); }
                catch (Exception ex) { Monitor.Log($"ShippingMenu: {ex.Message}", LogLevel.Warn); }
                return;
            }

            // LevelUpMenu → do NOT auto-handle (auto-clicking causes skill auto-level to 10)
            if (e.NewMenu is LevelUpMenu) return;

            // DialogueBox → auto-dismiss
            if (e.NewMenu is DialogueBox db)
            {
                try
                {
                    db.receiveKeyPress(Microsoft.Xna.Framework.Input.Keys.Escape);
                    Game1.activeClickableMenu = null;
                }
                catch { /* ignore */ }
                return;
            }

            // LetterViewerMenu → auto-close
            if (e.NewMenu is LetterViewerMenu lv)
            {
                try
                {
                    lv.receiveKeyPress(Microsoft.Xna.Framework.Input.Keys.Escape);
                    Game1.activeClickableMenu = null;
                }
                catch { /* ignore */ }
            }
        }

        private void OnPeerConnected(object? sender, PeerConnectedEventArgs e)
        {
            // Start guard window to prevent host being warped back to Farm on connect
            _guardWindowEnd = DateTime.Now.AddSeconds(GuardWindowSeconds);
            _needRehide     = true;
            _rehideTicks    = 1;
        }

        private void OnPeerDisconnected(object? sender, PeerDisconnectedEventArgs e)
        {
            Monitor.Log($"farmhand {e.Peer.PlayerID} disconnected", LogLevel.Info);
        }

        private void OnWarped(object? sender, WarpedEventArgs e)
        {
            if (!Context.IsMainPlayer || !e.IsLocalPlayer) return;
            if (_guardWindowEnd.HasValue && DateTime.Now < _guardWindowEnd.Value)
            {
                _needRehide  = true;
                _rehideTicks = 1;
            }
        }

        // ════════════════════════════════════════════════════════════════════
        // HOST BOT HELPERS
        // ════════════════════════════════════════════════════════════════════

        private void HideHost()
        {
            if (!Context.IsMainPlayer) return;
            Game1.warpFarmer("Desert", 0, 0, false);
        }

        private void HandleReadyCheck()
        {
            if (Game1.player?.team == null || _handledReadyCheck) return;
            try
            {
                string? name = GetActiveReadyCheckName();
                if (string.IsNullOrEmpty(name)) return;

                var method = Helper.Reflection.GetMethod(Game1.player.team, "SetLocalReady", required: false);
                if (method != null)
                {
                    method.Invoke(name, true);
                    _handledReadyCheck = true;
                    Monitor.Log($"[HostBot] ReadyCheck '{name}' accepted.", LogLevel.Info);
                }
                else
                {
                    TryClickReadyCheckDialog();
                }
            }
            catch (Exception ex) { Monitor.Log($"[HostBot] ReadyCheck: {ex.Message}", LogLevel.Trace); }
        }

        private void SkipCurrentEvent()
        {
            if (Game1.CurrentEvent == null || !Game1.CurrentEvent.skippable) return;

            string id  = Game1.CurrentEvent.id;
            bool same  = id == _lastSkippedEventId;
            bool onCd  = _lastSkipTime.HasValue &&
                         (DateTime.Now - _lastSkipTime.Value).TotalSeconds < SkipCooldownSeconds;
            if (same && onCd) return;

            Game1.CurrentEvent.skipEvent();
            _lastSkippedEventId = id;
            _lastSkipTime       = DateTime.Now;
            Monitor.Log($"[HostBot] Skipped event {id}.", LogLevel.Info);
        }

        private void CheckAndSleepWhenPlayersReady()
        {
            if (!Context.IsWorldReady || _hasTriggeredSleep || _isSleepInProgress) return;
            if (Game1.activeClickableMenu != null) return;

            var farmhands = Game1.getOnlineFarmers()
                .Where(f => f.UniqueMultiplayerID != Game1.player.UniqueMultiplayerID)
                .ToList();

            if (farmhands.Count == 0) return;
            if (!farmhands.All(f => f.isInBed.Value && f.timeWentToBed.Value > 0)) return;

            Monitor.Log($"[HostBot] All {farmhands.Count} player(s) in bed — sleeping.", LogLevel.Info);
            GoToBed();
            _hasTriggeredSleep = true;
        }

        private void GoToBed()
        {
            try
            {
                var (bx, by) = GetBedCoords();
                PreventSleepEvents();
                _isSleepInProgress = true;

                Game1.warpFarmer("FarmHouse", bx, by, false);

                // Call startSleep synchronously — same pattern as original AlwaysOnServer and AutoHideHost
                var startSleep = Helper.Reflection.GetMethod(Game1.currentLocation, "startSleep", required: false);
                if (startSleep != null)
                    startSleep.Invoke();
                else
                {
                    Game1.player.isInBed.Value       = true;
                    Game1.player.timeWentToBed.Value = Game1.timeOfDay;
                }

                // Set AFTER startSleep in case it overwrites (AutoHideHost v1.3.3 note)
                Game1.player.lastSleepLocation.Value = "FarmHouse";
                Game1.player.lastSleepPoint.Value    = new Point(bx, by);
                Game1.displayHUD = true;

                Monitor.Log($"[HostBot] Going to bed at FarmHouse ({bx},{by}).", LogLevel.Info);
            }
            catch (Exception ex)
            {
                Monitor.Log($"[HostBot] GoToBed error: {ex.Message}", LogLevel.Error);
            }
        }

        private void EnsureSleepLocation()
        {
            if (Game1.player.lastSleepLocation.Value == "FarmHouse") return;
            var (bx, by) = GetBedCoords();
            Game1.player.lastSleepLocation.Value = "FarmHouse";
            Game1.player.lastSleepPoint.Value    = new Point(bx, by);
        }

        private void PreventSleepEvents()
        {
            foreach (var id in new[] { "60367", "558291", "831125", "502261", "26", "27", "733330" })
                if (!Game1.player.eventsSeen.Contains(id))
                    Game1.player.eventsSeen.Add(id);
        }

        private static (int x, int y) GetBedCoords() => Game1.player.HouseUpgradeLevel switch
        {
            0 => (9,  9),
            1 => (21, 4),
            _ => (27, 13),
        };

        private string? GetActiveReadyCheckName()
        {
            try
            {
                // Use IDictionary to avoid a hard reference to the internal NetReady type
                var field = Helper.Reflection.GetField<System.Collections.IDictionary>(
                    Game1.player.team, "readyChecks", required: false);
                var dict = field?.GetValue();
                if (dict == null) return null;
                foreach (var key in dict.Keys)
                    return key?.ToString();
                return null;
            }
            catch { return null; }
        }

        private void TryClickReadyCheckDialog()
        {
            try
            {
                if (Game1.activeClickableMenu?.GetType().Name == "ReadyCheckDialog")
                    Game1.activeClickableMenu.receiveLeftClick(300, 300);
            }
            catch { /* ignore */ }
        }

        // ════════════════════════════════════════════════════════════════════
        // HEADLESS SERVER HELPERS
        // ════════════════════════════════════════════════════════════════════

        private void PreventFriendshipDecay()
        {
            if (!Context.IsWorldReady || !Context.IsMainPlayer) return;

            if (_prevFriendships.Count > 0)
            {
                foreach (string key in Game1.player.friendshipData.Keys)
                {
                    var f = Game1.player.friendshipData[key];
                    if (_prevFriendships.TryGetValue(key, out int prev) && prev > f.Points)
                        f.Points = prev;
                }
            }

            _prevFriendships.Clear();
            foreach (var pair in Game1.player.friendshipData.FieldDict)
                _prevFriendships[pair.Key] = pair.Value.Value.Points;
        }

        // ════════════════════════════════════════════════════════════════════
        // GAME LOADER
        // ════════════════════════════════════════════════════════════════════

        private void RunFarmStage()
        {
            if (Game1.activeClickableMenu is not TitleMenu menu)
            {
                _farmStageEnabled = false;
                _titleMenuCondition.Reset();
                return;
            }
            try
            {
                if (TryLoadExistingSave()) return;
                if (TryCreateNewFarm(menu)) return;

                Monitor.Log("[GameLoader] No saves and no new-farm.json — waiting.", LogLevel.Debug);
                _farmStageEnabled = false;
                _titleMenuCondition.Reset();
            }
            catch (Exception ex)
            {
                Monitor.Log($"[GameLoader] Error: {ex}", LogLevel.Error);
                _farmStageEnabled = false;
                _titleMenuCondition.Reset();
            }
        }

        private bool TryLoadExistingSave()
        {
            var savesPath = Constants.SavesPath;
            if (!Directory.Exists(savesPath)) return false;

            string? slotName   = null;
            var     requested  = Environment.GetEnvironmentVariable("SAVE_NAME");

            if (!string.IsNullOrWhiteSpace(requested))
            {
                slotName = Directory.GetDirectories(savesPath)
                    .Select(Path.GetFileName)
                    .FirstOrDefault(d => d != null &&
                        (d.Equals(requested, StringComparison.OrdinalIgnoreCase) ||
                         d.StartsWith(requested + "_", StringComparison.OrdinalIgnoreCase)));

                if (slotName == null)
                    Monitor.Log($"[GameLoader] SAVE_NAME='{requested}' not found — using most recent.", LogLevel.Warn);
            }

            slotName ??= Directory.GetDirectories(savesPath)
                .Where(Directory.Exists)
                .OrderByDescending(Directory.GetLastWriteTimeUtc)
                .Select(Path.GetFileName)
                .FirstOrDefault();

            if (slotName == null) return false;

            Monitor.Log($"[GameLoader] Loading '{slotName}' as co-op host.", LogLevel.Info);
            Game1.multiplayerMode = 2;
            SaveGame.Load(slotName);
            Game1.exitActiveMenu();
            return true;
        }

        private bool TryCreateNewFarm(TitleMenu menu)
        {
            if (!File.Exists(NewFarmConfigPath)) return false;

            NewFarmConfig? cfg;
            try
            {
                cfg = JsonSerializer.Deserialize<NewFarmConfig>(
                    File.ReadAllText(NewFarmConfigPath),
                    new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
            }
            catch (Exception ex)
            {
                Monitor.Log($"[GameLoader] Failed to parse new-farm.json: {ex.Message}", LogLevel.Error);
                File.Delete(NewFarmConfigPath);
                return false;
            }

            if (cfg == null)
            {
                Monitor.Log("[GameLoader] new-farm.json deserialised to null.", LogLevel.Warn);
                File.Delete(NewFarmConfigPath);
                return false;
            }

            Monitor.Log(
                $"[GameLoader] Creating farm '{cfg.FarmName}' " +
                $"(type={cfg.FarmType}, cabins={cfg.CabinCount}).",
                LogLevel.Info);
            _cfg = cfg;

            Game1.resetPlayer();
            Game1.player.Name                = cfg.FarmerName;
            Game1.player.displayName         = cfg.FarmerName;
            Game1.player.farmName.Value      = cfg.FarmName;
            Game1.player.favoriteThing.Value = string.IsNullOrWhiteSpace(cfg.FavoriteThing) ? "Farming" : cfg.FavoriteThing;
            Game1.player.isCustomized.Value  = true;
            Game1.player.whichPetType        = cfg.PetSpecies.Equals("dog", StringComparison.OrdinalIgnoreCase) ? "dog" : "cat";
            Game1.player.whichPetBreed       = cfg.PetBreed.ToString();
            Game1.startingCabins             = Math.Clamp(cfg.CabinCount, 1, 4);
            Game1.cabinsSeparate             = cfg.CabinLayout.Equals("separate", StringComparison.OrdinalIgnoreCase);

            Game1.player.team.useSeparateWallets.Value =
                cfg.MoneyStyle.Equals("separate", StringComparison.OrdinalIgnoreCase);

            Game1.player.difficultyModifier = cfg.ProfitMargin switch
            {
                "75%"  => 0.75f,
                "50%"  => 0.50f,
                "25%"  => 0.25f,
                _      => 1.00f,
            };

            Game1.whichFarm  = Math.Clamp(cfg.FarmType, 0, 6);
            Game1.bundleType = cfg.CommunityCenterBundles.Equals("remixed", StringComparison.OrdinalIgnoreCase)
                               ? Game1.BundleType.Remixed : Game1.BundleType.Default;

            Game1.game1.SetNewGameOption("MineChests",
                cfg.MineRewards.Equals("remixed", StringComparison.OrdinalIgnoreCase)
                    ? Game1.MineChestType.Remixed : Game1.MineChestType.Default);
            Game1.game1.SetNewGameOption("YearOneCompletable", cfg.GuaranteeYear1Completable);

            Game1.spawnMonstersAtNight = cfg.SpawnMonstersAtNight;
            Game1.game1.SetNewGameOption("SpawnMonstersAtNight", cfg.SpawnMonstersAtNight);

            if (cfg.RandomSeed.HasValue)
                Game1.startingGameSeed = cfg.RandomSeed;

            // multiplayerMode=2 BEFORE createdNewCharacter — required for proper co-op farm
            Game1.multiplayerMode = 2;
            menu.createdNewCharacter(true);

            File.Delete(NewFarmConfigPath);
            Monitor.Log("[GameLoader] Farm creation initiated. new-farm.json removed.", LogLevel.Info);
            return true;
        }

        private void HandleRuntimeDialogues()
        {
            if (Game1.activeClickableMenu == null || _cfg == null) return;

            // Cave choice (Demetrius ~Day 5 Year 1) and pet question (Marnie ~Day 3 Year 1)
            if (Game1.activeClickableMenu is DialogueBox db && db.isQuestion && db.responses != null)
            {
                int mushIdx = -1, batsIdx = -1, yesIdx = -1, noIdx = -1;
                for (int i = 0; i < db.responses.Count(); i++)
                {
                    var t = db.responses[i].responseText?.ToLowerInvariant() ?? "";
                    if (t == "mushrooms") mushIdx = i;
                    else if (t == "bats") batsIdx = i;
                    else if (t == "yes")  yesIdx  = i;
                    else if (t == "no")   noIdx   = i;
                }

                if (!_caveHandled && mushIdx >= 0 && batsIdx >= 0)
                {
                    db.selectedResponse = _cfg.MushroomsOrBats.Equals("bats", StringComparison.OrdinalIgnoreCase)
                        ? batsIdx : mushIdx;
                    db.receiveLeftClick(0, 0);
                    _caveHandled = true;
                    Monitor.Log($"[GameLoader] Cave choice: {_cfg.MushroomsOrBats}.", LogLevel.Info);
                }
                else if (!_petHandled && yesIdx >= 0 && noIdx >= 0)
                {
                    db.selectedResponse = _cfg.AcceptPet ? yesIdx : noIdx;
                    db.receiveLeftClick(0, 0);
                    if (!_cfg.AcceptPet) _petHandled = true;
                    Monitor.Log($"[GameLoader] Pet question answered (accept={_cfg.AcceptPet}).", LogLevel.Info);
                }
            }

            // NamingMenu — pet name entry after accepting pet
            if (!_petHandled && Game1.activeClickableMenu is NamingMenu nm)
            {
                try
                {
                    var textBox = _namingMenuTextBoxField.GetValue(nm) as TextBox;
                    if (textBox != null)
                    {
                        textBox.Text = string.IsNullOrWhiteSpace(_cfg.PetName) ? "Stella" : _cfg.PetName;
                        textBox.RecieveCommandInput('\r');
                        _petHandled = true;
                        Monitor.Log($"[GameLoader] Pet named '{_cfg.PetName}'.", LogLevel.Info);
                    }
                }
                catch (Exception ex)
                {
                    Monitor.Log($"[GameLoader] Pet naming failed: {ex.Message}", LogLevel.Warn);
                    _petHandled = true; // don't get stuck
                }
            }
        }

        // ════════════════════════════════════════════════════════════════════
        // PLAYER MANAGER — kick / ban / unban
        // ════════════════════════════════════════════════════════════════════

        private Farmer? FindFarmhand(string target)
        {
            // Match by name (case-insensitive) or numeric UniqueMultiplayerID string
            return Game1.getOnlineFarmers()
                .Where(f => f.UniqueMultiplayerID != Game1.player.UniqueMultiplayerID)
                .FirstOrDefault(f =>
                    f.Name.Equals(target, StringComparison.OrdinalIgnoreCase) ||
                    f.UniqueMultiplayerID.ToString() == target);
        }

        private void OnKickCommand(string cmd, string[] args)
        {
            if (!Context.IsWorldReady || !Context.IsMainPlayer)
            {
                Monitor.Log("Kick requires an active hosted session.", LogLevel.Warn);
                return;
            }
            if (args.Length == 0) { Monitor.Log("Usage: kick <name|id>", LogLevel.Info); return; }

            var target = string.Join(" ", args);
            var farmer = FindFarmhand(target);

            if (farmer == null)
            {
                Monitor.Log($"[PlayerManager] Kick: player '{target}' not found online.", LogLevel.Warn);
                return;
            }

            Game1.server.kick(farmer.UniqueMultiplayerID);
            Monitor.Log($"[PlayerManager] Kicked {farmer.Name} ({farmer.UniqueMultiplayerID}).", LogLevel.Info);
        }

        private void OnBanCommand(string cmd, string[] args)
        {
            if (!Context.IsWorldReady || !Context.IsMainPlayer)
            {
                Monitor.Log("Ban requires an active hosted session.", LogLevel.Warn);
                return;
            }
            if (args.Length == 0) { Monitor.Log("Usage: ban <name|id>", LogLevel.Info); return; }

            var target = string.Join(" ", args);
            var farmer = FindFarmhand(target);

            if (farmer == null)
            {
                Monitor.Log($"[PlayerManager] Ban: player '{target}' not found online.", LogLevel.Warn);
                return;
            }

            // Snapshot current bannedUsers keys BEFORE server.ban() so we can capture what it adds (the IP)
            var keysBefore = new HashSet<string>(Game1.bannedUsers.Keys);

            Game1.server.ban(farmer.UniqueMultiplayerID);

            // Also add name-based ban (server.ban only adds IP; name ban blocks at character selection)
            Game1.bannedUsers[farmer.Name] = farmer.UniqueMultiplayerID.ToString();

            // Capture all keys added by this ban: IP (from server.ban) + name (from above)
            var addedKeys = Game1.bannedUsers.Keys
                .Where(k => !keysBefore.Contains(k))
                .ToList();

            // Persist name→keys and id→name mappings so unban can remove ALL entries
            _bansByName[farmer.Name] = addedKeys;
            _idToName[farmer.UniqueMultiplayerID.ToString()] = farmer.Name;
            SaveBanMap();

            Monitor.Log($"[PlayerManager] Banned {farmer.Name} ({farmer.UniqueMultiplayerID}). Keys: [{string.Join(", ", addedKeys)}]", LogLevel.Info);
        }

        private void OnUnbanCommand(string cmd, string[] args)
        {
            if (args.Length == 0) { Monitor.Log("Usage: unban <name|id>", LogLevel.Info); return; }

            var target = string.Join(" ", args);

            // Resolve ID → name if needed
            var lookupName = _idToName.TryGetValue(target, out var mapped) ? mapped : target;

            // Case-insensitive name lookup in ban map
            var banEntry = _bansByName
                .FirstOrDefault(kv => kv.Key.Equals(lookupName, StringComparison.OrdinalIgnoreCase));

            if (banEntry.Value != null)
            {
                // Remove ALL keys for this ban (IP + name)
                foreach (var key in banEntry.Value)
                    Game1.bannedUsers.Remove(key);

                _bansByName.Remove(banEntry.Key);
                // Remove all id→name entries that pointed at this name
                foreach (var id in _idToName.Where(kv => kv.Value.Equals(banEntry.Key, StringComparison.OrdinalIgnoreCase)).Select(kv => kv.Key).ToList())
                    _idToName.Remove(id);
                SaveBanMap();

                Monitor.Log($"[PlayerManager] Unbanned '{banEntry.Key}'. Removed: [{string.Join(", ", banEntry.Value)}]", LogLevel.Info);
                return;
            }

            // Fallback: no map entry — search bannedUsers directly (catches manually-added bans)
            var fallback = Game1.bannedUsers
                .Where(kv => kv.Key.Equals(target, StringComparison.OrdinalIgnoreCase)
                          || (kv.Value != null && kv.Value.Equals(target, StringComparison.OrdinalIgnoreCase)))
                .Select(kv => kv.Key)
                .ToList();

            if (fallback.Count == 0)
            {
                var keys = Game1.bannedUsers.Count > 0
                    ? $"bannedUsers keys: [{string.Join(", ", Game1.bannedUsers.Keys.Take(10))}]"
                    : "bannedUsers is empty";
                Monitor.Log($"[PlayerManager] Unban: no banned player matching '{target}'. {keys}", LogLevel.Warn);
                return;
            }

            foreach (var key in fallback)
                Game1.bannedUsers.Remove(key);

            Monitor.Log($"[PlayerManager] Unbanned '{target}' (fallback). Removed: [{string.Join(", ", fallback)}]", LogLevel.Info);
        }

        // ════════════════════════════════════════════════════════════════════
        // CHAT BRIDGE
        // ════════════════════════════════════════════════════════════════════

        // Appends one NDJSON line to chat.log so the web panel can poll it.
        private void AppendChatLog(string from, string message, bool isHost, string? to = null)
        {
            try
            {
                var entry = new { ts = DateTimeOffset.UtcNow.ToUnixTimeSeconds(), from, message, isHost, to };
                File.AppendAllText(ChatLogPath, JsonSerializer.Serialize(entry, _chatJsonOpts) + "\n");
            }
            catch { }
        }

        // Fired for every player message. Host's own messages are NOT raised here
        // (SMAPI raises this only for remote players), so host messages are logged
        // explicitly in OnSayCommand / OnTellCommand.
        // sourceFarmer == 0 for system/server messages (e.g. join/leave notifications).
        // chatKind enum (from SDV ChatBox):
        //   0 = ChatMessage, 1 = ErrorMessage, 2 = UserNotification, 3 = PrivateMessage
        private const int ChatKindPrivate = 3;

        public static void ReceiveChatMessage_Postfix(long sourceFarmer, int chatKind, string message)
        {
            try
            {
                // Detect join messages: "PlayerName (192.168.0.1) has joined."
                // These are system messages with sourceFarmer == 0 that contain the player IP.
                if (sourceFarmer == 0)
                {
                    var joinMatch = Regex.Match(
                        message, @"^(.+?) \((\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\)");
                    if (joinMatch.Success)
                        _instance?.OnPlayerJoinDetected(joinMatch.Groups[1].Value, joinMatch.Groups[2].Value);
                }

                var farmer = Game1.getFarmerMaybeOffline(sourceFarmer);
                string name = farmer?.Name ?? $"#{sourceFarmer}";

                // Private messages received here are always directed to the host (server).
                // Set `to` so the web panel can route them to the correct DM tab.
                string? to = (chatKind == ChatKindPrivate && sourceFarmer != 0)
                    ? Game1.player?.Name
                    : null;

                _instance?.AppendChatLog(name, message, false, to);
            }
            catch { }
        }

        // ════════════════════════════════════════════════════════════════════
        // SECURITY — blocklist / allowlist enforcement
        // ════════════════════════════════════════════════════════════════════

        private void LoadNameIpMap()
        {
            try
            {
                if (File.Exists(NameIpMapPath))
                    _nameIpMap = JsonSerializer.Deserialize<Dictionary<string, string>>(
                        File.ReadAllText(NameIpMapPath)) ?? new();
            }
            catch { _nameIpMap = new(); }
        }

        private void SaveNameIpMap()
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(NameIpMapPath)!);
                File.WriteAllText(NameIpMapPath, JsonSerializer.Serialize(_nameIpMap));
            }
            catch { }
        }

        private SecurityConfig LoadSecurityConfig()
        {
            if (_secConfig != null && (DateTime.Now - _secConfigLoadTime).TotalSeconds < SecCacheTtlSeconds)
                return _secConfig;
            try
            {
                _secConfig = File.Exists(SecurityConfigPath)
                    ? JsonSerializer.Deserialize<SecurityConfig>(File.ReadAllText(SecurityConfigPath), _chatJsonOpts) ?? new()
                    : new();
            }
            catch { _secConfig = new(); }
            _secConfigLoadTime = DateTime.Now;
            return _secConfig;
        }

        private void OnPlayerJoinDetected(string name, string ip)
        {
            // Always update name→IP tracking so the web panel can show it.
            _nameIpMap[name] = ip;
            SaveNameIpMap();

            var sec = LoadSecurityConfig();

            if (sec.Mode == "allow")
            {
                bool allowed = sec.Allowlist.Any(e =>
                    (e.Type == "name" && e.Value.Equals(name, StringComparison.OrdinalIgnoreCase)) ||
                    (e.Type == "ip"   && e.Value == ip));
                if (!allowed)
                {
                    Monitor.Log($"[Security] '{name}' ({ip}) not in allow list — kicking.", LogLevel.Info);
                    KickPlayerByName(name);
                }
                return;
            }

            // Block mode (default)
            bool blocked = sec.Blocklist.Any(e =>
                (e.Type == "name" && e.Value.Equals(name, StringComparison.OrdinalIgnoreCase)) ||
                (e.Type == "ip"   && e.Value == ip));

            // IP-alias check: if this IP was previously used by a blocked name, block them too.
            if (!blocked)
            {
                var blockedNames = sec.Blocklist
                    .Where(e => e.Type == "name")
                    .Select(e => e.Value)
                    .ToHashSet(StringComparer.OrdinalIgnoreCase);
                blocked = _nameIpMap.Any(kv =>
                    kv.Value == ip &&
                    blockedNames.Contains(kv.Key) &&
                    !kv.Key.Equals(name, StringComparison.OrdinalIgnoreCase));
            }

            if (blocked)
            {
                Monitor.Log($"[Security] '{name}' ({ip}) matched block list — kicking.", LogLevel.Info);
                KickPlayerByName(name);
            }
        }

        private void KickPlayerByName(string name)
        {
            foreach (var farmer in Game1.getAllFarmers())
            {
                if (!farmer.IsMainPlayer && farmer.Name.Equals(name, StringComparison.OrdinalIgnoreCase))
                {
                    Monitor.Log($"[Security] Kicking '{farmer.Name}' (ID: {farmer.UniqueMultiplayerID}).", LogLevel.Info);
                    Game1.server?.kick(farmer.UniqueMultiplayerID);
                    return;
                }
            }
            Monitor.Log($"[Security] Could not find '{name}' in farmer list to kick.", LogLevel.Warn);
        }

        private void OnSayCommand(string cmd, string[] args)
        {
            if (args.Length == 0) { Monitor.Log("Usage: say <message>", LogLevel.Info); return; }
            if (!Context.IsWorldReady) { Monitor.Log("No active game session.", LogLevel.Warn); return; }
            if (Game1.chatBox == null) { Monitor.Log("[ChatBridge] chatBox not ready.", LogLevel.Warn); return; }

            string message = string.Join(" ", args);
            Game1.chatBox.textBoxEnter(message);
            AppendChatLog(Game1.player.Name, message, true);
        }

        private void OnTellCommand(string cmd, string[] args)
        {
            if (args.Length < 2) { Monitor.Log("Usage: tell <player> <message>", LogLevel.Info); return; }
            if (!Context.IsWorldReady) { Monitor.Log("No active game session.", LogLevel.Warn); return; }
            if (Game1.chatBox == null) { Monitor.Log("[ChatBridge] chatBox not ready.", LogLevel.Warn); return; }

            string targetName = args[0];
            string message    = string.Join(" ", args.Skip(1));

            // Attempt a private whisper via SDV's /message chat command.
            Game1.chatBox.textBoxEnter($"/message {targetName} {message}");
            AppendChatLog(Game1.player.Name, message, true, targetName);
        }

        // ════════════════════════════════════════════════════════════════════
        // PER-FARMHAND ADMIN COMMANDS
        // ════════════════════════════════════════════════════════════════════

        private void OnSetHealthCommand(string cmd, string[] args)
        {
            if (args.Length < 2) { Monitor.Log("Usage: stardrop_sethealth <name> <amount>", LogLevel.Info); return; }
            if (!Context.IsWorldReady) { Monitor.Log("No active game session.", LogLevel.Warn); return; }
            var farmer = FindFarmhand(args[0]);
            if (farmer == null) { Monitor.Log($"[Admin] Farmhand '{args[0]}' not found.", LogLevel.Warn); return; }
            if (!int.TryParse(args[1], out int amount)) { Monitor.Log("[Admin] Invalid amount.", LogLevel.Warn); return; }
            farmer.health = Math.Clamp(amount, 0, farmer.maxHealth);
            Monitor.Log($"[Admin] Set {farmer.Name} health to {farmer.health}.", LogLevel.Info);
        }

        private void OnSetStaminaCommand(string cmd, string[] args)
        {
            if (args.Length < 2) { Monitor.Log("Usage: stardrop_setstamina <name> <amount>", LogLevel.Info); return; }
            if (!Context.IsWorldReady) { Monitor.Log("No active game session.", LogLevel.Warn); return; }
            var farmer = FindFarmhand(args[0]);
            if (farmer == null) { Monitor.Log($"[Admin] Farmhand '{args[0]}' not found.", LogLevel.Warn); return; }
            if (!float.TryParse(args[1], out float amount)) { Monitor.Log("[Admin] Invalid amount.", LogLevel.Warn); return; }
            farmer.stamina = Math.Clamp(amount, 0f, farmer.maxStamina.Value);
            Monitor.Log($"[Admin] Set {farmer.Name} stamina to {farmer.stamina}.", LogLevel.Info);
        }

        private void OnGiveItemCommand(string cmd, string[] args)
        {
            if (args.Length < 2) { Monitor.Log("Usage: stardrop_give <name> <itemId> [count]", LogLevel.Info); return; }
            if (!Context.IsWorldReady) { Monitor.Log("No active game session.", LogLevel.Warn); return; }
            var farmer = FindFarmhand(args[0]);
            if (farmer == null) { Monitor.Log($"[Admin] Farmhand '{args[0]}' not found.", LogLevel.Warn); return; }
            string itemId = args[1];
            int count = args.Length >= 3 && int.TryParse(args[2], out int c) ? Math.Max(1, c) : 1;
            try
            {
                var item = ItemRegistry.Create(itemId, count);
                if (item == null) { Monitor.Log($"[Admin] Unknown item ID: {itemId}.", LogLevel.Warn); return; }
                farmer.addItemByMenuIfNecessary(item);
                Monitor.Log($"[Admin] Gave {count}x {item.DisplayName} to {farmer.Name}.", LogLevel.Info);
            }
            catch (Exception ex) { Monitor.Log($"[Admin] Give item failed: {ex.Message}", LogLevel.Warn); }
        }

        private void OnEmoteCommand(string cmd, string[] args)
        {
            if (args.Length < 2) { Monitor.Log("Usage: stardrop_emote <name> <emoteId>", LogLevel.Info); return; }
            if (!Context.IsWorldReady) { Monitor.Log("No active game session.", LogLevel.Warn); return; }
            var farmer = FindFarmhand(args[0]);
            if (farmer == null) { Monitor.Log($"[Admin] Farmhand '{args[0]}' not found.", LogLevel.Warn); return; }
            if (!int.TryParse(args[1], out int emoteId)) { Monitor.Log("[Admin] emoteId must be an integer.", LogLevel.Warn); return; }
            farmer.doEmote(emoteId);
            Monitor.Log($"[Admin] Played emote {emoteId} for {farmer.Name}.", LogLevel.Info);
        }

        // ════════════════════════════════════════════════════════════════════
        // CROPSAVER — crops don't die when cabin owner is offline
        // ════════════════════════════════════════════════════════════════════

        // Prefix on Crop.Kill(). Returns false (skip kill) if the plot's
        // cabin owner is currently offline.
        // Crop.Kill(HoeDirt soil) — soil.currentLocation tells us where the crop lives.
        public static bool CropKill_Prefix(StardewValley.TerrainFeatures.HoeDirt soil)
        {
            try
            {
                if (!Context.IsMainPlayer || !Context.IsWorldReady) return true;
                if (soil?.currentLocation is Cabin cabin)
                {
                    long ownerId = cabin.getFarmhand()?.UniqueMultiplayerID ?? 0L;
                    if (ownerId != 0L && !Game1.otherFarmers.ContainsKey(ownerId))
                        return false; // owner offline — spare the crop
                }
            }
            catch { /* never block the kill on error */ }
            return true;
        }

        // ════════════════════════════════════════════════════════════════════
        // HEADLESS RENDERING PATCHES
        // ════════════════════════════════════════════════════════════════════

        // Prefix on Game.BeginDraw(). Calls SuppressDraw() so MonoGame skips frame
        // presentation entirely — cheaper than patching Game1._draw() which only skips
        // the Stardew draw code but still lets MonoGame clear/present the buffer.
        // Must be public for Harmony to find it via nameof().
        public static bool BeginDraw_Prefix(Game __instance)
        {
            if (_shouldDrawFrame) return true;
            __instance.SuppressDraw();
            return false;
        }

        // Generic prefix — returns false to skip the patched method entirely.
        // Used for sound, input, and ambient effect methods.
        public static bool Disable_Prefix() => false;

        // ════════════════════════════════════════════════════════════════════
        // WAIT CONDITION HELPER
        // ════════════════════════════════════════════════════════════════════

        private sealed class WaitCondition
        {
            private readonly Func<bool> _condition;
            private readonly int        _initial;
            private int                 _counter;

            public WaitCondition(Func<bool> condition, int initial)
            { _condition = condition; _initial = initial; _counter = initial; }

            /// <summary>Returns true once the condition has been met for
            /// <c>initial</c> consecutive ticks.</summary>
            public bool IsMet()
            {
                if (_counter <= 0 && _condition()) return true;
                _counter--;
                return false;
            }

            public void Reset() => _counter = _initial;
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    // SECURITY CONFIG — matches security.json written by web panel
    // ════════════════════════════════════════════════════════════════════════

    internal sealed class SecurityConfig
    {
        [JsonPropertyName("mode")]
        public string Mode { get; set; } = "block";

        [JsonPropertyName("blocklist")]
        public List<SecurityEntry> Blocklist { get; set; } = new();

        [JsonPropertyName("allowlist")]
        public List<SecurityEntry> Allowlist { get; set; } = new();
    }

    internal sealed class SecurityEntry
    {
        [JsonPropertyName("type")]
        public string Type { get; set; } = "name";

        [JsonPropertyName("value")]
        public string Value { get; set; } = "";
    }

    // ════════════════════════════════════════════════════════════════════════
    // NEW FARM CONFIG — matches wizard.js submitNewFarm() JSON output
    // ════════════════════════════════════════════════════════════════════════

    internal sealed class NewFarmConfig
    {
        public string FarmName                  { get; set; } = "Stardrop Farm";
        public string FarmerName                { get; set; } = "Host";
        public string FavoriteThing             { get; set; } = "Farming";
        public int    FarmType                  { get; set; } = 0;
        public int    CabinCount                { get; set; } = 1;
        public string CabinLayout               { get; set; } = "separate";
        public string MoneyStyle                { get; set; } = "shared";
        public string ProfitMargin              { get; set; } = "normal";
        public string CommunityCenterBundles    { get; set; } = "normal";
        public bool   GuaranteeYear1Completable { get; set; } = false;
        public string MineRewards               { get; set; } = "normal";
        public bool   SpawnMonstersAtNight      { get; set; } = false;
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public ulong? RandomSeed                { get; set; } = null;
        public bool   AcceptPet                 { get; set; } = true;
        public string PetSpecies                { get; set; } = "cat";
        public int    PetBreed                  { get; set; } = 0;
        public string PetName                   { get; set; } = "Stella";
        public string MushroomsOrBats           { get; set; } = "mushrooms";
        public bool   PurchaseJojaMembership    { get; set; } = false;
        public string MoveBuildPermission       { get; set; } = "off";
    }
}
