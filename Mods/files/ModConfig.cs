namespace ServerDashboard
{
    /// <summary>
    /// User-editable config for ServerDashboard.
    /// Stored in config.json inside the mod folder (SMAPI manages this automatically).
    /// </summary>
    public class ModConfig
    {
        /// <summary>
        /// How often (in real seconds) to write the live-status.json file.
        /// Lower = more up-to-date data but slightly more disk I/O.
        /// Default: 10 seconds. Minimum: 1.
        /// </summary>
        public int UpdateIntervalSeconds { get; set; } = 10;

        /// <summary>
        /// Where to write live-status.json.
        /// Leave blank to use the default puppy-stardew data directory:
        ///   ~/.local/share/puppy-stardew/
        /// You can override this to any absolute path on the host.
        /// </summary>
        public string OutputDirectory { get; set; } = "";
    }
}
