/**
 * The main process's logic, independent of Electrobun: it answers the UI's calls (mostly by
 * forwarding them to undercurrentd), turns engine events into pushes and notifications, and handles
 * torrents opened from outside the app.
 *
 * Electrobun (src/bun/index.ts) and the browser test harness (scripts/dev-web.ts) each give it
 * a `NativeHost` and a push function, so the same code runs in both.
 */

import { basename, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import type { Api, ApiMethod, AppInfo, CreateParams, DefaultApp, EngineStatus, LockState, Push, PushName, Settings, Snapshot, TorrentEvent, TorrentSource } from "../shared/types";
import { EngineClient, EngineError } from "./engine-client";

// ---------- Host ---------- //

/** What the backend needs from the desktop: dialogs, the file manager, the clipboard, alerts. */
export interface NativeHost {
	pickTorrentFiles(): Promise<string[]>;
	pickFolder(start?: string): Promise<string | null>;
	pickContent(): Promise<string | null>;
	openPath(path: string): boolean;
	revealPath(path: string): void;
	readClipboard(): string | null;
	writeClipboard(text: string): void;
	notify(title: string, body: string): void;
	defaultApp(): DefaultApp;
	makeDefaultApp(): DefaultApp;
}

export type PushFn = <N extends PushName>(name: N, data: Push[N]) => void;

export interface BackendOptions {
	engine: EngineClient;
	native: NativeHost;
	push: PushFn;
	info: Omit<AppInfo, "engineVersion">;
}

// ---------- Backend ---------- //

/** Dispatches UI calls and engine events. One per app. */
export class Backend {
	private readonly engine: EngineClient;
	private readonly native: NativeHost;
	private readonly push: PushFn;
	private readonly info: Omit<AppInfo, "engineVersion">;
	/** The latest settings, for notification preferences. */
	private settings: Settings | null = null;
	/** The latest snapshot, for torrent names and quick answers. */
	private lastSnapshot: Snapshot | null = null;
	/** Torrents opened from outside before the UI asked for them. */
	private pendingSources: TorrentSource[] = [];
	/** Whether the UI has loaded and asked for pending sources; after that, they're pushed. */
	private uiReady = false;

	constructor(options: BackendOptions) {
		this.engine = options.engine;
		this.native = options.native;
		this.push = options.push;
		this.info = options.info;
	}

	/** Whether slow tide is on, for the tray's check mark. */
	get slowTide(): boolean {
		return this.lastSnapshot?.slowTide?.on ?? false;
	}

	/** Flips slow tide by hand (from the tray). */
	async toggleSlowTide(): Promise<void> {
		await this.call("setSlowTide", { on: !this.slowTide });
	}

	/** Totals for the tray title: the latest snapshot's engine rates. */
	get totals(): { down: number; up: number; active: number } {
		const e = this.lastSnapshot?.engine;
		const active = this.lastSnapshot?.torrents.filter((t) => t.state === "downloading").length ?? 0;
		return { down: e?.downRate ?? 0, up: e?.upRate ?? 0, active };
	}

	// ---------- UI calls ---------- //

	/**
	 * Runs one UI call. Engine methods pass straight through to undercurrentd; the rest are native
	 * or composed here. Throws `EngineError` with a sentence fit for the user.
	 */
	async call<M extends ApiMethod>(method: M, params: Api[M]["params"]): Promise<Api[M]["result"]> {
		const p = params as never;
		switch (method) {
			// Composed or native
			case "appInfo":
				return { ...this.info, engineVersion: this.engine.version } as Api[M]["result"];
			case "create":
				return (await this.create(p)) as Api[M]["result"];
			case "exportTorrent":
				return (await this.exportTorrent((p as { hash: string }).hash)) as Api[M]["result"];
			case "pickTorrentFiles":
				return (await this.native.pickTorrentFiles()) as Api[M]["result"];
			case "pickFolder":
				return (await this.native.pickFolder((p as { start?: string } | undefined)?.start)) as Api[M]["result"];
			case "pickContent":
				return (await this.native.pickContent()) as Api[M]["result"];
			case "openPath":
				return this.native.openPath((p as { path: string }).path) as Api[M]["result"];
			case "revealPath":
				this.native.revealPath((p as { path: string }).path);
				return null as Api[M]["result"];
			case "readClipboard":
				return this.native.readClipboard() as Api[M]["result"];
			case "writeClipboard":
				this.native.writeClipboard((p as { text: string }).text);
				return null as Api[M]["result"];
			case "defaultApp":
				return this.native.defaultApp() as Api[M]["result"];
			case "makeDefaultApp":
				return this.native.makeDefaultApp() as Api[M]["result"];
			case "takePendingSources": {
				this.uiReady = true;
				const sources = this.pendingSources;
				this.pendingSources = [];
				return sources as Api[M]["result"];
			}

			// Settings are cached for notifications
			case "getSettings":
			case "setSettings":
			case "setSlowTide": {
				const result = await this.engine.request(method, params);
				this.settings = method === "getSettings" ? (result as Settings) : (result as { settings: Settings }).settings;
				return result as Api[M]["result"];
			}

			// Everything else is undercurrentd's
			case "snapshot":
			case "inspect":
			case "add":
			case "pause":
			case "resume":
			case "recheck":
			case "remove":
			case "select":
			case "setLimits":
			case "addPeer":
			case "details":
			case "interfaces":
				return (await this.engine.request(method, params)) as Api[M]["result"];
			default:
				throw new EngineError(`Unknown call "${String(method)}".`);
		}
	}

	/** Builds a torrent. Without an output path, it's written next to the content. */
	private async create(params: CreateParams): Promise<Api["create"]["result"]> {
		const out = params.out ?? uniquePath(join(dirname(params.path), `${basename(params.path)}.torrent`));
		// Hashing large folders takes a while: no timeout
		return this.engine.request("create", { ...params, out }, 0);
	}

	/** Saves a torrent's .torrent into a folder the user picks. */
	private async exportTorrent(hash: string): Promise<string | null> {
		const folder = await this.native.pickFolder();
		if (!folder) return null;
		const name = this.lastSnapshot?.torrents.find((t) => t.hash === hash)?.name ?? hash;
		const path = uniquePath(join(folder, `${safeFileName(name)}.torrent`));
		await this.engine.request("exportTorrent", { hash, path });
		return path;
	}

	// ---------- Engine events ---------- //

	/** Turns an undercurrentd event into pushes and notifications. */
	onEngineEvent(name: string, data: unknown): void {
		switch (name) {
			case "ready":
				this.settings = (data as { settings: Settings }).settings;
				break;
			case "snapshot": {
				const previous = this.lastSnapshot;
				this.lastSnapshot = data as Snapshot;
				this.push("snapshot", this.lastSnapshot);
				this.noticeLock(previous?.lock, this.lastSnapshot.lock);
				break;
			}
			case "torrent":
				this.onTorrentEvent(data as TorrentEvent);
				break;
			case "warning":
				// Shown in the status bar via the next snapshot; logged here
				console.warn("undercurrentd:", (data as { message: string }).message);
				break;
		}
	}

	onEngineStatus(status: EngineStatus): void {
		this.push("engineStatus", status);
	}

	/** Notifies when the VPN lock's interface goes down or comes back, since transfers stop and start with it. */
	private noticeLock(before: LockState | null | undefined, now: LockState | null | undefined): void {
		if (!before || !now || before.interface !== now.interface) return;
		if (before.address && !now.address) {
			this.native.notify("Transfers stopped", `${now.interface} went down. Nothing connects until it's back.`);
		} else if (!before.address && now.address) {
			this.native.notify("Transfers resumed", `${now.interface} is back (${now.address}).`);
		}
	}

	/** Pushes a torrent event, and notifies for the ones that deserve it. */
	private onTorrentEvent(e: TorrentEvent): void {
		this.push("torrentEvent", e);
		if (e.kind === "completed" && this.settings?.notifyOnComplete !== false) {
			this.native.notify("Download complete", e.name);
		} else if (e.kind === "error") {
			this.native.notify("Download stopped", `${e.name}: ${e.message ?? "an error occurred"}`);
		}
	}

	// ---------- Opened from outside ---------- //

	/**
	 * Handles a URL the OS opened the app with: a magnet link, or a .torrent as a file:// URL.
	 * Before the UI is ready they wait in `pendingSources`.
	 */
	openUrl(url: string): void {
		const source = sourceFromUrl(url);
		if (!source) return;
		if (this.uiReady) this.push("openSources", { sources: [source] });
		else this.pendingSources.push(source);
	}
}

// ---------- Helpers ---------- //

/** A magnet link or a file:// URL to a .torrent, as a source; anything else is ignored. */
export function sourceFromUrl(url: string): TorrentSource | null {
	if (url.startsWith("magnet:")) return { kind: "magnet", uri: url };
	if (url.startsWith("file://")) {
		const path = decodeURIComponent(new URL(url).pathname);
		return path.toLowerCase().endsWith(".torrent") ? { kind: "file", path } : null;
	}
	return null;
}

/** A name safe to use as a file name on any platform. */
export function safeFileName(name: string): string {
	const cleaned = name.replace(/[/\\:*?"<>|\u0000-\u001f]/g, "_").trim();
	return cleaned.slice(0, 180) || "torrent";
}

/** `path`, or `path` with " 2", " 3"… before the extension if it already exists. */
export function uniquePath(path: string): string {
	if (!existsSync(path)) return path;
	const dot = path.lastIndexOf(".");
	const [stem, ext] = dot > path.lastIndexOf("/") ? [path.slice(0, dot), path.slice(dot)] : [path, ""];
	for (let n = 2; ; n++) {
		const candidate = `${stem} ${n}${ext}`;
		if (!existsSync(candidate)) return candidate;
	}
}
