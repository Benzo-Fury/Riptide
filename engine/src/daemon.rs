//! The daemon: owns the Undercurrent engine, the library and the settings, and turns protocol
//! requests into engine calls. Everything runs on one thread; engine events, stdin requests and
//! background work all arrive through one channel, so no state is shared.

use crate::awake::Awake;
use crate::library::{Entry, Library};
use crate::network::{self, Lock};
use crate::pieces::PieceMap;
use crate::protocol::{Request, TorrentSource, Writer};
use crate::settings::Settings;
use crate::tide::{self, TidePlan, TideState};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use undercurrent::{AddOptions, CreateOptions, Engine, Event, EventKind, InfoHash, Limits, Source, Start, State, Torrent};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// How often a snapshot of every torrent is pushed to the app.
const TICK: Duration = Duration::from_millis(500);

/// How often warm-start DHT nodes are written to disk.
const DHT_SAVE_EVERY: Duration = Duration::from_secs(300);
/// How long the Mac is kept awake after the last byte arrived, so a stall doesn't let it sleep
/// in the middle of a download.
const AWAKE_AFTER: Duration = Duration::from_secs(300);

/// Warnings kept per torrent for the details view.
const WARNINGS_KEPT: usize = 50;

// ---------- Inputs ---------- //

/// Everything the main loop reacts to.
pub enum Input {
    Request(Request),
    /// An engine event. `generation` identifies the engine that sent it, so events from an
    /// engine replaced by a settings change are dropped.
    Engine { generation: u64, event: Event },
    /// A `.torrent` built on a background thread for request `id`.
    Created { id: u64, params: CreateParams, result: std::io::Result<Vec<u8>> },
    /// Stdin closed: the app is gone.
    Closed,
}

// ---------- Request parameters ---------- //

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddParams {
    source: TorrentSource,
    /// Save folder; the settings' download folder when absent.
    dir: Option<String>,
    #[serde(default)]
    paused: bool,
    /// File indexes to download; all when absent.
    files: Option<Vec<usize>>,
    /// Stop at `waiting` once metadata arrives so the user can choose files.
    #[serde(default)]
    metadata_only: bool,
    #[serde(default)]
    seed_mode: bool,
}

#[derive(Deserialize)]
struct Hashes {
    hashes: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoveParams {
    hashes: Vec<String>,
    #[serde(default)]
    delete_files: bool,
}

#[derive(Deserialize)]
struct InspectParams {
    source: TorrentSource,
}

#[derive(Deserialize)]
struct HashParam {
    hash: String,
}

#[derive(Deserialize)]
struct SelectParams {
    hash: String,
    files: Vec<usize>,
}

#[derive(Deserialize)]
struct LimitParams {
    hash: String,
    download: u64,
    upload: u64,
}

#[derive(Deserialize)]
struct PeerParams {
    hash: String,
    address: String,
}

#[derive(Deserialize)]
struct SlowTideParams {
    on: bool,
}

#[derive(Deserialize)]
struct ExportParams {
    hash: String,
    path: String,
}

/// What `create` builds: a `.torrent` of `path`, written to `out`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateParams {
    path: String,
    out: String,
    /// One tracker per tier, in order.
    #[serde(default)]
    trackers: Vec<String>,
    #[serde(default)]
    private: bool,
    comment: Option<String>,
    /// Piece size in KiB; chosen from the size when absent.
    piece_kb: Option<u64>,
    /// Add the new torrent and seed it from `path` straight away.
    #[serde(default)]
    seed: bool,
}

// ---------- Per-torrent runtime state ---------- //

/// What the daemon tracks per torrent beyond the library: things that only matter while
/// running and are rebuilt on restart.
#[derive(Default)]
struct Runtime {
    /// The last fatal error; Undercurrent pauses the torrent when one happens.
    error: Option<String>,
    /// Recent warnings with their Unix-ms time, newest last.
    warnings: VecDeque<(u64, String)>,
    pieces: Option<PieceMap>,
}

// ---------- Daemon ---------- //

/// The daemon. Construct it with `open`, then hand it the input channel with `run`.
pub struct Daemon {
    /// The state directory: settings, library, saved torrents, resume files, DHT nodes.
    dir: PathBuf,
    settings: Settings,
    library: Library,
    /// `None` only when the engine couldn't start (the reason is in `engine_error`).
    engine: Option<Engine>,
    engine_error: Option<String>,
    /// Bumped each time the engine is (re)built; tags its events.
    generation: u64,
    /// Given to background threads (engine event forwarding, torrent creation).
    inputs: Sender<Input>,
    runtime: HashMap<String, Runtime>,
    out: Writer,
    last_dht_save: Instant,
    /// The VPN lock, when the settings name an interface. Rebuilt with the engine.
    lock: Option<Lock>,
    /// Whether the engine runs on slow tide's limits; `None` until they're first applied.
    slow_applied: Option<bool>,
    /// Keeps the Mac awake while transfers move; when bytes last arrived or files were checked.
    awake: Awake,
    last_transfer: Option<Instant>,
}

impl Daemon {
    /// Opens the state directory and starts the engine with every saved torrent. A failure to
    /// start the engine is reported in snapshots rather than ending the process, so the app can
    /// still show the library and fix the settings.
    pub fn open(dir: &Path, inputs: Sender<Input>) -> std::io::Result<Daemon> {
        std::fs::create_dir_all(dir)?;
        let mut d = Daemon {
            dir: dir.to_path_buf(),
            settings: Settings::load(dir),
            library: Library::open(dir)?,
            engine: None,
            engine_error: None,
            generation: 0,
            inputs,
            runtime: HashMap::new(),
            out: Writer::new(),
            last_dht_save: Instant::now(),
            lock: None,
            slow_applied: None,
            awake: Awake::new("Riptide is downloading"),
            last_transfer: None,
        };
        d.start_engine();
        Ok(d)
    }

