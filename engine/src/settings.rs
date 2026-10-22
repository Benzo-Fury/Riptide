//! User settings: what the app's Settings view edits, persisted as `settings.json` in the state
//! directory, and how they map onto Undercurrent's `Config`.

use crate::tide::{WEEK_HOURS, working_hours};
use undercurrent::{BindFn, Config, Encryption, Limits, SeedPolicy};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const MB: u64 = 1024 * 1024;
/// The least memory a torrent's pieces in progress may have.
const MIN_BUFFER_MB: u64 = 16;

/// Every user-adjustable option. Unknown or missing fields fall back to defaults, so files
/// written by older or newer versions still load.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// Where new torrents are saved unless the add dialog says otherwise.
    pub download_dir: String,
    /// Incoming peer and DHT port. Chosen at random on first launch, then kept.
    pub port: u16,
    /// Accept connections from peers; off, Riptide only connects out.
    pub accept_incoming: bool,
    /// One of `prefer`, `plaintext`, `require`, `off`.
    pub encryption: String,
    pub dht: bool,
    pub pex: bool,
    /// NAT-PMP, then UPnP.
    pub port_mapping: bool,
    pub upload_slots: usize,
    pub max_peers: usize,
    /// Connection attempts in progress at once, engine-wide.
    pub max_half_open: usize,
    /// Memory for pieces in progress, per torrent, in bytes.
    pub max_buffer_bytes: u64,
    /// Web seeds (HTTP mirrors a torrent lists) downloaded from at once, per torrent; 0 never.
    pub web_seeds: usize,
    /// Engine-wide limits in bytes per second; 0 is unlimited.
    pub download_limit: u64,
    pub upload_limit: u64,
    pub seed_enabled: bool,
    /// Stop seeding at this ratio; 0 is no limit.
    pub seed_ratio: f64,
    /// Stop seeding after this many minutes; 0 is no limit.
    pub seed_minutes: u64,
    /// Downloads running at once; the rest wait as `queued`. 0 is no limit.
    pub max_active_downloads: usize,
    /// Show a system notification when a download finishes (read by the app, not the engine).
    pub notify_on_complete: bool,
    /// Keep the Mac from sleeping while downloads move.
    pub prevent_sleep: bool,
    /// Worker threads; 0 for one per core (per performance core on Apple silicon).
    pub threads: usize,
    /// Slow tide's limits in bytes per second (0 is unlimited), used instead of the normal
    /// ones while it's on.
    pub slow_download_limit: u64,
    pub slow_upload_limit: u64,
    /// Slow tide switched on by hand (when there's no schedule).
    pub slow_tide: bool,
    /// A switch by hand while the schedule is followed, and the Unix ms it holds until (the
    /// schedule's next change at the time).
    pub slow_override: Option<bool>,
    pub slow_override_until: u64,
    /// Switch slow tide on during `slow_hours`.
    pub slow_schedule: bool,
    /// One entry per hour of the week, Monday 00:00 first; true is slow.
    pub slow_hours: Vec<bool>,
    /// The VPN lock: bind every socket to this interface's address, and connect to nothing
    /// while it has none. Empty uses any interface.
    pub bind_interface: String,
    /// Offer magnet links found on the clipboard (read by the app, not the engine).
    pub clipboard_magnets: bool,
}

impl Default for Settings {
    fn default() -> Settings {
        Settings {
            download_dir: dirs_downloads(),
            port: 0,
            accept_incoming: true,
            encryption: "prefer".into(),
            dht: true,
            pex: true,
            port_mapping: true,
            upload_slots: 4,
            max_peers: 200,
            max_half_open: 100,
            max_buffer_bytes: 512 * MB,
            web_seeds: 3,
            download_limit: 0,
            upload_limit: 0,
            seed_enabled: true,
            seed_ratio: 0.0,
            seed_minutes: 0,
            max_active_downloads: 5,
            notify_on_complete: true,
            prevent_sleep: true,
            threads: 0,
            slow_download_limit: 2_000_000,
            slow_upload_limit: 250_000,
            slow_tide: false,
            slow_override: None,
            slow_override_until: 0,
            slow_schedule: false,
            slow_hours: working_hours(),
            bind_interface: String::new(),
            clipboard_magnets: true,
        }
    }
}

