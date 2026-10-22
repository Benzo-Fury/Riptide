/**
 * Riptide's main process under Electrobun: starts the bundled undercurrentd engine, opens the window,
 * and connects the UI, the app menu, the tray and the OS (magnet links, .torrent files) to the
 * backend.
 */

import Electrobun, { ApplicationMenu, BrowserView, BrowserWindow, PATHS, Tray, Updater, Utils, type RPCSchema } from "electrobun/main";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ApiMethod, Push, PushName, UiCommand, WireCall, WirePush } from "../shared/types";
import { Backend, type NativeHost } from "./backend";
import { DefaultHandlers } from "./default-app";
import { EngineClient } from "./engine-client";
import { formatRate } from "../shared/format";
import { setMinimumSize } from "./window-limits";

// ---------- RPC schema ---------- //

/**
 * One generic call (UI → main) and one generic push (main → UI); types live in Api and Push.
 * The request isn't named `call`: Electrobun's `rpc.request` proxy wraps a function, so
 * `request.call` would be Function.prototype.call and every request would lose its name.
 */
type RiptideRPC = {
	bun: RPCSchema<{
		requests: { api: { params: WireCall; response: unknown } };
		messages: {};
	}>;
	webview: RPCSchema<{
		requests: {};
		messages: { push: WirePush };
	}>;
};

// ---------- Paths ---------- //

/** The undercurrentd bundled in Resources/app/bin, or an override for development. */
function engineBinary(): string {
	const candidates = [process.env.UNDERCURRENTD_PATH, join(PATHS.RESOURCES_FOLDER, "app/bin/undercurrentd")].filter(Boolean) as string[];
	return candidates.find((p) => existsSync(p)) ?? candidates[candidates.length - 1]!;
}

const dataDir = join(Utils.paths.userData, "engine");
mkdirSync(dataDir, { recursive: true });

// ---------- Native host ---------- //

const handlers = new DefaultHandlers();

/** Electrobun's dialogs, file manager, clipboard and notifications, and LaunchServices. */
const native: NativeHost = {
	async pickTorrentFiles() {
		const paths = await Utils.openFileDialog({ startingFolder: Utils.paths.downloads, allowedFileTypes: "torrent", canChooseFiles: true, canChooseDirectory: false, allowsMultipleSelection: true });
		return paths.filter((p) => p !== "");
	},
	async pickFolder(start) {
		const paths = await Utils.openFileDialog({ startingFolder: start || Utils.paths.downloads, canChooseFiles: false, canChooseDirectory: true, allowsMultipleSelection: false });
		return paths.find((p) => p !== "") ?? null;
	},
	async pickContent() {
		const paths = await Utils.openFileDialog({ startingFolder: Utils.paths.home, canChooseFiles: true, canChooseDirectory: true, allowsMultipleSelection: false });
		return paths.find((p) => p !== "") ?? null;
	},
	openPath: (path) => Utils.openPath(path),
	revealPath: (path) => {
		Utils.showItemInFolder(path);
	},
	readClipboard: () => Utils.clipboardReadText(),
	writeClipboard: (text) => Utils.clipboardWriteText(text),
	notify: (title, body) => Utils.showNotification({ title, body }),
	defaultApp: () => handlers.status(),
	makeDefaultApp: () => handlers.makeDefault(),
};

// ---------- Wiring ---------- //

/** Sends a push to the UI, if the window exists. */
let push = <N extends PushName>(_name: N, _data: Push[N]): void => {};

const engine = new EngineClient({
	binary: engineBinary(),
	stateDir: dataDir,
	onEvent: (name, data) => backend.onEngineEvent(name, data),
	onStatus: (status) => backend.onEngineStatus(status),
	log: (line) => console.log(line),
});

const backend = new Backend({
	engine,
	native,
	push: (name, data) => push(name, data),
	info: { version: "0.1.0", platform: process.platform, dataDir, host: "electrobun" },
});

