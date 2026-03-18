using System.Collections.Generic;

namespace ServerDashboard
{
    /// <summary>
    /// Root object written to live-status.json every N seconds.
    /// </summary>
    public class LiveStatus
    {
        // ── Meta ──────────────────────────────────────────────────────────────
        /// <summary>Unix timestamp (UTC) of when this data was written.</summary>
        public long Timestamp { get; set; }

        /// <summary>"running" | "offline"</summary>
        public string ServerState { get; set; } = "running";

        /// <summary>Reason for offline state, if applicable.</summary>
        public string? OfflineReason { get; set; }

        // ── World ─────────────────────────────────────────────────────────────
        public string FarmName         { get; set; } = "";
        public string Season           { get; set; } = "";
        public int    Day              { get; set; }
        public int    Year             { get; set; }

        /// <summary>Raw game time integer e.g. 630 = 6:30 AM</summary>
        public int    GameTimeMinutes  { get; set; }

        /// <summary>Human-readable e.g. "6:30 AM"</summary>
        public string DayTimeFormatted { get; set; } = "";

        /// <summary>"sunny" | "raining" | "stormy" | "snowing" | "windy"</summary>
        public string Weather          { get; set; } = "";

        public bool   IsFestivalDay    { get; set; }
        public string FestivalName     { get; set; } = "";

        // ── Economy ───────────────────────────────────────────────────────────
        /// <summary>Host player's current gold (= shared wallet total when wallets are shared).</summary>
        public int SharedMoney { get; set; }

        // ── Players ───────────────────────────────────────────────────────────
        public List<PlayerData> Players { get; set; } = new();

        // ── Cabins ────────────────────────────────────────────────────────────
        public List<CabinData> Cabins { get; set; } = new();
    }

    /// <summary>
    /// Per-player live data.
    /// </summary>
    public class PlayerData
    {
        public string Name          { get; set; } = "";
        public string UniqueId      { get; set; } = "";
        public bool   IsHost        { get; set; }
        public bool   IsOnline      { get; set; }

        // ── Vitals ────────────────────────────────────────────────────────────
        public int Health           { get; set; }
        public int MaxHealth        { get; set; }
        public int Stamina          { get; set; }
        public int MaxStamina       { get; set; }

        // ── Economy ───────────────────────────────────────────────────────────
        public int Money            { get; set; }
        public int TotalEarned      { get; set; }

        // ── Location ─────────────────────────────────────────────────────────
        public string LocationName  { get; set; } = "";

        // ── Skills ────────────────────────────────────────────────────────────
        public SkillLevels Skills   { get; set; } = new();

        // ── Stats ─────────────────────────────────────────────────────────────
        public int DaysPlayed       { get; set; }
    }

    /// <summary>
    /// The six core skill levels for a player.
    /// </summary>
    public class SkillLevels
    {
        public int Farming  { get; set; }
        public int Mining   { get; set; }
        public int Foraging { get; set; }
        public int Fishing  { get; set; }
        public int Combat   { get; set; }
        public int Luck     { get; set; }
    }

    /// <summary>
    /// Per-cabin data from the farm.
    /// </summary>
    public class CabinData
    {
        public string OwnerName     { get; set; } = "Unclaimed";
        public bool   IsOwnerOnline { get; set; }
        public int    TileX         { get; set; }
        public int    TileY         { get; set; }
        public bool   IsUpgraded    { get; set; }
    }
}
