/**
 * StardropHost | mods-source/StardropHost.Dependencies/CropSaver.cs
 *
 * Tracks which farmhand planted each crop and preserves it when the owner is
 * offline. Each day the owner is offline and their dirt is unwatered, the crop
 * earns one "extra day" of life. On day 28 of a season, any tracked crop that
 * is not fully grown is killed by us (bypassing the Harmony patch) to prevent
 * impossible grows from persisting indefinitely.
 *
 * Harmony patches Crop.Kill() with a prefix that returns false (blocks the kill)
 * for any crop currently tracked by this service.
 */

using System.Collections.Generic;
using System.Linq;
using HarmonyLib;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;
using StardewValley.TerrainFeatures;

namespace StardropHostDependencies
{
    internal class SaverCrop
    {
        public int  TileX     { get; set; }
        public int  TileY     { get; set; }
        public long OwnerId   { get; set; }
        public int  ExtraDays { get; set; }
    }

    internal class CropSaver
    {
        private static IMonitor   _monitor = null!;
        private static IModHelper _helper  = null!;

        /// <summary>Whether CropSaver is currently active. Can be toggled at runtime.</summary>
        public static bool Enabled = true;

        // Tile → crop tracking (runtime + persisted)
        private static readonly Dictionary<Vector2, SaverCrop> _crops     = new();
        private static          HashSet<Vector2>                _knownTiles = new();
        private const  string   SaveKey = "StardropHost.CropSaver";

        private int _tick = 0;

        // ── Constructor ───────────────────────────────────────────────────

        public CropSaver(IMonitor monitor, IModHelper helper, Harmony harmony, bool enabled)
        {
            _monitor = monitor;
            _helper  = helper;
            Enabled  = enabled;

            harmony.Patch(
                original: AccessTools.Method(typeof(Crop), nameof(Crop.Kill)),
                prefix:   new HarmonyMethod(typeof(CropSaver), nameof(Kill_Prefix))
            );

            helper.Events.GameLoop.SaveLoaded   += OnSaveLoaded;
            helper.Events.GameLoop.Saving        += OnSaving;
            helper.Events.GameLoop.DayEnding     += OnDayEnding;
            helper.Events.GameLoop.UpdateTicked  += OnUpdateTicked;

            _monitor.Log($"[CropSaver] Initialized (enabled={enabled}).", LogLevel.Info);
        }

        // ── Harmony patch ─────────────────────────────────────────────────

        /// <summary>
        /// Prefix on Crop.Kill(). Returns false (blocks kill) if the crop is tracked.
        /// We handle killing managed crops ourselves in OnDayEnding.
        /// </summary>
        public static bool Kill_Prefix(Crop __instance)
        {
            if (!Enabled || !Context.IsWorldReady) return true;

            var farm = Game1.getFarm();
            if (farm == null) return true;

            // Find the HoeDirt tile that holds this crop instance
            foreach (var (tile, feat) in farm.terrainFeatures.Pairs)
            {
                if (feat is HoeDirt dirt && dirt.crop == __instance)
                    return !_crops.ContainsKey(tile); // block if tracked
            }
            return true;
        }

        // ── Crop watcher (every 5 ticks) ──────────────────────────────────

        private void OnUpdateTicked(object? sender, UpdateTickedEventArgs e)
        {
            if (!Enabled || !Context.IsMainPlayer || !Context.IsWorldReady) return;
            if (++_tick % 5 != 0) return;

            var farm = Game1.getFarm();
            if (farm == null) return;

            // Snapshot current live crop tiles
            var current = new HashSet<Vector2>();
            foreach (var (tile, feat) in farm.terrainFeatures.Pairs)
                if (feat is HoeDirt d && d.crop != null && !d.crop.dead.Value)
                    current.Add(tile);

            // New crops
            foreach (var tile in current)
                if (!_knownTiles.Contains(tile))
                    RegisterCrop(farm, tile);

            // Removed/harvested crops
            foreach (var tile in _knownTiles.Where(t => !current.Contains(t)).ToList())
                _crops.Remove(tile);

            _knownTiles = current;
        }