    /// The main loop: requests, engine events and a snapshot every `TICK`, until stdin closes
    /// or the app asks for `shutdown`.
    pub fn run(mut self, rx: Receiver<Input>) {
        // Tell the app we're up, with what it needs to render immediately
        self.out.event("ready", json!({ "version": env!("CARGO_PKG_VERSION"), "settings": self.settings }));
        self.tick();

        let mut next_tick = Instant::now() + TICK;
        loop {
            match rx.recv_timeout(next_tick.saturating_duration_since(Instant::now())) {
                // Shutdown answers first, then falls through to the cleanup below
                Ok(Input::Request(r)) if r.method == "shutdown" => {
                    self.out.respond(r.id, Ok(Value::Null));
                    break;
                }
                // Create answers later, from its hashing thread
                Ok(Input::Request(r)) if r.method == "create" => {
                    if let Err(e) = parse(r.params.clone()).and_then(|p| self.create(r.id, p)) {
                        self.out.respond(r.id, Err(e));
                    }
                }
                Ok(Input::Request(r)) => {
                    let result = self.handle(&r);
                    self.out.respond(r.id, result);
                }
                Ok(Input::Engine { generation, event }) => {
                    if generation == self.generation {
                        self.on_event(event);
                    }
                }
                Ok(Input::Created { id, params, result }) => {
                    let result = self.finish_create(params, result);
                    self.out.respond(id, result);
                }
                Ok(Input::Closed) | Err(RecvTimeoutError::Disconnected) => break,
                Err(RecvTimeoutError::Timeout) => {}
            }

            // Snapshot on schedule, however busy the channel is
            if Instant::now() >= next_tick {
                self.tick();
                next_tick = Instant::now() + TICK;
            }
        }
        self.shutdown();
    }

    // ---------- Engine lifecycle ---------- //

    /// Builds the engine from the current settings and re-adds every library entry. Any
    /// previous engine is dropped first (which pauses its torrents and saves resume state), so
    /// its port is free again.
    fn start_engine(&mut self) {
        // Stop the old engine and invalidate its events
        self.save_dht_nodes();
        self.engine = None;
        self.generation += 1;
        self.engine_error = None;

        // Lock to the chosen interface, if any
        let iface = self.settings.bind_interface.trim();
        self.lock = (!iface.is_empty()).then(|| Lock::new(iface));
        let bind = self.lock.as_ref().map(Lock::bind_fn);

        // Start the new one, falling back to a random port if ours is taken
        let config = self.settings.to_config(self.library.resume_dir(), self.load_dht_nodes(), bind);
        let engine = match Engine::new(config.clone()) {
            Ok(e) => e,
            Err(first) => match Engine::new(undercurrent::Config { port: 0, ..config }) {
                Ok(e) => {
                    self.out.event("warning", json!({ "message": format!("Port {} is unavailable ({first}), so a random port is in use.", self.settings.port) }));
                    e
                }
                Err(e) => {
                    self.engine_error = Some(format!("The engine couldn't start: {e}"));
                    return;
                }
            },
        };

        // Forward its events into the main loop
        let events = engine.subscribe();
        let (tx, generation) = (self.inputs.clone(), self.generation);
        std::thread::Builder::new()
            .name("undercurrentd-events".into())
            .spawn(move || {
                for event in events {
                    if tx.send(Input::Engine { generation, event }).is_err() {
                        break;
                    }
                }
            })
            .expect("spawn event thread");
        // A locked interface that's down at start keeps the network closed until it's back
        if self.lock.as_ref().is_some_and(|l| l.address().is_none()) {
            engine.disconnect();
        }
        self.engine = Some(engine);
        self.slow_applied = None;
        self.apply_tide();

        // Bring back everything in the library
        for entry in self.library.entries() {
            if let Err(e) = self.restore(&entry) {
                self.runtime.entry(entry.hash.clone()).or_default().error = Some(e);
            }
        }
    }

    /// Re-adds one library entry to the engine, from its saved `.torrent` or, for a magnet
    /// still without metadata, its link.
    fn restore(&mut self, entry: &Entry) -> Result<(), String> {
        let engine = self.engine()?;
        let options = Self::options_for(entry);
        let t = match (self.library.torrent_bytes(&entry.hash), &entry.magnet) {
            (Some(bytes), _) => engine.add(Source::Torrent(&bytes), options),
            (None, Some(uri)) => engine.add(Source::Magnet(uri), options),
            (None, None) => return Err("The saved torrent file is missing. Remove it and add it again.".into()),
        }
        .map_err(|e| e.to_string())?;
        self.init_pieces(&t);
        Ok(())
    }

    /// The `AddOptions` an entry is restored with.
    fn options_for(entry: &Entry) -> AddOptions {
        AddOptions {
            dir: entry.dir.clone().into(),
            start: if entry.metadata_only { Start::MetadataOnly } else { Start::All },
            files: entry.files.clone(),
            trackers: entry.trackers.clone(),
            paused: entry.paused || entry.queued,
            limits: Limits { download: entry.download_limit, upload: entry.upload_limit },
            ..Default::default()
        }
    }

    fn engine(&self) -> Result<&Engine, String> {
        self.engine.as_ref().ok_or_else(|| self.engine_error.clone().unwrap_or_else(|| "The engine isn't running.".into()))
    }

