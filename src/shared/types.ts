/**
 * The contract between the UI, the Bun main process and the undercurrentd engine process.
 *
 * Engine data (snapshots, details, settings) passes through Bun unchanged, so these types
 * describe undercurrentd's JSON exactly. `Api` lists every call the UI can make and `Push` every
 * message the main process sends to the UI.
 */

// ---------- Torrents ---------- //

/**
 * Riptide's states, plus `queued` (paused by the download queue), `offline` (held by the VPN
 * lock while its interface is down) and `error`.
 */
export type TorrentState = "metadata" | "waiting" | "checking" | "downloading" | "seeding" | "done" | "paused" | "queued" | "offline" | "error" | "closed";

/** One torrent in a snapshot. Byte counts are bytes; rates are bytes per second. */
export interface TorrentSummary {
	hash: string;
	name: string;
	state: TorrentState;
	error?: string | null;
	/** Fraction of the selected bytes verified, 0 to 1. */
	progress: number;
	/** Bytes of the selected files. */
	size: number;
	/** Bytes of every file. */
	totalSize: number;
	/** Verified bytes of the selected files. */
	done: number;
	/** All-time totals, including earlier sessions. */
	downloaded: number;
	uploaded: number;
	downRate: number;
	upRate: number;
	peers: number;
	seeds: number;
	connecting: number;
	ratio: number;
	seedSeconds: number;
	dir: string;
	/** Unix milliseconds. */
	addedAt: number;
	completedAt?: number | null;
	hasMetadata: boolean;
	fileCount?: number;
	queued: boolean;
	paused: boolean;
	downloadLimit?: number;
	uploadLimit?: number;
}

/** Engine-wide totals. */
export interface EngineTotals {
	downRate: number;
	upRate: number;
	peers: number;
	dhtNodes: number;
	port: number;
	announcePort: number;
	sessionDownloaded: number;
	sessionUploaded: number;
	halfOpen: number;
}

/** Whether slow tide's limits are in force, and why. */
export interface SlowTideState {
	on: boolean;
	/** Set by the schedule (no switch by hand is in force). */
	scheduled: boolean;
	/** Switched by hand against the schedule, until `nextChange`. */
	overridden: boolean;
	/** Unix ms of the schedule's next change, while it's followed. */
	nextChange: number | null;
}

/** The VPN lock's interface and its address; a null address means it's down and nothing connects. */
export interface LockState {
	interface: string;
	address: string | null;
}

/** What undercurrentd pushes twice a second. `engine` is null when the engine failed to start. */
export interface Snapshot {
	at: number;
	engine: EngineTotals | null;
	engineError: string | null;
	torrents: TorrentSummary[];
	slowTide?: SlowTideState;
	/** Null when no interface is locked. */
	lock?: LockState | null;
	/** The Mac is being kept awake for transfers. */
	awake?: boolean;
}

/** A network interface, for choosing the VPN lock's. */
export interface NetworkInterface {
	name: string;
	addresses: string[];
	/** Named like a tunnel: probably a VPN. */
	vpn: boolean;
	loopback: boolean;
}

export interface FileInfo {
	index: number;
	/** Relative to the torrent's save folder. */
	path: string;
	length: number;
	selected: boolean;
	downloaded: number;
}

export interface PeerInfo {
	address: string;
	client: string;
	downRate: number;
	upRate: number;
	downloaded: number;
	uploaded: number;
	rttMs: number;
	requests: number;
	peerChoking: boolean;
	amChoking: boolean;
	interested: boolean;
	seed: boolean;
	encrypted: boolean;
	outgoing: boolean;
	source: "tracker" | "dht" | "pex" | "manual" | "incoming";
}

/** An HTTP mirror of a torrent's files (BEP 19). */
export interface WebSeedInfo {
	url: string;
	/** Downloading now. */
	active: boolean;
	downRate: number;
	downloaded: number;
	/** Why it last stopped, while that still stands. */
	error: string | null;
}

export interface TrackerInfo {
	url: string;
	/** Seconds between announces; 0 until the first reply. */
	interval: number;
	failures: number;
	peers: number;
	seeders: number | null;
	leechers: number | null;
	error: string | null;
}