        private static void RegisterCrop(Farm farm, Vector2 tile)
        {
            if (_crops.ContainsKey(tile)) return;

            // Closest online farmer currently on the Farm, fallback to host
            long ownerId = Game1.player.UniqueMultiplayerID;
            double best  = double.MaxValue;
            foreach (var f in Game1.getOnlineFarmers())
            {
                if (f.currentLocation?.Name != "Farm") continue;
                double dist = Vector2.Distance(f.Tile, tile);
                if (dist < best) { best = dist; ownerId = f.UniqueMultiplayerID; }
            }

            _crops[tile] = new SaverCrop
            {
                TileX     = (int)tile.X,
                TileY     = (int)tile.Y,
                OwnerId   = ownerId,
                ExtraDays = 0,
            };
        }

        // ── Day-end processing ────────────────────────────────────────────

        private void OnDayEnding(object? sender, DayEndingEventArgs e)
        {
            if (!Enabled || !Context.IsMainPlayer || !Context.IsWorldReady) return;

            var farm = Game1.getFarm();
            if (farm == null) return;

            var onlineIds = Game1.getOnlineFarmers()
                .Select(f => f.UniqueMultiplayerID)
                .ToHashSet();

            var toRemove = new List<Vector2>();

            foreach (var (tile, sc) in _crops)
            {
                // Crop removed externally (harvested, cleared, etc.)
                if (!farm.terrainFeatures.TryGetValue(tile, out var feat) ||
                    feat is not HoeDirt dirt || dirt.crop == null || dirt.crop.dead.Value)
                {
                    toRemove.Add(tile);
                    continue;
                }

                var crop = dirt.crop;

                // Extend lifespan while owner is offline and dirt is unwatered
                bool ownerOffline = !onlineIds.Contains(sc.OwnerId);
                bool unwatered    = dirt.state.Value != HoeDirt.watered;
                if (ownerOffline && unwatered)
                    sc.ExtraDays++;

                // Day 28: kill crops we're protecting that can't survive — prevents
                // dead-season crops from carrying into the next season indefinitely.
                // Fully grown crops are harvested normally; we only kill unfinished ones.
                if (Game1.dayOfMonth == 28 && !IsFullyGrown(crop))
                {
                    crop.dead.Value = true;
                    dirt.crop       = null;
                    toRemove.Add(tile);
                    _monitor.Log(
                        $"[CropSaver] Crop at ({sc.TileX},{sc.TileY}) reached end of season unfinished — removed.",
                        LogLevel.Debug);
                }
            }

            foreach (var tile in toRemove)
            {
                _crops.Remove(tile);
                _knownTiles.Remove(tile);
            }

            _monitor.Log($"[CropSaver] Day end: {_crops.Count} crop(s) tracked, {toRemove.Count} removed.", LogLevel.Trace);
        }

        private static bool IsFullyGrown(Crop crop) =>
            crop.currentPhase.Value >= crop.phaseDays.Count - 1;

        // ── Persistence ───────────────────────────────────────────────────

        private void OnSaveLoaded(object? sender, SaveLoadedEventArgs e)
        {
            _crops.Clear();
            _knownTiles.Clear();

            var saved = _helper.Data.ReadSaveData<List<SaverCrop>>(SaveKey) ?? new List<SaverCrop>();
            foreach (var sc in saved)
            {
                var tile = new Vector2(sc.TileX, sc.TileY);
                _crops[tile]  = sc;
                _knownTiles.Add(tile);
            }
            _monitor.Log($"[CropSaver] Loaded {_crops.Count} tracked crop(s).", LogLevel.Info);
        }

        private void OnSaving(object? sender, SavingEventArgs e)
        {
            if (!Context.IsMainPlayer) return;
            _helper.Data.WriteSaveData(SaveKey, _crops.Values.ToList());
        }
    }
}