    /// The engine's handle for a hex hash.
    fn torrent(&self, hash: &str) -> Result<Torrent, String> {
        let ih = parse_hash(hash).ok_or_else(|| format!("\"{hash}\" isn't an info hash."))?;
        self.engine()?.get(&ih).ok_or_else(|| "That torrent isn't in the list.".into())
    }

    /// Writes the DHT routing table's nodes for a warm start next time.
    fn save_dht_nodes(&mut self) {
        self.last_dht_save = Instant::now();
        let Some(engine) = &self.engine else { return };
        let nodes: Vec<String> = engine.dht_nodes().iter().map(|a| a.to_string()).collect();
        if !nodes.is_empty() {
            let _ = std::fs::write(self.dir.join("dht.json"), serde_json::to_vec(&nodes).unwrap_or_default());
        }
    }

    fn load_dht_nodes(&self) -> Vec<std::net::SocketAddr> {
        let saved: Vec<String> = std::fs::read(self.dir.join("dht.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        saved.iter().filter_map(|s| s.parse().ok()).collect()
    }

    /// Saves everything and stops the engine (dropping it pauses every torrent, which writes
    /// their resume state).
    fn shutdown(&mut self) {
        self.save_dht_nodes();
        let _ = self.library.save_if_dirty();
        self.engine = None;
    }

    // ---------- Requests ---------- //

    /// Runs one request. Errors are sentences the app can show as they are.
    fn handle(&mut self, r: &Request) -> Result<Value, String> {
        let p = r.params.clone();
        match r.method.as_str() {
            "snapshot" => Ok(self.snapshot()),
            "getSettings" => Ok(json!(self.settings)),
            "setSettings" => self.set_settings(parse(p)?),
            "inspect" => self.inspect(&parse::<InspectParams>(p)?.source),
            "add" => self.add(parse(p)?),
            "pause" => self.pause(parse::<Hashes>(p)?.hashes),
            "resume" => self.resume(parse::<Hashes>(p)?.hashes),
            "recheck" => self.recheck(parse::<Hashes>(p)?.hashes),
            "remove" => self.remove(parse(p)?),
            "select" => self.select(parse(p)?),
            "setLimits" => self.set_limits(parse(p)?),
            "addPeer" => self.add_peer(parse(p)?),
            "details" => self.details(&parse::<HashParam>(p)?.hash),
            "exportTorrent" => self.export_torrent(parse(p)?),
            "interfaces" => Ok(json!(network::interfaces())),
            "setSlowTide" => self.set_slow_tide(parse::<SlowTideParams>(p)?.on),
            other => Err(format!("Unknown request \"{other}\".")),
        }
    }

    /// Validates and saves new settings. Rate limits change live; anything else rebuilds the
    /// engine (torrents pick up where they were, from resume state).
    fn set_settings(&mut self, next: Settings) -> Result<Value, String> {
        next.validate()?;
        let restart = self.settings.needs_restart(&next);
        next.save(&self.dir).map_err(|e| format!("Couldn't save settings: {e}"))?;
        self.settings = next;
        if restart || self.engine.is_none() {
            self.start_engine();
        } else {
            self.slow_applied = None;
            self.apply_tide();
        }
        Ok(json!({ "settings": self.settings, "restarted": restart }))
    }

    /// Switches slow tide on or off by hand, saved like any other setting. With a schedule, the
    /// switch holds until the schedule's next change; without one, until it's switched back.
    fn set_slow_tide(&mut self, on: bool) -> Result<Value, String> {
        let mut next = self.settings.clone();
        if next.slow_schedule {
            next.slow_override = Some(on);
            next.slow_override_until = self.tide().next_change.unwrap_or(u64::MAX);
        } else {
            next.slow_tide = on;
        }
        next.save(&self.dir).map_err(|e| format!("Couldn't save settings: {e}"))?;
        self.settings = next;
        self.apply_tide();
        Ok(json!({ "settings": self.settings, "slowTide": self.tide() }))
    }

    /// Reads a torrent or magnet without adding it, for the add dialog.
    fn inspect(&self, source: &TorrentSource) -> Result<Value, String> {
        let loaded = load_source(source)?;
        let hash = undercurrent::to_hex(&loaded.info_hash);
        let base = json!({ "hash": hash, "alreadyAdded": self.library.get(&hash).is_some(), "trackers": loaded.trackers });
        let mut v = match &loaded.bytes {
            // A .torrent: everything is known
            Some(bytes) => {
                let m = undercurrent::parse_torrent(bytes).map_err(|e| e.0)?;
                let files: Vec<Value> = m.info.files.iter().enumerate().map(|(i, f)| json!({ "index": i, "path": f.path, "length": f.length })).collect();
                json!({
                    "isMagnet": false,
                    "name": m.info.name,
                    "size": m.info.files.iter().map(|f| f.length).sum::<u64>(),
                    "files": files,
                    "private": m.info.private,
                    "pieceLength": m.info.piece_length,
                    "pieceCount": m.info.piece_count(),
                })
            }
            // A magnet: only the name, if it carries one
            None => json!({ "isMagnet": true, "name": loaded.name, "size": null, "files": [], "private": false }),
        };
        merge(&mut v, base);
        Ok(v)
    }

    /// Adds a torrent and records it in the library. Adding one already in the list is not an
    /// error: it answers with `existing: true` so the app can point at it.
    fn add(&mut self, p: AddParams) -> Result<Value, String> {
        let loaded = load_source(&p.source)?;
        let hash = undercurrent::to_hex(&loaded.info_hash);
        if let Some(e) = self.library.get(&hash) {
            return Ok(json!({ "hash": hash, "name": e.name, "existing": true }));
        }

        // Make sure the save folder exists
        let dir = p.dir.filter(|d| !d.trim().is_empty()).unwrap_or_else(|| self.settings.download_dir.clone());
        std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't use {dir} as the save folder: {e}"))?;

        // Queue it when the download slots are full (a seed-mode add never queues)
        let queued = !p.paused && !p.seed_mode && self.queue_full();
        let entry = Entry {
            hash: hash.clone(),
            name: loaded.name.clone(),
            dir,
            added_at: now_ms(),
            completed_at: None,
            paused: p.paused,
            queued,
            files: p.files,
            metadata_only: p.metadata_only,
            magnet: loaded.bytes.is_none().then(|| loaded.magnet.clone()).flatten(),
            trackers: if loaded.bytes.is_none() { loaded.trackers.clone() } else { Vec::new() },
            download_limit: 0,
            upload_limit: 0,
            seed_mode: p.seed_mode,
        };

        // Save the metainfo first, so a crash right after adding loses nothing
        if let Some(bytes) = &loaded.bytes {
            self.library.save_torrent(&hash, bytes).map_err(|e| format!("Couldn't save the torrent file: {e}"))?;
        }

        // Hand it to the engine
        let mut options = Self::options_for(&entry);
        options.seed_mode = p.seed_mode;
        let engine = self.engine()?;
        let added = match &loaded.bytes {
            Some(bytes) => engine.add(Source::Torrent(bytes), options),
            None => engine.add(Source::Magnet(loaded.magnet.as_deref().unwrap_or_default()), options),
        };
        let t = match added {
            Ok(t) => t,
            Err(e) => {
                self.library.remove(&hash);
                return Err(e.to_string());
            }
        };
        self.library.insert(entry);
        self.init_pieces(&t);
        let _ = self.library.save_if_dirty();
        Ok(json!({ "hash": hash, "name": loaded.name, "existing": false, "queued": queued }))
    }

    /// Pauses torrents by the user's hand: they stay paused across restarts and the queue
    /// leaves them alone.
    fn pause(&mut self, hashes: Vec<String>) -> Result<Value, String> {
        for hash in &hashes {
            self.library.update(hash, |e| {
                e.paused = true;
                e.queued = false;
            });
            if let Ok(t) = self.torrent(hash) {
                t.pause();
            }
        }
        Ok(Value::Null)
    }

    /// Resumes torrents. An unfinished download goes to the queue instead when every slot is
    /// taken; an errored torrent forgets its error and tries again.
    fn resume(&mut self, hashes: Vec<String>) -> Result<Value, String> {
        for hash in &hashes {
            let t = self.torrent(hash)?;
            self.runtime.entry(hash.clone()).or_default().error = None;
            let wait = t.state() == State::Paused && !is_complete(&t) && self.queue_full();
            self.library.update(hash, |e| {
                e.paused = false;
                e.queued = wait;
            });
            if !wait {
                t.resume();
            }
        }
        Ok(Value::Null)
    }

    fn recheck(&mut self, hashes: Vec<String>) -> Result<Value, String> {
        for hash in &hashes {
            self.torrent(hash)?.recheck();
            if let Some(rt) = self.runtime.get_mut(hash) {
                rt.pieces = None;
            }
        }
        Ok(Value::Null)
    }

    /// Removes torrents from the list, and their files from disk when asked. Saved metainfo and
    /// resume state go either way.
    fn remove(&mut self, p: RemoveParams) -> Result<Value, String> {
        for hash in &p.hashes {
            if let Ok(t) = self.torrent(hash) {
                t.close(p.delete_files);
            }
            self.library.remove(hash);
            self.runtime.remove(hash);
        }
        let _ = self.library.save_if_dirty();
        Ok(Value::Null)
    }

    /// Changes which files download. Also how a torrent waiting in `metadata_only` starts.
    fn select(&mut self, p: SelectParams) -> Result<Value, String> {
        let t = self.torrent(&p.hash)?;
        let count = t.info().map_or(0, |i| i.files.len());
        if count == 0 {
            return Err("The file list isn't known yet.".into());
        }
        if p.files.is_empty() || p.files.iter().any(|&i| i >= count) {
            return Err("Choose at least one file from this torrent.".into());
        }
        t.select(&p.files);
        self.library.update(&p.hash, |e| {
            e.files = Some(p.files.clone());
            e.metadata_only = false;
        });
        Ok(Value::Null)
    }

    fn set_limits(&mut self, p: LimitParams) -> Result<Value, String> {
        self.torrent(&p.hash)?.set_limits(Limits { download: p.download, upload: p.upload });
        self.library.update(&p.hash, |e| {
            e.download_limit = p.download;
            e.upload_limit = p.upload;
        });
        Ok(Value::Null)
    }

    fn add_peer(&mut self, p: PeerParams) -> Result<Value, String> {
        let address = p.address.trim();
        if address.parse::<std::net::SocketAddr>().is_err() && !address.contains(':') {
            return Err("Enter an address as host:port.".into());
        }
        self.torrent(&p.hash)?.add_peer(address);
        Ok(Value::Null)
    }

    /// Copies a torrent's saved `.torrent` to `path`.
    fn export_torrent(&self, p: ExportParams) -> Result<Value, String> {
        if !self.library.has_torrent(&p.hash) {
            return Err("There's no torrent file yet: the metadata hasn't arrived.".into());
        }
        std::fs::copy(self.library.torrent_path(&p.hash), &p.path).map_err(|e| format!("Couldn't write {}: {e}", p.path))?;
        Ok(Value::Null)
    }

    /// Starts building a `.torrent` on a background thread (hashing can take minutes). The
    /// answer to request `id` comes from `finish_create` when it's done; only validation errors
    /// are returned here.
    fn create(&mut self, id: u64, p: CreateParams) -> Result<(), String> {
        if !Path::new(&p.path).exists() {
            return Err(format!("{} doesn't exist.", p.path));
        }
        if let Some(kb) = p.piece_kb {
            if !kb.is_power_of_two() || kb < 16 {
                return Err("The piece size must be a power of two, 16 KiB or more.".into());
            }
        }
        let tx = self.inputs.clone();
        std::thread::Builder::new()
            .name("undercurrentd-create".into())
            .spawn(move || {
                let options = CreateOptions {
                    trackers: p.trackers.iter().filter(|t| !t.trim().is_empty()).map(|t| vec![t.trim().to_string()]).collect(),
                    private: p.private,
                    comment: p.comment.clone().filter(|c| !c.trim().is_empty()),
                    piece_length: p.piece_kb.map(|kb| kb * 1024),
                    creation_date: Some(now_ms() / 1000),
                    ..Default::default()
                };
                let result = undercurrent::create(Path::new(&p.path), &options);
                let _ = tx.send(Input::Created { id, params: p, result });
            })
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Writes a finished `.torrent` and, when asked, starts seeding it from the source files.
    fn finish_create(&mut self, p: CreateParams, result: std::io::Result<Vec<u8>>) -> Result<Value, String> {
        let bytes = result.map_err(|e| format!("Couldn't create the torrent: {e}"))?;
        std::fs::write(&p.out, &bytes).map_err(|e| format!("Couldn't write {}: {e}", p.out))?;
        let m = undercurrent::parse_torrent(&bytes).map_err(|e| e.0)?;
        let hash = undercurrent::to_hex(&m.info.info_hash);

        // Seed from the folder that holds the source
        if p.seed {
            let dir = Path::new(&p.path).parent().map(|d| d.to_string_lossy().into_owned()).unwrap_or_else(|| ".".into());
            self.add(AddParams {
                source: TorrentSource::File { path: p.out.clone() },
                dir: Some(dir),
                paused: false,
                files: None,
                metadata_only: false,
                seed_mode: true,
            })?;
        }
        Ok(json!({ "hash": hash, "out": p.out, "magnet": magnet_link(&hash, &m.info.name, &m.trackers) }))
    }

    /// Everything the details drawer shows for one torrent.
    fn details(&mut self, hash: &str) -> Result<Value, String> {
        let entry = self.library.get(hash).cloned().ok_or("That torrent isn't in the list.")?;
        let rt_warnings: Vec<Value> = self.runtime.get(hash).map(|rt| rt.warnings.iter().map(|(at, m)| json!({ "at": at, "message": m })).collect()).unwrap_or_default();
        let t = match self.torrent(hash) {
            Ok(t) => t,
            // Not running (it failed to restore): show what the library knows
            Err(_) => return Ok(json!({ "hash": hash, "name": entry.name, "dir": entry.dir, "files": [], "peers": [], "trackers": [], "warnings": rt_warnings })),
        };

        // Make sure the piece map exists before reading it
        if self.runtime.get(hash).and_then(|rt| rt.pieces.as_ref()).is_none() {
            self.init_pieces(&t);
        }
        let s = t.stats();
        let info = t.info();
        let dir = PathBuf::from(&entry.dir);
        let files: Vec<Value> = t
            .files()
            .iter()
            .map(|f| {
                let rel = f.path.strip_prefix(&dir).unwrap_or(&f.path);
                json!({ "index": f.index, "path": rel.to_string_lossy(), "length": f.length, "selected": f.selected, "downloaded": f.downloaded })
            })
            .collect();
        let peers: Vec<Value> = s
            .peers
            .iter()
            .map(|p| {
                json!({
                    "address": p.address.to_string(),
                    "client": p.client,
                    "downRate": p.download_rate,
                    "upRate": p.upload_rate,
                    "downloaded": p.downloaded,
                    "uploaded": p.uploaded,
                    "rttMs": p.rtt_ms,
                    "requests": p.requests,
                    "peerChoking": p.peer_choking,
                    "amChoking": p.am_choking,
                    "interested": p.interested,
                    "seed": p.seed,
                    "encrypted": p.encrypted,
                    "outgoing": p.outgoing,
                    "source": format!("{:?}", p.source).to_lowercase(),
                })
            })
            .collect();
        let tracker_urls: Vec<String> = s.trackers.iter().map(|t| t.url.clone()).collect();
        let trackers: Vec<Value> = s
            .trackers
            .iter()
            .map(|t| json!({ "url": t.url, "interval": t.interval, "failures": t.failures, "peers": t.peers, "seeders": t.seeders, "leechers": t.leechers, "error": t.error }))
            .collect();
        let web_seeds: Vec<Value> = s.web_seeds.iter().map(|w| json!({ "url": w.url, "active": w.active, "downRate": w.download_rate, "downloaded": w.downloaded, "error": w.error })).collect();
        let pieces = self.runtime.get(hash).and_then(|rt| rt.pieces.as_ref());
        Ok(json!({
            "hash": hash,
            "name": t.name(),
            "dir": entry.dir,
            "magnet": magnet_link(hash, &t.name(), &tracker_urls),
            "private": info.as_ref().is_some_and(|i| i.private),
            "pieceLength": info.as_ref().map_or(0, |i| i.piece_length),
            "pieceCount": pieces.map_or(0, |p| p.count()),
            "piecesHave": pieces.map_or(0, |p| p.set_count()),
            "pieces": pieces.map(|p| BASE64.encode(p.as_bytes())),
            "files": files,
            "peers": peers,
            "trackers": trackers,
            "webSeeds": web_seeds,
            "closeReasons": s.close_reasons,
            "activePieces": s.active_pieces,
            "endgame": s.endgame,
            "wasted": s.wasted,
            "hashFailures": s.hash_failures,
            "unverified": s.unverified,
            "connecting": s.connecting,
            "candidates": s.candidates,
            "downloadLimit": entry.download_limit,
            "uploadLimit": entry.upload_limit,
            "addedAt": entry.added_at,
            "completedAt": entry.completed_at,
            "warnings": rt_warnings,
        }))
    }

    // ---------- Engine events ---------- //

    /// Reacts to one engine event: keeps the library and piece maps current, and tells the app
    /// about the moments worth a notification.
    fn on_event(&mut self, event: Event) {
        let Some(ih) = event.torrent else { return };
        let hash = undercurrent::to_hex(&ih);
        let Ok(t) = self.torrent(&hash) else { return };
        match event.kind {
            // A magnet's metadata arrived: save it as a .torrent for future restarts
            EventKind::Metadata => {
                if let Some(info) = t.info() {
                    if !self.library.has_torrent(&hash) {
                        let mut bytes = b"d4:info".to_vec();
                        bytes.extend_from_slice(&info.raw);
                        bytes.push(b'e');
                        let _ = self.library.save_torrent(&hash, &bytes);
                    }
                    self.library.update(&hash, |e| e.name = info.name.clone());
                }
                self.init_pieces(&t);
                self.out.event("torrent", json!({ "hash": hash, "kind": "metadata", "name": t.name() }));
            }
            // Checking finished: fill the map from what's on disk
            EventKind::Ready | EventKind::Checked(_) => self.init_pieces(&t),
            EventKind::Piece(i) => {
                if let Some(map) = self.runtime.get_mut(&hash).and_then(|rt| rt.pieces.as_mut()) {
                    map.set(i);
                }
            }
            // Complete: notify only the first time, not on every restart
            EventKind::Done => {
                let first = self.library.get(&hash).is_some_and(|e| e.completed_at.is_none());
                self.library.update(&hash, |e| {
                    e.completed_at.get_or_insert(now_ms());
                });
                if let Some(map) = self.runtime.get_mut(&hash).and_then(|rt| rt.pieces.as_mut()) {
                    if t.progress() >= 1.0 {
                        map.set_all();
                    }
                }
                if first {
                    self.out.event("torrent", json!({ "hash": hash, "kind": "completed", "name": t.name() }));
                }
            }
            EventKind::Seeded => self.out.event("torrent", json!({ "hash": hash, "kind": "seeded", "name": t.name() })),
            EventKind::Warning(w) => {
                let rt = self.runtime.entry(hash).or_default();
                rt.warnings.push_back((now_ms(), w));
                while rt.warnings.len() > WARNINGS_KEPT {
                    rt.warnings.pop_front();
                }
            }
            EventKind::Error(e) => {
                self.runtime.entry(hash.clone()).or_default().error = Some(e.clone());
                self.out.event("torrent", json!({ "hash": hash, "kind": "error", "name": t.name(), "message": e }));
            }
            EventKind::Closed | EventKind::PortMapped(_) => {}
        }
    }

    /// (Re)builds a torrent's piece map from its resume file and complete files. Nothing
    /// happens until its metadata is known.
    fn init_pieces(&mut self, t: &Torrent) {
        let Some(info) = t.info() else { return };
        let hash = t.info_hash_hex();
        let mut map = PieceMap::new(info.piece_count());
        map.merge_resume(&self.library.resume_dir().join(format!("{hash}.resume")));
        map.merge_complete_files(&info, &t.files());

        // Keep any bits already seen live
        let rt = self.runtime.entry(hash).or_default();
        if let Some(old) = &rt.pieces {
            for i in 0..old.count() {
                if old.has(i) {
                    map.set(i);
                }
            }
        }
        rt.pieces = Some(map);
    }

    // ---------- Tick ---------- //

    /// Every `TICK`: run the queue, persist what changed, and push a snapshot.
    fn tick(&mut self) {
        self.watch_lock();
        self.apply_tide();
        // Everything reads as paused while the lock is closed, which the queue would misread
        if !self.lock_closed() {
            self.run_queue();
        }
        self.keep_paused();
        self.keep_awake();
        let _ = self.library.save_if_dirty();
        if self.last_dht_save.elapsed() >= DHT_SAVE_EVERY {
            self.save_dht_nodes();
        }
        let snapshot = self.snapshot();
        self.out.event("snapshot", snapshot);
    }

    /// Holds the Mac awake while anything downloads or checks, and for `AWAKE_AFTER` after, when
    /// the settings ask. A stuck download with nothing arriving lets it sleep again.
    fn keep_awake(&mut self) {
        let Some(engine) = self.engine.as_ref().filter(|_| self.settings.prevent_sleep) else {
            self.awake.hold(false);
            return;
        };
        if engine.stats().download_rate > 0 || engine.list().iter().any(|t| t.state() == State::Checking) {
            self.last_transfer = Some(Instant::now());
        }
        self.awake.hold(self.last_transfer.is_some_and(|at| at.elapsed() < AWAKE_AFTER));
    }

    // ---------- Slow tide ---------- //

    /// Slow tide's state right now, from the settings and the local clock.
    fn tide(&self) -> TideState {
        let s = &self.settings;
        let plan = TidePlan { manual: s.slow_tide, follow: s.slow_schedule, hours: &s.slow_hours, override_: s.slow_override.map(|on| (on, s.slow_override_until)) };
        tide::state_at(&plan, now_ms(), tide::local_hour_of_week)
    }

    /// Gives the engine the limits slow tide calls for, when they changed.
    fn apply_tide(&mut self) {
        let slow = self.tide().on;
        if self.slow_applied == Some(slow) {
            return;
        }
        if let Some(engine) = &self.engine {
            engine.set_limits(self.settings.limits(slow));
            self.slow_applied = Some(slow);
        }
    }

    // ---------- VPN lock ---------- //

    /// Whether the VPN lock is on and its interface is down.
    fn lock_closed(&self) -> bool {
        self.lock.as_ref().is_some_and(|l| l.address().is_none())
    }

    /// Follows the locked interface: closes the network when it loses its address, and reopens
    /// it (bound to the new address) when it gets one back or the address changes.
    fn watch_lock(&mut self) {
        let (Some(lock), Some(engine)) = (&self.lock, &self.engine) else { return };
        let Some(before) = lock.refresh() else { return };
        let iface = lock.interface.clone();
        match lock.address() {
            None => {
                engine.disconnect();
                self.out.event("warning", json!({ "message": format!("{iface} went down. Transfers stopped until it's back.") }));
            }
            Some(ip) => {
                // Close first: the listener and DHT were bound to the old address, or to none
                engine.disconnect();
                engine.reconnect();
                let what = if before.is_none() { "is back" } else { "changed address" };
                self.out.event("warning", json!({ "message": format!("{iface} {what} ({ip}). Transfers resumed.") }));
            }
        }
    }

    /// Keeps what the user paused (or the queue holds) paused. Undercurrent's reconnect resumes
    /// every torrent, so this puts the rest back on the next tick.
    fn keep_paused(&self) {
        for e in self.library.entries().into_iter().filter(|e| e.paused || e.queued) {
            if let Ok(t) = self.torrent(&e.hash)
                && !matches!(t.state(), State::Paused | State::Closed)
            {
                t.pause();
            }
        }
    }

    // ---------- Queue ---------- //

    /// Unfinished downloads currently allowed to run (not paused by anyone, not waiting for a
    /// file choice), as (added at, hash).
    fn active_downloads(&self) -> Vec<(u64, String)> {
        let Ok(engine) = self.engine() else { return Vec::new() };
        self.library
            .entries()
            .into_iter()
            .filter(|e| !e.paused && !e.queued)
            .filter(|e| parse_hash(&e.hash).and_then(|ih| engine.get(&ih)).is_some_and(|t| matches!(t.state(), State::Metadata | State::Checking | State::Downloading)))
            .map(|e| (e.added_at, e.hash))
            .collect()
    }

    fn queue_full(&self) -> bool {
        let max = self.settings.max_active_downloads;
        max > 0 && self.active_downloads().len() >= max
    }

    /// Keeps at most `max_active_downloads` running: the newest extras wait as queued, and the
    /// oldest queued start when a slot frees. With no limit, everything queued starts.
    fn run_queue(&mut self) {
        if self.engine.is_none() {
            return;
        }
        let max = self.settings.max_active_downloads;
        let mut active = self.active_downloads();
        let mut queued: Vec<(u64, String)> = self.library.entries().into_iter().filter(|e| e.queued && !e.paused).map(|e| (e.added_at, e.hash)).collect();
        queued.sort();

        // Over the limit: send the newest back to the queue
        if max > 0 && active.len() > max {
            active.sort();
            for (_, hash) in active.split_off(max) {
                if let Ok(t) = self.torrent(&hash) {
                    t.pause();
                }
                self.library.update(&hash, |e| e.queued = true);
            }
            return;
        }

        // Room to spare: start the oldest waiting
        let free = if max == 0 { usize::MAX } else { max - active.len() };
        for (_, hash) in queued.into_iter().take(free) {
            if let Ok(t) = self.torrent(&hash) {
                t.resume();
            }
            self.library.update(&hash, |e| e.queued = false);
        }
    }

    /// Every torrent's summary and the engine's totals, as pushed to the app each tick.
    fn snapshot(&self) -> Value {
        let mut torrents = Vec::new();
        for entry in self.library.entries() {
            let rt = self.runtime.get(&entry.hash);
            let error = rt.and_then(|r| r.error.clone());
            let Ok(t) = self.torrent(&entry.hash) else {
                // In the library but not running: show it as errored so it can be removed
                torrents.push(json!({ "hash": entry.hash, "name": entry.name, "state": "error", "error": error.unwrap_or_else(|| "Not running.".into()), "dir": entry.dir, "addedAt": entry.added_at, "progress": 0, "size": 0, "totalSize": 0, "done": 0, "downloaded": 0, "uploaded": 0, "downRate": 0, "upRate": 0, "peers": 0, "seeds": 0, "connecting": 0, "ratio": 0, "seedSeconds": 0, "hasMetadata": false, "queued": false, "paused": entry.paused }));
                continue;
            };
            let s = t.stats();
            let files = t.files();
            let size: u64 = files.iter().filter(|f| f.selected).map(|f| f.length).sum();
            let done: u64 = files.iter().filter(|f| f.selected).map(|f| f.downloaded).sum();

            // The app's state names, with the queue and errors folded in
            let state = match s.state {
                State::Paused if error.is_some() => "error",
                State::Paused if entry.queued => "queued",
                // Held by a closed VPN lock: nothing that needs the network can move
                State::Paused | State::Metadata | State::Downloading | State::Seeding if !entry.paused && self.lock_closed() => "offline",
                other => state_name(other),
            };
            torrents.push(json!({
                "hash": entry.hash,
                "name": t.name(),
                "state": state,
                "error": error,
                "progress": s.progress,
                "size": size,
                "totalSize": files.iter().map(|f| f.length).sum::<u64>(),
                "done": done,
                "downloaded": s.total_downloaded,
                "uploaded": s.total_uploaded,
                "downRate": s.download_rate,
                "upRate": s.upload_rate,
                "peers": s.peers.len(),
                "seeds": s.peers.iter().filter(|p| p.seed).count(),
                "connecting": s.connecting,
                "ratio": s.ratio,
                "seedSeconds": s.seed_seconds,
                "dir": entry.dir,
                "addedAt": entry.added_at,
                "completedAt": entry.completed_at,
                "hasMetadata": !files.is_empty(),
                "fileCount": files.len(),
                "queued": entry.queued,
                "paused": entry.paused,
                "downloadLimit": entry.download_limit,
                "uploadLimit": entry.upload_limit,
            }));
        }
        let engine = self.engine.as_ref().map(|e| {
            let s = e.stats();
            json!({ "downRate": s.download_rate, "upRate": s.upload_rate, "peers": s.peers, "dhtNodes": s.dht_nodes, "port": s.port, "announcePort": s.announce_port, "sessionDownloaded": s.downloaded, "sessionUploaded": s.uploaded, "halfOpen": s.half_open })
        });
        let lock = self.lock.as_ref().map(|l| json!({ "interface": l.interface, "address": l.address().map(|ip| ip.to_string()) }));
        json!({ "at": now_ms(), "engine": engine, "engineError": self.engine_error, "torrents": torrents, "slowTide": self.tide(), "lock": lock, "awake": self.awake.held() })
    }
}

// ---------- Helpers ---------- //

/// A source read into memory: the hash and name, plus the `.torrent` bytes or the magnet link.
struct Loaded {
    info_hash: InfoHash,
    name: String,
    trackers: Vec<String>,
    bytes: Option<Vec<u8>>,
    magnet: Option<String>,
}

/// Reads and parses a torrent source.
fn load_source(source: &TorrentSource) -> Result<Loaded, String> {
    let bytes = match source {
        TorrentSource::File { path } => std::fs::read(path).map_err(|e| format!("Couldn't read {path}: {e}"))?,
        TorrentSource::Bytes { base64 } => BASE64.decode(base64.trim()).map_err(|_| "That file isn't readable as a torrent.".to_string())?,
        TorrentSource::Magnet { uri } => {
            let m = undercurrent::parse_magnet(uri.trim()).map_err(|e| format!("That magnet link isn't valid: {}", e.0))?;
            let name = m.name.clone().unwrap_or_else(|| undercurrent::to_hex(&m.info_hash));
            return Ok(Loaded { info_hash: m.info_hash, name, trackers: m.trackers, bytes: None, magnet: Some(uri.trim().to_string()) });
        }
    };
    let m = undercurrent::parse_torrent(&bytes).map_err(|e| format!("That isn't a valid torrent file: {}", e.0))?;
    Ok(Loaded { info_hash: m.info.info_hash, name: m.info.name, trackers: m.trackers, bytes: Some(bytes), magnet: None })
}

/// Decodes request parameters, with an error naming what was wrong.
fn parse<T: for<'de> Deserialize<'de>>(v: Value) -> Result<T, String> {
    serde_json::from_value(v).map_err(|e| format!("Bad request: {e}"))
}

/// Shallow-merges `extra`'s keys into `v`.
fn merge(v: &mut Value, extra: Value) {
    if let (Some(a), Value::Object(b)) = (v.as_object_mut(), extra) {
        a.extend(b);
    }
}

/// 40 hex characters to an info hash.
pub fn parse_hash(hex: &str) -> Option<InfoHash> {
    if hex.len() != 40 {
        return None;
    }
    let mut out = [0u8; 20];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(hex.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}

fn state_name(s: State) -> &'static str {
    match s {
        State::Metadata => "metadata",
        State::Waiting => "waiting",
        State::Checking => "checking",
        State::Downloading => "downloading",
        State::Seeding => "seeding",
        State::Done => "done",
        State::Paused => "paused",
        State::Closed => "closed",
    }
}

/// Whether every selected byte is verified.
fn is_complete(t: &Torrent) -> bool {
    t.info().is_some() && t.progress() >= 1.0
}

/// A magnet link with the name and trackers.
fn magnet_link(hash: &str, name: &str, trackers: &[String]) -> String {
    let mut s = format!("magnet:?xt=urn:btih:{hash}&dn={}", percent_encode(name));
    for t in trackers {
        s.push_str("&tr=");
        s.push_str(&percent_encode(t));
    }
    s
}

fn percent_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_round_trip_through_hex() {
        let ih = [0xab; 20];
        assert_eq!(parse_hash(&undercurrent::to_hex(&ih)), Some(ih));
        assert_eq!(parse_hash("abc"), None);
        assert_eq!(parse_hash(&"zz".repeat(20)), None);
    }

    #[test]
    fn magnet_links_escape_names_and_trackers() {
        let m = magnet_link("00", "a b&c", &["udp://t:1/announce".into()]);
        assert_eq!(m, "magnet:?xt=urn:btih:00&dn=a%20b%26c&tr=udp%3A%2F%2Ft%3A1%2Fannounce");
    }
}