/** Everything the details drawer shows. */
export interface Details {
	hash: string;
	name: string;
	dir: string;
	magnet?: string;
	private?: boolean;
	pieceLength?: number;
	pieceCount?: number;
	piecesHave?: number;
	/** Verified pieces as a base64 bitfield in wire order. */
	pieces?: string | null;
	files: FileInfo[];
	peers: PeerInfo[];
	trackers: TrackerInfo[];
	webSeeds?: WebSeedInfo[];
	closeReasons?: Record<string, number>;
	activePieces?: number;
	endgame?: boolean;
	wasted?: number;
	hashFailures?: number;
	unverified?: number;
	connecting?: number;
	candidates?: number;
	downloadLimit?: number;
	uploadLimit?: number;
	addedAt?: number;
	completedAt?: number | null;
	warnings: { at: number; message: string }[];
}

// ---------- Settings ---------- //

export type EncryptionMode = "prefer" | "plaintext" | "require" | "off";

export interface Settings {
	downloadDir: string;
	port: number;
	/** Accept connections from peers; off, only connect out. */
	acceptIncoming: boolean;
	encryption: EncryptionMode;
	dht: boolean;
	pex: boolean;
	portMapping: boolean;
	uploadSlots: number;
	maxPeers: number;
	/** Connection attempts in progress at once, engine-wide. */
	maxHalfOpen: number;
	/** Memory for pieces in progress, per torrent, in bytes. */
	maxBufferBytes: number;
	/** Web seeds (HTTP mirrors a torrent lists) downloaded from at once, per torrent; 0 never. */
	webSeeds: number;
	/** Bytes per second; 0 is unlimited. */
	downloadLimit: number;
	uploadLimit: number;
	seedEnabled: boolean;
	/** 0 is no limit. */
	seedRatio: number;
	/** 0 is no limit. */
	seedMinutes: number;
	/** 0 is no limit. */
	maxActiveDownloads: number;
	notifyOnComplete: boolean;
	/** Keep the Mac from sleeping while downloads move. */
	preventSleep: boolean;
	threads: number;
	/** Slow tide's limits in bytes per second; 0 is unlimited. */
	slowDownloadLimit: number;
	slowUploadLimit: number;
	/** Slow tide switched on by hand (when there's no schedule). */
	slowTide: boolean;
	/** A switch by hand against the schedule, and the Unix ms it holds until. */
	slowOverride: boolean | null;
	slowOverrideUntil: number;
	/** Switch slow tide on during `slowHours`. */
	slowSchedule: boolean;
	/** 168 hours, Monday 00:00 first; true is slow. */
	slowHours: boolean[];
	/** The VPN lock's interface; empty for any. */
	bindInterface: string;
	/** Offer magnet links found on the clipboard. */
	clipboardMagnets: boolean;
}

// ---------- Adding and creating ---------- //

/** Where a torrent comes from. */
export type TorrentSource = { kind: "file"; path: string } | { kind: "bytes"; base64: string; fileName?: string } | { kind: "magnet"; uri: string };

/** A torrent read without adding it, for the add dialog. */
export interface InspectResult {
	hash: string;
	name: string;
	isMagnet: boolean;
	/** Null for a magnet, whose size isn't known yet. */
	size: number | null;
	files: { index: number; path: string; length: number }[];
	trackers: string[];
	private: boolean;
	pieceLength?: number;
	pieceCount?: number;
	alreadyAdded: boolean;
}

export interface AddParams {
	source: TorrentSource;
	dir?: string;
	paused?: boolean;
	files?: number[];
	metadataOnly?: boolean;
	seedMode?: boolean;
}

export interface AddResult {
	hash: string;
	name: string;
	existing: boolean;
	queued?: boolean;
}

export interface CreateParams {
	/** The file or folder to share. */
	path: string;
	/** Where to write the .torrent; the main process fills this in when it's omitted. */
	out?: string;
	trackers: string[];
	private: boolean;
	comment?: string;
	pieceKb?: number;
	seed: boolean;
}

export interface CreateResult {
	hash: string;
	out: string;
	magnet: string;
}