impl Settings {
    /// Loads `settings.json`, or defaults when there is none (or it can't be read). A port of
    /// 0 is replaced by a random one in the unprivileged range and the result saved, so the port
    /// stays stable across launches.
    pub fn load(dir: &Path) -> Settings {
        let mut s: Settings = std::fs::read(Self::path(dir)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        s.slow_hours.resize(WEEK_HOURS, false);

        // Pick a stable random port the first time
        if s.port == 0 {
            s.port = 20000 + (random_u64() % 40000) as u16;
            let _ = s.save(dir);
        }
        s
    }

    /// Writes `settings.json` atomically.
    pub fn save(&self, dir: &Path) -> std::io::Result<()> {
        let tmp = dir.join("settings.json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        std::fs::rename(tmp, Self::path(dir))
    }

    /// Rejects values the engine can't run with, before anything is applied.
    pub fn validate(&self) -> Result<(), String> {
        if self.download_dir.trim().is_empty() {
            return Err("Choose a download folder.".into());
        }
        if Self::encryption_of(&self.encryption).is_none() {
            return Err(format!("Unknown encryption setting \"{}\".", self.encryption));
        }
        if self.port == 0 {
            return Err("The port must be between 1 and 65535.".into());
        }
        if !(self.seed_ratio >= 0.0 && self.seed_ratio.is_finite()) {
            return Err("The seed ratio must be zero or more.".into());
        }
        if self.max_peers == 0 {
            return Err("Allow at least one peer per torrent.".into());
        }
        if self.max_buffer_bytes < MIN_BUFFER_MB * MB {
            return Err(format!("Give pieces in progress at least {MIN_BUFFER_MB} MB."));
        }
        if self.slow_hours.len() != WEEK_HOURS {
            return Err(format!("The slow tide schedule needs {WEEK_HOURS} hours."));
        }
        Ok(())
    }

    /// The engine configuration these settings describe. Resume state, warm DHT nodes and the
    /// VPN lock's bind function come from the daemon, which owns them.
    pub fn to_config(&self, resume_dir: PathBuf, dht_nodes: Vec<std::net::SocketAddr>, bind: Option<BindFn>) -> Config {
        Config {
            port: self.port,
            listen: self.accept_incoming,
            bind,
            encryption: Self::encryption_of(&self.encryption).unwrap_or_default(),
            resume_dir: Some(resume_dir),
            seed: self.seed_policy(),
            upload_slots: self.upload_slots,
            limits: self.limits(false),
            port_mapping: self.port_mapping,
            dht: self.dht,
            dht_nodes,
            pex: self.pex,
            max_peers_per_torrent: self.max_peers,
            max_half_open: self.max_half_open.max(1),
            max_buffer_bytes: self.max_buffer_bytes,
            web_seeds: self.web_seeds,
            threads: self.threads,
            ..Config::default()
        }
    }

    /// The engine-wide limits, slow tide's while it's on.
    pub fn limits(&self, slow: bool) -> Limits {
        if slow {
            Limits { download: self.slow_download_limit, upload: self.slow_upload_limit }
        } else {
            Limits { download: self.download_limit, upload: self.upload_limit }
        }
    }

    pub fn seed_policy(&self) -> SeedPolicy {
        SeedPolicy { enabled: self.seed_enabled, ratio: self.seed_ratio, minutes: self.seed_minutes }
    }

    /// Whether moving from `self` to `next` needs the engine rebuilt. Rate limits apply live;
    /// everything that shapes sockets, threads or policies is fixed at engine start.
    pub fn needs_restart(&self, next: &Settings) -> bool {
        self.port != next.port
            || self.accept_incoming != next.accept_incoming
            || self.encryption != next.encryption
            || self.dht != next.dht
            || self.pex != next.pex
            || self.port_mapping != next.port_mapping
            || self.upload_slots != next.upload_slots
            || self.max_peers != next.max_peers
            || self.max_half_open != next.max_half_open
            || self.max_buffer_bytes != next.max_buffer_bytes
            || self.web_seeds != next.web_seeds
            || self.seed_enabled != next.seed_enabled
            || self.seed_ratio != next.seed_ratio
            || self.seed_minutes != next.seed_minutes
            || self.threads != next.threads
            || self.bind_interface != next.bind_interface
    }

    fn path(dir: &Path) -> PathBuf {
        dir.join("settings.json")
    }

    fn encryption_of(name: &str) -> Option<Encryption> {
        match name {
            "prefer" => Some(Encryption::Prefer),
            "plaintext" => Some(Encryption::PreferPlaintext),
            "require" => Some(Encryption::Require),
            "off" => Some(Encryption::Off),
            _ => None,
        }
    }
}

/// The user's Downloads folder, or the home directory, or the current one.
fn dirs_downloads() -> String {
    std::env::var("HOME").map(|h| format!("{h}/Downloads")).unwrap_or_else(|_| ".".into())
}

/// A random number from the OS, for picking a port. Falls back to the clock.
fn random_u64() -> u64 {
    let mut b = [0u8; 8];
    if std::fs::File::open("/dev/urandom").and_then(|mut f| std::io::Read::read_exact(&mut f, &mut b)).is_ok() {
        u64::from_le_bytes(b)
    } else {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(7, |d| d.as_nanos() as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_load_picks_and_keeps_a_port() {
        let dir = tempfile::tempdir().unwrap();
        let a = Settings::load(dir.path());
        assert!((20000..60000).contains(&a.port));
        assert_eq!(Settings::load(dir.path()).port, a.port);
    }

    #[test]
    fn partial_files_fill_in_defaults() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("settings.json"), r#"{"port": 6881, "dht": false}"#).unwrap();
        let s = Settings::load(dir.path());
        assert_eq!((s.port, s.dht, s.pex), (6881, false, true));
        assert_eq!(s.slow_hours, working_hours());
    }

    #[test]
    fn limits_apply_live_but_ports_restart() {
        let a = Settings { port: 1000, ..Settings::default() };
        assert!(!a.needs_restart(&Settings { download_limit: 5, ..a.clone() }));
        assert!(a.needs_restart(&Settings { port: 1001, ..a.clone() }));
        assert!(a.needs_restart(&Settings { encryption: "require".into(), ..a.clone() }));
        assert!(!a.needs_restart(&Settings { slow_tide: true, slow_upload_limit: 1, ..a.clone() }));
        assert!(a.needs_restart(&Settings { bind_interface: "utun4".into(), ..a.clone() }));
        assert!(a.needs_restart(&Settings { accept_incoming: false, ..a.clone() }));
        assert!(a.needs_restart(&Settings { max_half_open: 20, ..a.clone() }));
        assert!(a.needs_restart(&Settings { web_seeds: 0, ..a.clone() }));
    }

    #[test]
    fn validation_catches_bad_values() {
        let ok = Settings { port: 6881, ..Settings::default() };
        assert!(ok.validate().is_ok());
        assert!(Settings { encryption: "rot13".into(), ..ok.clone() }.validate().is_err());
        assert!(Settings { download_dir: " ".into(), ..ok.clone() }.validate().is_err());
        assert!(Settings { seed_ratio: -1.0, ..ok.clone() }.validate().is_err());
        assert!(Settings { slow_hours: vec![true; 3], ..ok.clone() }.validate().is_err());
        assert!(Settings { max_buffer_bytes: MB, ..ok.clone() }.validate().is_err());
    }
}
