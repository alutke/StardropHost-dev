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
using Netcode;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;
using StardewValley.Buildings;
using StardewValley.Locations;
using StardewValley.Menus;
using StardewValley.Network;
using StardewValley.Objects;
using xTile.Tiles;

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

        // ── Cabin Stack ──────────────────────────────────────────────────────
        private static readonly Point   HiddenCabinLocation    = new Point(-20, -20);
        private static readonly Vector2 FallbackCabinVisiblePos = new Vector2(50, 14);
        private const string            CabinCountPath          = "/home/steam/web-panel/data/cabin-count.json";
        private const string            CabinPositionsPath      = "/home/steam/web-panel/data/cabin-positions.json";
        private const string            CabinLevelsPath         = "/home/steam/web-panel/data/cabin-upgrade-levels.json";
        private static bool             _useCabinStack          = false;
        // playerId (string) → visible tile position chosen by that farmhand
        private Dictionary<string, Vector2> _cabinPositions = new();
        // Tracked from /moveBuildingPermission chat command: "off", "owned", "on"
        private static string           _buildingMovePermission = "on";

        private static readonly Dictionary<string, string> CabinTypeAliases = new(StringComparer.OrdinalIgnoreCase)
        {
            ["stone"]    = "Stone Cabin",
            ["plank"]    = "Plank Cabin",
            ["log"]      = "Log Cabin",
            ["neighbor"] = "Neighbor Cabin",
            ["rustic"]   = "Rustic Cabin",
            ["beach"]    = "Beach Cabin",
            ["trailer"]  = "Trailer Cabin",
        };

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
        private CropSaver? _cropSaver = null;
        private int        _playerLimit = 17;
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

        // ── Pending delayed kicks ────────────────────────────────────────────
        private readonly List<(long peerId, long kickAtMs)> _pendingKicks = new();

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

            // Cabin Stack — conditionally disable vanilla cabin placement when stacking is active
            try
            {
                harmony.Patch(
                    AccessTools.Method(typeof(GameLocation), nameof(GameLocation.BuildStartingCabins)),
                    prefix: new HarmonyMethod(typeof(ModEntry), nameof(BuildStartingCabins_Prefix)));
            }
            catch (Exception ex) { Monitor.Log($"[CabinStack] BuildStartingCabins patch failed: {ex.Message}", LogLevel.Warn); }

            // Cabin Stack — intercept LocationIntroduction to relocate cabin client-side
            try
            {
                harmony.Patch(
                    AccessTools.Method(typeof(GameServer), "sendMessage", new[] { typeof(long), typeof(OutgoingMessage) }),
                    prefix: new HarmonyMethod(typeof(ModEntry), nameof(SendMessage_Prefix)));
            }
            catch (Exception ex) { Monitor.Log($"[CabinStack] sendMessage patch failed: {ex.Message}", LogLevel.Warn); }

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
            helper.ConsoleCommands.Add("stardrop_sethealth",    "Set a farmhand's health. Usage: stardrop_sethealth <name> <amount>",        OnSetHealthCommand);
            helper.ConsoleCommands.Add("stardrop_setmaxhealth","Set a farmhand's max health. Usage: stardrop_setmaxhealth <name> <amount>",  OnSetMaxHealthCommand);
            helper.ConsoleCommands.Add("stardrop_setstamina",  "Set a farmhand's stamina. Usage: stardrop_setstamina <name> <amount>",       OnSetStaminaCommand);
            helper.ConsoleCommands.Add("stardrop_setmaxstamina","Set a farmhand's max stamina. Usage: stardrop_setmaxstamina <name> <amount>",OnSetMaxStaminaCommand);
            helper.ConsoleCommands.Add("stardrop_setmoney",    "Set a farmhand's money. Usage: stardrop_setmoney <name> <amount>",            OnSetMoneyCommand);
            helper.ConsoleCommands.Add("stardrop_give",        "Give item to a farmhand. Usage: stardrop_give <name> <itemId> <count>",       OnGiveItemCommand);
            helper.ConsoleCommands.Add("stardrop_emote",          "Play emote for a farmhand. Usage: stardrop_emote <name> <emoteId>",                  OnEmoteCommand);
            helper.ConsoleCommands.Add("stardrop_deletefarmhand", "Delete an offline farmhand and free their cabin. Usage: stardrop_deletefarmhand <name>", OnDeleteFarmhandCommand);
            helper.ConsoleCommands.Add("stardrop_upgradecabin",   "Set a farmhand's cabin upgrade level (0-3). Usage: stardrop_upgradecabin <name> <level>", OnUpgradeCabinCommand);
            helper.ConsoleCommands.Add("stardrop_cropsaver",      "Toggle CropSaver on or off. Usage: stardrop_cropsaver <on|off>",                        OnCropSaverCommand);

            // Player limit — read once at startup from env, enforced every tick in OnUpdateTicked
            var envLimit = Environment.GetEnvironmentVariable("PLAYER_LIMIT");
            if (!string.IsNullOrEmpty(envLimit) && int.TryParse(envLimit, out int parsedLimit) && parsedLimit > 0)
                _playerLimit = parsedLimit;
            Monitor.Log($"[PlayerLimit] Configured to {_playerLimit} ({_playerLimit - 1} farmhands + host).", LogLevel.Info);

            // CropSaver — reads CROP_SAVER_ENABLED env var (default: false)
            var cropSaverEnabled = (Environment.GetEnvironmentVariable("CROP_SAVER_ENABLED") ?? "false")
                                       .Equals("true", StringComparison.OrdinalIgnoreCase);
            _cropSaver = new CropSaver(Monitor, helper, harmony, cropSaverEnabled);

            Monitor.Log("StardropHost.Dependencies loaded.", LogLevel.Info);
        }

        // ════════════════════════════════════════════════════════════════════
        // SMAPI EVENTS
        // ════════════════════════════════════════════════════════════════════

        private void OnSaveLoaded(object? sender, SaveLoadedEventArgs e)
        {
            LoadBanMap();

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

                // Cabin Stack — restore mode and ensure correct cabin count
                var (cabinTarget, cabinStack) = ReadCabinConfigFromFile();
                _useCabinStack = cabinStack;
                if (cabinTarget > 0 && _useCabinStack)
                    EnsureCabinCount(cabinTarget);
                LoadCabinPositions();
                WriteCabinLevels();
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

                // Player limit — synced every tick so the game can never revert it.
                // All three fields required: playerLimit gates connections, Current/HighestPlayerLimit
                // are net fields synced to clients. Without every-tick sync, SaveLoaded sets them
                // but the game overwrites them from startup_preferences on the next update.
                if (Game1.Multiplayer.playerLimit != _playerLimit)
                    Game1.Multiplayer.playerLimit = _playerLimit;
                if (Game1.netWorldState.Value.CurrentPlayerLimit != _playerLimit)
                    Game1.netWorldState.Value.CurrentPlayerLimit = _playerLimit;
                if (Game1.netWorldState.Value.HighestPlayerLimit != _playerLimit)
                    Game1.netWorldState.Value.HighestPlayerLimit = _playerLimit;
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

            // Delayed kicks (upgrade / cabin move notifications)
            if (_pendingKicks.Count > 0 && Context.IsWorldReady)
            {
                var now = Environment.TickCount64;
                for (int i = _pendingKicks.Count - 1; i >= 0; i--)
                {
                    if (now >= _pendingKicks[i].kickAtMs)
                    {
                        Game1.server?.kick(_pendingKicks[i].peerId);
                        _pendingKicks.RemoveAt(i);
                    }
                }
            }

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
            Game1.startingCabins             = Math.Clamp(cfg.CabinCount, 1, 16);
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

            // Set cabin stack mode BEFORE createdNewCharacter — BuildStartingCabins_Prefix reads this flag
            _useCabinStack = cfg.CabinStack || cfg.CabinCount > 7;

            // multiplayerMode=2 BEFORE createdNewCharacter — required for proper co-op farm
            Game1.multiplayerMode = 2;
            menu.createdNewCharacter(true);

            // Persist cabin count + stack mode so they survive restart
            try
            {
                File.WriteAllText(CabinCountPath, JsonSerializer.Serialize(
                    new { cabinCount = cfg.CabinCount, cabinStack = _useCabinStack }));
            }
            catch { }

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
                // Track /moveBuildingPermission changes — host only
                if (sourceFarmer == Game1.player?.UniqueMultiplayerID)
                    TryUpdateBuildingMovePermission(message);

                // Skip host's own messages — already logged by OnSayCommand / OnTellCommand.
                if (sourceFarmer != 0 && sourceFarmer == Game1.player?.UniqueMultiplayerID) return;

                // Cabin position command — farmhands only (sourceFarmer != 0 and not host)
                if (sourceFarmer != 0 && sourceFarmer != Game1.player?.UniqueMultiplayerID)
                {
                    var parts = message.Trim().Split(' ', 2, StringSplitOptions.RemoveEmptyEntries);
                    if (parts.Length > 0 && parts[0].Equals("move_cabin", StringComparison.OrdinalIgnoreCase))
                    {
                        string? typeArg = parts.Length > 1 ? parts[1].Trim() : null;
                        _instance?.HandleCabinCommand(sourceFarmer, typeArg);
                        return;
                    }
                }

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
            TryUpdateBuildingMovePermission(message);
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

        private void OnSetMaxHealthCommand(string cmd, string[] args)
        {
            if (args.Length < 2) { Monitor.Log("Usage: stardrop_setmaxhealth <name> <amount>", LogLevel.Info); return; }
            if (!Context.IsWorldReady) { Monitor.Log("No active game session.", LogLevel.Warn); return; }
            var farmer = FindFarmhand(args[0]);
            if (farmer == null) { Monitor.Log($"[Admin] Farmhand '{args[0]}' not found.", LogLevel.Warn); return; }
            if (!int.TryParse(args[1], out int amount) || amount < 1) { Monitor.Log("[Admin] Invalid amount.", LogLevel.Warn); return; }
            farmer.maxHealth = amount;
            farmer.health = Math.Clamp(farmer.health, 0, farmer.maxHealth);
            Monitor.Log($"[Admin] Set {farmer.Name} max health to {farmer.maxHealth}.", LogLevel.Info);
        }

        private void OnSetMaxStaminaCommand(string cmd, string[] args)
        {
            if (args.Length < 2) { Monitor.Log("Usage: stardrop_setmaxstamina <name> <amount>", LogLevel.Info); return; }
            if (!Context.IsWorldReady) { Monitor.Log("No active game session.", LogLevel.Warn); return; }
            var farmer = FindFarmhand(args[0]);
            if (farmer == null) { Monitor.Log($"[Admin] Farmhand '{args[0]}' not found.", LogLevel.Warn); return; }
            if (!int.TryParse(args[1], out int amount) || amount < 1) { Monitor.Log("[Admin] Invalid amount.", LogLevel.Warn); return; }
            farmer.maxStamina.Value = amount;
            farmer.stamina = Math.Clamp(farmer.stamina, 0f, farmer.maxStamina.Value);
            Monitor.Log($"[Admin] Set {farmer.Name} max stamina to {farmer.maxStamina.Value}.", LogLevel.Info);
        }

        private void OnSetMoneyCommand(string cmd, string[] args)
        {
            if (args.Length < 2) { Monitor.Log("Usage: stardrop_setmoney <name> <amount>", LogLevel.Info); return; }
            if (!Context.IsWorldReady) { Monitor.Log("No active game session.", LogLevel.Warn); return; }
            var farmer = FindFarmhand(args[0]);
            if (farmer == null) { Monitor.Log($"[Admin] Farmhand '{args[0]}' not found.", LogLevel.Warn); return; }
            if (!int.TryParse(args[1], out int amount) || amount < 0) { Monitor.Log("[Admin] Invalid amount.", LogLevel.Warn); return; }
            farmer.Money = amount;
            Monitor.Log($"[Admin] Set {farmer.Name} money to {farmer.Money}.", LogLevel.Info);
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

        private void OnDeleteFarmhandCommand(string cmd, string[] args)
        {
            if (!Context.IsWorldReady || !Context.IsMainPlayer)
            {
                Monitor.Log("[Admin] stardrop_deletefarmhand requires an active hosted session.", LogLevel.Warn);
                return;
            }
            if (args.Length == 0) { Monitor.Log("Usage: stardrop_deletefarmhand <name>", LogLevel.Info); return; }

            var target = string.Join(" ", args);

            // Search all farmhands including offline ones
            var farmer = Game1.getAllFarmhands()
                .FirstOrDefault(f => f.Name.Equals(target, StringComparison.OrdinalIgnoreCase));

            if (farmer == null)
            {
                Monitor.Log($"[Admin] Farmhand '{target}' not found.", LogLevel.Warn);
                return;
            }

            // Refuse deletion if player is currently connected
            if (Game1.getOnlineFarmers().Any(f => f.UniqueMultiplayerID == farmer.UniqueMultiplayerID))
            {
                Monitor.Log($"[Admin] Cannot delete '{target}' — they are currently online.", LogLevel.Warn);
                return;
            }

            var farm = Game1.getFarm();
            var farmerId = farmer.UniqueMultiplayerID;

            // Find the cabin building whose indoor owner matches
            var cabinBuilding = farm.buildings
                .FirstOrDefault(b => b.indoors.Value is Cabin c && c.owner.UniqueMultiplayerID == farmerId);

            if (cabinBuilding != null)
            {
                (cabinBuilding.indoors.Value as Cabin)!.DeleteFarmhand();
                Monitor.Log($"[Admin] Deleted farmhand '{farmer.Name}' — cabin slot kept as unclaimed.", LogLevel.Info);
            }
            else
            {
                // Fallback: remove directly from farmhandData if cabin is missing
                Game1.netWorldState.Value.farmhandData.Remove(farmerId);
                Monitor.Log($"[Admin] Deleted farmhand '{farmer.Name}' from farmhandData (no cabin found).", LogLevel.Warn);
            }
        }

        private void OnUpgradeCabinCommand(string cmd, string[] args)
        {
            if (!Context.IsWorldReady || !Context.IsMainPlayer)
            {
                Monitor.Log("[Admin] stardrop_upgradecabin requires an active hosted session.", LogLevel.Warn);
                return;
            }
            if (args.Length < 2) { Monitor.Log("Usage: stardrop_upgradecabin <name> <targetLevel 1-3>", LogLevel.Info); return; }

            if (!int.TryParse(args[args.Length - 1], out int targetLevel) || targetLevel < 1 || targetLevel > 3)
            {
                Monitor.Log("[Admin] Target level must be 1, 2, or 3.", LogLevel.Warn);
                return;
            }

            var targetName = string.Join(" ", args.Take(args.Length - 1));
            var farmer = Game1.getAllFarmhands()
                .FirstOrDefault(f => f.Name.Equals(targetName, StringComparison.OrdinalIgnoreCase));

            if (farmer == null)
            {
                Monitor.Log($"[Admin] Farmhand '{targetName}' not found.", LogLevel.Warn);
                return;
            }

            int current = farmer.houseUpgradeLevel.Value;
            if (current >= 3)
            {
                Monitor.Log($"[Admin] '{farmer.Name}' cabin is already at max upgrade level (3).", LogLevel.Warn);
                return;
            }
            if (targetLevel <= current)
            {
                Monitor.Log($"[Admin] Target level {targetLevel} is not higher than current level {current}.", LogLevel.Warn);
                return;
            }

            // Block if player is currently inside their cabin
            var farm = Game1.getFarm();
            var cabinBuilding = farm.buildings
                .FirstOrDefault(b => (b.GetIndoors() as Cabin)?.owner?.UniqueMultiplayerID == farmer.UniqueMultiplayerID);
            if (cabinBuilding != null)
            {
                var cabinInterior = cabinBuilding.GetIndoors();
                if (cabinInterior != null &&
                    farmer.currentLocation?.NameOrUniqueName == cabinInterior.NameOrUniqueName)
                {
                    Monitor.Log($"[Admin] Cannot upgrade '{farmer.Name}' — they are currently inside their cabin.", LogLevel.Warn);
                    Game1.chatBox?.textBoxEnter(
                        $"/message {farmer.Name} Cabin upgrade requested, but you must leave your cabin before it can be upgraded. Please step outside and ask the host to try again.");
                    return;
                }
            }

            // Apply upgrades sequentially from current+1 up to targetLevel
            for (int l = current + 1; l <= targetLevel; l++)
                farmer.houseUpgradeLevel.Value = l;

            WriteCabinLevels();
            Monitor.Log($"[Admin] Upgraded '{farmer.Name}' cabin from level {current} to {targetLevel}.", LogLevel.Info);

            var levelNames = new[] { "Basic", "Kitchen", "Kids Room", "Full Upgrade" };
            SchedulePrivateMessageAndKick(farmer.UniqueMultiplayerID, farmer.Name,
                $"Your cabin has been upgraded to level {targetLevel} ({levelNames[targetLevel]}). " +
                $"You will be disconnected in 10 seconds — log back in to see the changes.");
        }

        private void OnCropSaverCommand(string cmd, string[] args)
        {
            if (args.Length == 0) { Monitor.Log($"CropSaver is currently {(CropSaver.Enabled ? "ON" : "OFF")}. Usage: stardrop_cropsaver <on|off>", LogLevel.Info); return; }
            bool enable = args[0].Equals("on", StringComparison.OrdinalIgnoreCase);
            CropSaver.Enabled = enable;
            Monitor.Log($"[CropSaver] {(enable ? "Enabled" : "Disabled")} at runtime.", LogLevel.Info);
        }

        /// <summary>
        /// Parses /moveBuildingPermission (and aliases mbp, movePermission) and updates
        /// _buildingMovePermission so HandleCabinCommand can gate move_cabin correctly.
        /// </summary>
        private static void TryUpdateBuildingMovePermission(string message)
        {
            var trimmed = message.Trim();
            // Match: /moveBuildingPermission off|owned|on  (and aliases mbp, movePermission)
            var match = Regex.Match(trimmed,
                @"^/(?:moveBuildingPermission|mbp|movePermission)\s+(off|owned|on)\b",
                RegexOptions.IgnoreCase);
            if (!match.Success) return;
            _buildingMovePermission = match.Groups[1].Value.ToLower();
        }

        // ════════════════════════════════════════════════════════════════════
        // CABIN STACK
        // ════════════════════════════════════════════════════════════════════

        private void LoadCabinPositions()
        {
            try
            {
                if (File.Exists(CabinPositionsPath))
                {
                    var raw = JsonSerializer.Deserialize<Dictionary<string, float[]>>(
                        File.ReadAllText(CabinPositionsPath)) ?? new();
                    _cabinPositions = raw
                        .Where(kv => kv.Value?.Length >= 2)
                        .ToDictionary(kv => kv.Key, kv => new Vector2(kv.Value[0], kv.Value[1]));
                }
            }
            catch { _cabinPositions = new(); }
        }

        private void SaveCabinPositions()
        {
            try
            {
                var raw = _cabinPositions.ToDictionary(
                    kv => kv.Key,
                    kv => new float[] { kv.Value.X, kv.Value.Y });
                Directory.CreateDirectory(Path.GetDirectoryName(CabinPositionsPath)!);
                File.WriteAllText(CabinPositionsPath, JsonSerializer.Serialize(raw));
            }
            catch { }
        }

        private void HandleCabinCommand(long farmerId, string? typeArg = null)
        {
            if (!_useCabinStack)
            {
                Game1.chatBox?.textBoxEnter("Cabin Stacking is not enabled on this server.");
                return;
            }

            // Block when /moveBuildingPermission is set to off (host only)
            if (_buildingMovePermission == "off")
            {
                Game1.chatBox?.textBoxEnter("The host has disabled cabin moving. Ask them to change Build Permissions in the world settings.");
                return;
            }

            var farmer = Game1.getFarmerMaybeOffline(farmerId);
            if (farmer == null) return;

            // Validate cabin type if provided
            string? fullCabinType = null;
            if (typeArg != null)
            {
                if (!CabinTypeAliases.TryGetValue(typeArg, out fullCabinType))
                {
                    Game1.chatBox?.textBoxEnter(
                        $"{farmer.Name}: Unknown cabin type '{typeArg}'. Valid types: stone, plank, log, neighbor, rustic, beach, trailer.");
                    return;
                }
            }

            if (farmer.currentLocation is not Farm farm)
            {
                Game1.chatBox?.textBoxEnter($"{farmer.Name}: You must be standing on the Farm to use move_cabin.");
                return;
            }

            // Place cabin one tile to the right of the player so the door doesn't land on them
            int x = farmer.TilePoint.X + 1;
            int y = farmer.TilePoint.Y;

            // Basic bounds check
            int mapW = farm.map?.Layers[0].LayerWidth  ?? 80;
            int mapH = farm.map?.Layers[0].LayerHeight ?? 65;
            if (x < 0 || y < 0 || x + 5 >= mapW || y + 3 >= mapH)
            {
                Game1.chatBox?.textBoxEnter($"{farmer.Name}: That position is too close to the edge of the farm. Move further in and try again.");
                return;
            }

            // Save new position
            _cabinPositions[farmerId.ToString()] = new Vector2(x, y);
            SaveCabinPositions();

            // Apply cabin skin via skinId (SDV 1.6 — buildingType stays "Cabin", skin is separate)
            if (fullCabinType != null)
            {
                var cabinBuilding = farm.buildings
                    .FirstOrDefault(b => (b.GetIndoors() as Cabin)?.owner?.UniqueMultiplayerID == farmerId);
                if (cabinBuilding != null)
                {
                    cabinBuilding.skinId.Value = fullCabinType;
                    Monitor.Log($"[CabinStack] {farmer.Name} set cabin skin to '{fullCabinType}'.", LogLevel.Info);
                }
            }

            string typeMsg = fullCabinType != null ? $" as a {fullCabinType}" : "";
            Monitor.Log($"[CabinStack] {farmer.Name} set cabin position to ({x},{y}){typeMsg}.", LogLevel.Info);

            SchedulePrivateMessageAndKick(farmerId, farmer.Name,
                $"Your cabin has been moved to ({x}, {y}){typeMsg}. " +
                $"You will be disconnected in 5 seconds — log back in to see your cabin in the new location.");
        }

        private void WriteCabinLevels()
        {
            try
            {
                var levels = new Dictionary<string, int>();
                foreach (var f in Game1.getAllFarmhands())
                    levels[f.Name] = f.houseUpgradeLevel.Value;
                Directory.CreateDirectory(Path.GetDirectoryName(CabinLevelsPath)!);
                File.WriteAllText(CabinLevelsPath, JsonSerializer.Serialize(levels));
            }
            catch { }
        }

        private void SchedulePrivateMessageAndKick(long peerId, string playerName, string message)
        {
            // Send private message via /message chat command
            Game1.chatBox?.textBoxEnter($"/message {playerName} {message}");
            // Kick after ~10 seconds
            _pendingKicks.Add((peerId, Environment.TickCount64 + 10000));
        }

        private (int count, bool stack) ReadCabinConfigFromFile()
        {
            try
            {
                if (File.Exists(CabinCountPath))
                {
                    var doc = JsonSerializer.Deserialize<JsonElement>(File.ReadAllText(CabinCountPath));
                    int  count = doc.TryGetProperty("cabinCount", out var cc) ? cc.GetInt32() : 0;
                    bool stack = doc.TryGetProperty("cabinStack",  out var cs) && cs.GetBoolean();
                    return (count, stack);
                }
            }
            catch { }
            return (0, false);
        }

        // Returns false when cabin stack is active — tells Harmony to skip vanilla BuildStartingCabins.
        // Returns true when cabin stack is off — vanilla places cabins normally.
        public static bool BuildStartingCabins_Prefix() => !_useCabinStack;

        /// <summary>
        /// Builds one cabin at the hidden off-screen location (-20, -20).
        /// The cabin is invisible on the farm map server-side; each player sees their own
        /// cabin relocated client-side via the LocationIntroduction message intercept.
        /// </summary>
        private bool BuildHiddenCabin(Farm farm)
        {
            var pos = new Vector2(HiddenCabinLocation.X, HiddenCabinLocation.Y);
            var cabin = new Building("Cabin", pos);
            cabin.skinId.Value = "Log Cabin";
            cabin.magical.Value = true;
            cabin.daysOfConstructionLeft.Value = 0;
            cabin.load();

            if (farm.buildStructure(cabin, pos, Game1.player, true))
            {
                var indoors = cabin.GetIndoors() as Cabin;
                if (indoors != null && !indoors.HasOwner)
                    indoors.CreateFarmhand();
                return true;
            }

            Monitor.Log("[CabinStack] Failed to build hidden cabin.", LogLevel.Warn);
            return false;
        }

        /// <summary>
        /// Ensures the farm has at least <paramref name="target"/> cabin buildings.
        /// Called on SaveLoaded to set up or restore the configured cabin count.
        /// </summary>
        private void EnsureCabinCount(int target)
        {
            if (!Context.IsWorldReady || !Context.IsMainPlayer) return;
            var farm = Game1.getFarm();
            int existing = farm.buildings.Count(b => b.isCabin);
            int toAdd = target - existing;
            if (toAdd <= 0)
            {
                Monitor.Log($"[CabinStack] {existing} cabin(s) present, target {target} — nothing to add.", LogLevel.Debug);
                return;
            }
            Monitor.Log($"[CabinStack] Building {toAdd} cabin(s) to reach target of {target}.", LogLevel.Info);
            for (int i = 0; i < toAdd; i++)
                BuildHiddenCabin(farm);
        }

        /// <summary>
        /// Returns the first cabin-designated tile position from the farm map's Paths layer,
        /// respecting the current cabin layout:
        ///   tile 30 = separate (spread around farm, used when Game1.cabinsSeparate = true)
        ///   tile 29 = nearby   (clustered near farmhouse, used when Game1.cabinsSeparate = false)
        /// Falls back to the other tile type if none found, then to hardcoded (50, 14).
        /// </summary>
        private static Vector2 GetDefaultCabinVisiblePosition(Farm farm)
        {
            // Tile 30 = separate spread positions; tile 29 = nearby grouped positions
            int preferred = Game1.cabinsSeparate ? 30 : 29;
            int fallback  = Game1.cabinsSeparate ? 29 : 30;

            try
            {
                var layer = farm.map?.GetLayer("Paths");
                if (layer != null)
                {
                    var positions = new List<(int order, Vector2 pos)>();
                    for (int x = 0; x < layer.LayerWidth; x++)
                    for (int y = 0; y < layer.LayerHeight; y++)
                    {
                        Tile tile = layer.Tiles[x, y];
                        if (tile == null || tile.TileIndex != preferred) continue;
                        if (tile.Properties.TryGetValue("Order", out var orderVal) &&
                            int.TryParse(orderVal?.ToString(), out int order))
                            positions.Add((order, new Vector2(x, y)));
                    }

                    // Nothing for the preferred layout — try the other tile type
                    if (positions.Count == 0)
                    {
                        for (int x = 0; x < layer.LayerWidth; x++)
                        for (int y = 0; y < layer.LayerHeight; y++)
                        {
                            Tile tile = layer.Tiles[x, y];
                            if (tile == null || tile.TileIndex != fallback) continue;
                            if (tile.Properties.TryGetValue("Order", out var orderVal) &&
                                int.TryParse(orderVal?.ToString(), out int order))
                                positions.Add((order, new Vector2(x, y)));
                        }
                    }

                    if (positions.Count > 0)
                        return positions.OrderBy(p => p.order).First().pos;
                }
            }
            catch { }
            return FallbackCabinVisiblePos;
        }

        /// <summary>
        /// Harmony prefix on GameServer.sendMessage.
        /// Intercepts LocationIntroduction messages destined for a specific peer and
        /// relocates that peer's cabin client-side so they see it at a real farm position.
        /// The server always stores cabins at (-20, -20) — only the outgoing message is modified.
        /// </summary>
        public static void SendMessage_Prefix(long peerId, ref OutgoingMessage message)
        {
            if (!_useCabinStack) return;
            if (message.MessageType != Multiplayer.locationIntroduction) return;
            _instance?.InterceptLocationIntroduction(peerId, ref message);
        }

        private void InterceptLocationIntroduction(long peerId, ref OutgoingMessage message)
        {
            try
            {
                // Deserialise the outgoing message into an IncomingMessage so we can read its payload
                var incMsg = new IncomingMessage();
                using (var ms = new MemoryStream())
                using (var bw = new BinaryWriter(ms))
                {
                    message.Write(bw);
                    ms.Position = 0;
                    using var br = new BinaryReader(ms);
                    incMsg.Read(br);
                }

                var forceCurrentLocation = incMsg.Reader.ReadBoolean();
                var netRootLocation      = NetRoot<GameLocation>.Connect(incMsg.Reader);
                if (netRootLocation.Value is not Farm farm) return;

                // Find this peer's cabin sitting at the hidden stack location
                var cabinBuilding = farm.buildings.FirstOrDefault(b =>
                    b.isCabin &&
                    b.tileX.Value == HiddenCabinLocation.X &&
                    b.tileY.Value == HiddenCabinLocation.Y &&
                    (b.GetIndoors() as Cabin)?.owner?.UniqueMultiplayerID == peerId);

                if (cabinBuilding == null) return;

                // Move cabin to visible position in this client's copy of the message only
                var visiblePos = _cabinPositions.TryGetValue(peerId.ToString(), out var savedPos)
                    ? savedPos
                    : GetDefaultCabinVisiblePosition(farm);
                cabinBuilding.tileX.Value = (int)visiblePos.X;
                cabinBuilding.tileY.Value = (int)visiblePos.Y;

                // Fix cabin exit warp so leaving the cabin door sends the player to the right spot
                if (cabinBuilding.GetIndoors() is Cabin indoors)
                {
                    var doorPos = cabinBuilding.getPointForHumanDoor();
                    foreach (var warp in indoors.warps.Where(w => w.TargetName == "Farm"))
                    {
                        warp.TargetX = doorPos.X;
                        warp.TargetY = doorPos.Y;
                    }
                }

                // Rebuild the outgoing message with the modified farm location state
                message = new OutgoingMessage(
                    Multiplayer.locationIntroduction,
                    Game1.serverHost.Value,
                    forceCurrentLocation,
                    Game1.Multiplayer.writeObjectFullBytes(netRootLocation, peerId));

                Monitor.Log($"[CabinStack] Cabin for peer {peerId} shown at ({visiblePos.X},{visiblePos.Y}) client-side.", LogLevel.Debug);
            }
            catch (Exception ex)
            {
                Monitor.Log($"[CabinStack] LocationIntroduction intercept failed for peer {peerId}: {ex.Message}", LogLevel.Warn);
            }
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
        public bool   CabinStack                { get; set; } = false;
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