/** Moments the UI reacts to (and the main process notifies about). */
export interface TorrentEvent {
	hash: string;
	kind: "metadata" | "completed" | "seeded" | "error";
	name: string;
	message?: string;
}

export interface AppInfo {
	version: string;
	engineVersion: string | null;
	platform: string;
	dataDir: string;
	/** "electrobun" in the app, "web" in the browser test harness. */
	host: "electrobun" | "web";
}

/** Whether Riptide is the system's default app for torrents. */
export interface DefaultApp {
	/** False where it can't be read or set (not macOS, or not running from the app bundle). */
	supported: boolean;
	/** Opens .torrent files. */
	torrents: boolean;
	/** Opens magnet links. */
	magnets: boolean;
}

/** The engine process's health, as the main process sees it. */
export interface EngineStatus {
	running: boolean;
	error: string | null;
	restarts: number;
}

// ---------- Calls and pushes ---------- //

/** Every call the UI can make: method name to params and result. */
export interface Api {
	appInfo: { params: void; result: AppInfo };
	snapshot: { params: void; result: Snapshot };
	getSettings: { params: void; result: Settings };
	setSettings: { params: Settings; result: { settings: Settings; restarted: boolean } };
	/** Switches slow tide on or off by hand; with a schedule, until its next change. */
	setSlowTide: { params: { on: boolean }; result: { settings: Settings; slowTide: SlowTideState } };
	/** Interfaces that are up with a usable address, VPNs first. */
	interfaces: { params: void; result: NetworkInterface[] };
	inspect: { params: { source: TorrentSource }; result: InspectResult };
	add: { params: AddParams; result: AddResult };
	pause: { params: { hashes: string[] }; result: null };
	resume: { params: { hashes: string[] }; result: null };
	recheck: { params: { hashes: string[] }; result: null };
	remove: { params: { hashes: string[]; deleteFiles: boolean }; result: null };
	select: { params: { hash: string; files: number[] }; result: null };
	setLimits: { params: { hash: string; download: number; upload: number }; result: null };
	addPeer: { params: { hash: string; address: string }; result: null };
	details: { params: { hash: string }; result: Details };
	create: { params: CreateParams; result: CreateResult };
	/** Saves a torrent's .torrent into a folder the user picks. Null when cancelled. */
	exportTorrent: { params: { hash: string }; result: string | null };
	/** Native file picker for .torrent files. */
	pickTorrentFiles: { params: void; result: string[] };
	/** Native folder picker; null when cancelled. */
	pickFolder: { params: { start?: string }; result: string | null };
	/** File-or-folder picker for creating a torrent; null when cancelled. */
	pickContent: { params: void; result: string | null };
	openPath: { params: { path: string }; result: boolean };
	revealPath: { params: { path: string }; result: null };
	readClipboard: { params: void; result: string | null };
	writeClipboard: { params: { text: string }; result: null };
	defaultApp: { params: void; result: DefaultApp };
	/** Makes Riptide the default for .torrent files and magnet links. */
	makeDefaultApp: { params: void; result: DefaultApp };
	/** Torrents opened from outside before the UI was ready to show them. */
	takePendingSources: { params: void; result: TorrentSource[] };
}

export type ApiMethod = keyof Api;
export type ApiParams<M extends ApiMethod> = Api[M]["params"];
export type ApiResult<M extends ApiMethod> = Api[M]["result"];

/** Commands from the app menu and tray, run by the UI. */
export type UiCommand = "addFile" | "addMagnet" | "create" | "settings" | "pauseAll" | "resumeAll" | "selectAll" | "find" | "palette" | "slowTide";

/** Every message the main process pushes to the UI. */
export interface Push {
	snapshot: Snapshot;
	torrentEvent: TorrentEvent;
	engineStatus: EngineStatus;
	command: { name: UiCommand };
	/** Torrents opened from outside (Finder, a magnet link): show the add dialog for them. */
	openSources: { sources: TorrentSource[] };
}

export type PushName = keyof Push;

/** The single Electrobun RPC schema: one generic call and one generic push. */
export interface WireCall {
	method: ApiMethod;
	params: unknown;
}

export interface WirePush {
	name: PushName;
	data: unknown;
}