// The UI's calls, with long-running ones (create) allowed to take their time
const rpc = BrowserView.defineRPC<RiptideRPC>({
	maxRequestTime: 60 * 60 * 1000,
	handlers: {
		requests: {
			api: ({ method, params }: WireCall) => {
				// RIPTIDE_DEBUG=1 traces every UI call, to check flows without looking at the window
				if (!process.env.RIPTIDE_DEBUG) return backend.call(method as ApiMethod, params as never);
				const started = Date.now();
				console.log(`[ui] ${method}`);
				return backend.call(method as ApiMethod, params as never).then(
					(r) => (console.log(`[ui] ${method} ok ${Date.now() - started}ms`), r),
					(e) => {
						console.log(`[ui] ${method} failed ${Date.now() - started}ms: ${e instanceof Error ? e.message : e}`);
						throw e;
					},
				);
			},
		},
		messages: {},
	},
});

// ---------- Window ---------- //

let window: BrowserWindow | null = null;

const DEV_SERVER_URL = "http://localhost:5183";

/**
 * The view's URL: the Vite dev server (with HMR) in dev builds when it is running, otherwise
 * the bundled view. Stable and canary builds always use the bundle.
 */
async function viewUrl(): Promise<string> {
	if ((await Updater.localInfo.channel()) === "dev") {
		try {
			await fetch(DEV_SERVER_URL, { method: "HEAD" });
			console.log(`[ui] HMR enabled: ${DEV_SERVER_URL}`);
			return DEV_SERVER_URL;
		} catch {
			// No dev server running: use the bundled view
		}
	}
	return "views://mainview/index.html";
}

/** The smallest the window may be: the sidebar beside the compact table, and room for a torrent's details under its row. */
const MIN_WINDOW = { width: 900, height: 600 };

/** Opens the main window, or brings it back if it exists. */
async function showWindow(): Promise<void> {
	if (window) {
		window.unminimize();
		window.show();
		window.activate();
		return;
	}
	const url = await viewUrl();
	// Another call may have opened the window while the URL was resolved
	if (window) return showWindow();
	window = new BrowserWindow({
		title: "Riptide",
		url,
		rpc,
		frame: { width: 1200, height: 780, x: 120, y: 90 },
		titleBarStyle: "hiddenInset",
		trafficLightOffset: { x: 18, y: 20 },
	});
	push = (name, data) => {
		try {
			rpc.send.push({ name, data });
		} catch {
			// The view isn't connected yet; the next snapshot catches it up
		}
	};
	window.on("close", () => {
		window = null;
		push = () => {};
	});
	// The Mac stops the resize at the minimum itself; elsewhere, a resize below it is put back
	if (!setMinimumSize(window.ptr, MIN_WINDOW.width, MIN_WINDOW.height)) {
		window.on("resize", (event) => {
			const { x, y, width, height } = (event as { data: { x: number; y: number; width: number; height: number } }).data;
			if (width < MIN_WINDOW.width || height < MIN_WINDOW.height) window?.setFrame(x, y, Math.max(width, MIN_WINDOW.width), Math.max(height, MIN_WINDOW.height));
		});
	}
}

/** Runs a menu or tray command in the UI, opening the window first. */
function command(name: UiCommand): void {
	showWindow();
	push("command", { name });
}

// ---------- Menu and tray ---------- //

