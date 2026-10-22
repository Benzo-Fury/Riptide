/**
 * Runs Riptide's UI in a browser against the real backend and engine, for testing and design
 * work. The same `Backend` as the app runs here; only the native host differs: dialogs answer
 * from a queue that tests fill over HTTP, and notifications are recorded instead of shown.
 *
 *   bun scripts/dev-web.ts [--port 5180] [--state-dir DIR]
 *
 * Serves dist/ (run `vite build` first) and a WebSocket at /rpc speaking the same call/push
 * messages as Electrobun's RPC. Test controls:
 *   POST /__test/native   {"pickTorrentFiles": [...], "pickFolder": "...", "pickContent": "..."}
 *   POST /__test/openUrl  {"url": "magnet:?..."}
 *   GET  /__test/log      what the native host was asked to do
 *   POST /__test/drop     {"method": "getSettings", "count": 2, "fail": false}: the next `count`
 *                         calls of `method` go unanswered (or fail), like calls the app's RPC loses
 */

import type { ServerWebSocket } from "bun";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ApiMethod, DefaultApp, Push, PushName } from "../src/shared/types";
import { Backend, type NativeHost } from "../src/bun/backend";
import { EngineClient } from "../src/bun/engine-client";

// ---------- Options ---------- //

const root = resolve(import.meta.dir, "..");
const arg = (name: string) => {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : undefined;
};
const port = Number(arg("--port") ?? 5180);
const stateDir = arg("--state-dir") ?? mkdtempSync(join(tmpdir(), "riptide-web-"));
const binary = process.env.UNDERCURRENTD_PATH ?? join(root, "vendor/bin/undercurrentd");
const dist = join(root, "dist");

// ---------- Scriptable native host ---------- //

/** Answers queued by tests, consumed one per dialog. */
const answers: { pickTorrentFiles: string[][]; pickFolder: (string | null)[]; pickContent: (string | null)[] } = { pickTorrentFiles: [], pickFolder: [], pickContent: [] };
/** Everything the host was asked to do, for assertions. */
const log: { kind: string; detail: unknown }[] = [];
let clipboard: string | null = null;
/** Starts as another app's; "Make default" flips it. */
let defaultApp: DefaultApp = { supported: true, torrents: false, magnets: false };
/** Calls to swallow or fail, by method: how many remain, and whether they fail or stay silent. */
const drops = new Map<string, { count: number; fail: boolean }>();

const native: NativeHost = {
	async pickTorrentFiles() {
		log.push({ kind: "pickTorrentFiles", detail: null });
		return answers.pickTorrentFiles.shift() ?? [];
	},
	async pickFolder(start) {
		log.push({ kind: "pickFolder", detail: start ?? null });
		return answers.pickFolder.shift() ?? null;
	},
	async pickContent() {
		log.push({ kind: "pickContent", detail: null });
		return answers.pickContent.shift() ?? null;
	},
	openPath(path) {
		log.push({ kind: "openPath", detail: path });
		return true;
	},
	revealPath(path) {
		log.push({ kind: "revealPath", detail: path });
	},
	readClipboard: () => clipboard,
	writeClipboard(text) {
		clipboard = text;
		log.push({ kind: "writeClipboard", detail: text });
	},
	notify(title, body) {
		log.push({ kind: "notify", detail: { title, body } });
	},
	defaultApp: () => defaultApp,
	makeDefaultApp() {
		log.push({ kind: "makeDefaultApp", detail: null });
		defaultApp = { supported: true, torrents: true, magnets: true };
		return defaultApp;
	},
};

// ---------- Backend ---------- //

const sockets = new Set<ServerWebSocket<unknown>>();

/** Sends a push to every connected page. */
function push<N extends PushName>(name: N, data: Push[N]): void {
	const msg = JSON.stringify({ type: "push", name, data });
	for (const ws of sockets) ws.send(msg);
}

const engine = new EngineClient({
	binary,
	stateDir,
	onEvent: (name, data) => backend.onEngineEvent(name, data),
	onStatus: (status) => backend.onEngineStatus(status),
	log: (line) => console.log(line),
});
const backend = new Backend({ engine, native, push, info: { version: "0.1.0", platform: process.platform, dataDir: stateDir, host: "web" } });

// ---------- Server ---------- //

const server = Bun.serve({
	port,
	async fetch(req, srv) {
		const url = new URL(req.url);

		// The RPC socket
		if (url.pathname === "/rpc") {
			return srv.upgrade(req) ? undefined : new Response("expected a WebSocket", { status: 400 });
		}

		// Test controls
		if (url.pathname === "/__test/native" && req.method === "POST") {
			const body = (await req.json()) as Partial<{ pickTorrentFiles: string[]; pickFolder: string | null; pickContent: string | null }>;
			if (body.pickTorrentFiles) answers.pickTorrentFiles.push(body.pickTorrentFiles);
			if ("pickFolder" in body) answers.pickFolder.push(body.pickFolder ?? null);
			if ("pickContent" in body) answers.pickContent.push(body.pickContent ?? null);
			return Response.json({ ok: true });
		}
		if (url.pathname === "/__test/openUrl" && req.method === "POST") {
			backend.openUrl(((await req.json()) as { url: string }).url);
			return Response.json({ ok: true });
		}
		if (url.pathname === "/__test/drop" && req.method === "POST") {
			const { method, count, fail = false } = (await req.json()) as { method: string; count: number; fail?: boolean };
			drops.set(method, { count, fail });
			return Response.json({ ok: true });
		}
		if (url.pathname === "/__test/log") return Response.json(log);
		if (url.pathname === "/__test/state") return Response.json({ stateDir });

		// The built UI
		const file = Bun.file(join(dist, url.pathname === "/" ? "index.html" : url.pathname.slice(1)));
		return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
	},
	websocket: {
		open(ws) {
			sockets.add(ws);
		},
		close(ws) {
			sockets.delete(ws);
		},
		async message(ws, raw) {
			// Same shape as the Electrobun call: {id, method, params}
			const { id, method, params } = JSON.parse(String(raw)) as { id: number; method: ApiMethod; params: never };

			// A call the test asked to lose
			const drop = drops.get(method);
			if (drop && drop.count > 0) {
				drop.count--;
				log.push({ kind: "dropped", detail: method });
				if (drop.fail) ws.send(JSON.stringify({ type: "response", id, ok: false, error: "Dropped by the test." }));
				return;
			}
			try {
				ws.send(JSON.stringify({ type: "response", id, ok: true, result: await backend.call(method, params) }));
			} catch (e) {
				ws.send(JSON.stringify({ type: "response", id, ok: false, error: e instanceof Error ? e.message : String(e) }));
			}
		},
	},
});

await engine.start();
console.log(`Riptide web harness on http://localhost:${server.port} (state: ${stateDir})`);

// Stop the engine cleanly on Ctrl-C or kill
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, async () => {
		await engine.stop();
		process.exit(0);
	});
}
