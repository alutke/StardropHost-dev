namespace StardropDashboard
{
    public class ModConfig
    {
        /// <summary>How often to write live-status.json (in seconds). 5-15 is ideal.</summary>
        public int UpdateIntervalSeconds { get; set; } = 10;

        /// <summary>
        /// Output directory for live-status.json.
        /// Leave blank to use ~/.local/share/stardrop/
        /// </summary>
        public string OutputDirectory { get; set; } = "";
    }
}