ApplicationMenu.setApplicationMenu([
	{
		label: "Riptide",
		submenu: [
			{ role: "about" },
			{ type: "separator" },
			{ label: "Settings…", action: "settings", accelerator: "CommandOrControl+," },
			{ type: "separator" },
			{ role: "hide" },
			{ role: "hideOthers" },
			{ role: "showAll" },
			{ type: "separator" },
			{ role: "quit" },
		],
	},
	{
		label: "File",
		submenu: [
			{ label: "Add Torrent File…", action: "addFile", accelerator: "CommandOrControl+O" },
			{ label: "Add Magnet Link…", action: "addMagnet", accelerator: "CommandOrControl+U" },
			{ label: "Create Torrent…", action: "create", accelerator: "CommandOrControl+N" },
			{ type: "separator" },
			{ label: "Pause All", action: "pauseAll", accelerator: "CommandOrControl+Alt+P" },
			{ label: "Resume All", action: "resumeAll", accelerator: "CommandOrControl+Alt+R" },
			{ label: "Slow Tide", action: "slowTide", accelerator: "CommandOrControl+Alt+T" },
			{ type: "separator" },
			{ label: "Command Palette…", action: "palette", accelerator: "CommandOrControl+K" },
			{ type: "separator" },
			{ role: "close" },
		],
	},
	{
		label: "Edit",
		submenu: [
			{ role: "undo" },
			{ role: "redo" },
			{ type: "separator" },
			{ role: "cut" },
			{ role: "copy" },
			{ role: "paste" },
			{ label: "Select All Torrents", action: "selectAll", accelerator: "CommandOrControl+A" },
			{ label: "Find", action: "find", accelerator: "CommandOrControl+F" },
		],
	},
	{ label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "toggleFullScreen" }, { type: "separator" }, { label: "Show Riptide", action: "show", accelerator: "CommandOrControl+1" }, { role: "bringAllToFront" }] },
]);

/** Flips slow tide from the menu or tray, with or without the window. */
const toggleSlowTide = () => backend.toggleSlowTide().catch((e) => console.error("slow tide:", e));

ApplicationMenu.on("application-menu-clicked", (e) => {
	const action = (e as { data?: { action?: string } }).data?.action;
	if (action === "show") showWindow();
	else if (action === "slowTide") toggleSlowTide();
	else if (action) command(action as UiCommand);
});

const tray = new Tray({ title: "" });

/** The tray menu, with slow tide's check mark as it is now. */
function setTrayMenu(slow: boolean): void {
	tray.setMenu([
		{ type: "normal", label: "Show Riptide", action: "show" },
		{ type: "separator" },
		{ type: "normal", label: "Add Magnet Link…", action: "addMagnet" },
		{ type: "normal", label: "Pause All", action: "pauseAll" },
		{ type: "normal", label: "Resume All", action: "resumeAll" },
		{ type: "normal", label: "Slow Tide", action: "slowTide", checked: slow },
		{ type: "separator" },
		{ type: "normal", label: "Quit Riptide", action: "quit" },
	]);
}
let traySlow = false;
setTrayMenu(traySlow);

tray.on("tray-clicked", (e) => {
	const action = (e as { data?: { action?: string } }).data?.action;
	if (action === "quit") Utils.quit();
	else if (action === "show" || !action) showWindow();
	else if (action === "slowTide") toggleSlowTide();
	else command(action as UiCommand);
});

// The tray shows the live download rate while anything transfers, and follows slow tide
setInterval(() => {
	const { down, up } = backend.totals;
	tray.setTitle(down > 0 || up > 0 ? `↓ ${formatRate(down)}` : "");
	if (backend.slowTide !== traySlow) {
		traySlow = backend.slowTide;
		setTrayMenu(traySlow);
	}
}, 1000);

// ---------- OS integration ---------- //

// Magnet links and .torrent files opened from outside
Electrobun.events.on("open-url", (e) => {
	backend.openUrl((e as { data: { url: string } }).data.url);
	showWindow();
});

// Clicking the Dock icon with no window open
Electrobun.events.on("reopen", () => showWindow());

// Save resume state and stop the engine on quit
Electrobun.events.on("before-quit", async () => {
	await engine.stop();
});

// ---------- Start ---------- //

showWindow();
engine.start().catch((e) => {
	console.error("undercurrentd failed to start:", e);
	backend.onEngineStatus(engine.status());
});
