/**
 * End to end through EngineClient: real undercurrentd processes moving real bytes over loopback.
 * Covers the protocol, the library across restarts, the queue, magnets, crash recovery, slow
 * tide and the VPN lock.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AddResult, CreateResult, Details, InspectResult, NetworkInterface, Settings, SlowTideState } from "../../src/shared/types";
import { EngineError } from "../../src/bun/engine-client";
import { TestEngine, tempDir, until, writePayload } from "./harness";

// ---------- A seeder shared by the download tests ---------- //

let seeder: TestEngine;
let content: string;
let torrentFile: string;
let created: CreateResult;
const cleanups: (() => void)[] = [];

const FILES = { "album/one.bin": 700_000, "album/two.bin": 1_300_000, "album/deep/three.bin": 90_001, "album/empty": 0 };

beforeAll(async () => {
	// Content to share
	content = tempDir("content");
	writePayload(content, FILES);
	cleanups.push(() => rmSync(content, { recursive: true, force: true }));

	// A seeder that creates the torrent and serves it in seed mode
	seeder = await new TestEngine("seeder").start();
	torrentFile = join(content, "album.torrent");
	created = await seeder.request<CreateResult>("create", { path: join(content, "album"), out: torrentFile, trackers: [], private: false, pieceKb: 64, seed: true }, 0);
	await seeder.waitFor(created.hash, "seeding", (t) => t.state === "seeding");
});

afterAll(async () => {
	await seeder?.stop();
	seeder?.cleanup();
	for (const c of cleanups) c();
});

/** A fresh leecher, cleaned up after the suite. */
async function leecher(settings: Partial<Settings> = {}): Promise<TestEngine> {
	const e = await new TestEngine("leecher", settings).start();
	cleanups.push(() => {
		e.stop().finally(() => e.cleanup());
	});
	return e;
}

const peer = () => `127.0.0.1:${seeder.port}`;

// ---------- Protocol basics ---------- //

describe("protocol", () => {
	test("reports ready with a version and an empty snapshot", async () => {
		const e = await leecher();
		expect(e.client.version).toMatch(/^\d+\.\d+\.\d+$/);
		expect(e.snapshot?.torrents).toEqual([]);
		expect(e.snapshot?.engine?.port).toBeGreaterThan(0);
	});

	test("unknown methods and bad params fail with readable errors", async () => {
		const e = await leecher();
		await expect(e.request("nope")).rejects.toThrow('Unknown request "nope".');
		await expect(e.request("pause", { hashes: "x" })).rejects.toThrow(/Bad request/);
		await expect(e.request("details", { hash: "00".repeat(20) })).rejects.toThrow("That torrent isn't in the list.");
	});

	test("inspect reads a torrent file without adding it", async () => {
		const e = await leecher();
		const info = await e.request<InspectResult>("inspect", { source: { kind: "file", path: torrentFile } });
		expect(info.name).toBe("album");
		expect(info.isMagnet).toBe(false);
		expect(info.size).toBe(Object.values(FILES).reduce((a, b) => a + b, 0));
		expect(info.files.map((f) => f.path).sort()).toEqual(["album/deep/three.bin", "album/empty", "album/one.bin", "album/two.bin"]);
		expect(info.hash).toBe(created.hash);
		expect(info.alreadyAdded).toBe(false);
	});

	test("inspect reads base64 bytes and magnets, and rejects junk", async () => {
		const e = await leecher();
		const b64 = Buffer.from(readFileSync(torrentFile)).toString("base64");
		expect((await e.request<InspectResult>("inspect", { source: { kind: "bytes", base64: b64 } })).hash).toBe(created.hash);
		const m = await e.request<InspectResult>("inspect", { source: { kind: "magnet", uri: created.magnet } });
		expect(m).toMatchObject({ isMagnet: true, name: "album", hash: created.hash, size: null });
		await expect(e.request("inspect", { source: { kind: "magnet", uri: "magnet:?xt=urn:btih:zz" } })).rejects.toThrow(/magnet link isn't valid/);
		await expect(e.request("inspect", { source: { kind: "bytes", base64: "aGVsbG8=" } })).rejects.toThrow(/isn't a valid torrent/);
		await expect(e.request("inspect", { source: { kind: "file", path: "/nope/x.torrent" } })).rejects.toThrow(/Couldn't read/);
	});
});

// ---------- Downloading ---------- //

describe("downloading", () => {
	test("downloads a multi-file torrent byte for byte and reports completion once", async () => {
		const e = await leecher();
		const dir = tempDir("dl");
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

		const added = await e.request<AddResult>("add", { source: { kind: "file", path: torrentFile }, dir });
		expect(added).toMatchObject({ hash: created.hash, name: "album", existing: false });
		await e.request("addPeer", { hash: added.hash, address: peer() });

		// Completes, with the files identical to the seeder's
		const done = await e.waitFor(added.hash, "complete", (t) => t.progress === 1 && (t.state === "seeding" || t.state === "done"));
		expect(done.done).toBe(done.size);
		expect(done.completedAt).toBeGreaterThan(0);
		for (const rel of Object.keys(FILES)) {
			expect(Buffer.compare(readFileSync(join(dir, rel)), readFileSync(join(content, rel)))).toBe(0);
		}
		await until("completed event", () => e.events.find((x) => x.kind === "completed" && x.hash === added.hash));

		// The details agree, and the piece map is full
		const d = await e.request<Details>("details", { hash: added.hash });
		expect(d.files.every((f) => f.downloaded === f.length)).toBe(true);
		expect(d.piecesHave).toBe(d.pieceCount);
		expect(Buffer.from(d.pieces!, "base64").length).toBe(Math.ceil(d.pieceCount! / 8));
		expect(d.magnet).toStartWith(`magnet:?xt=urn:btih:${added.hash}`);

		// Adding it again points at the existing one
		expect(await e.request<AddResult>("add", { source: { kind: "file", path: torrentFile }, dir })).toMatchObject({ existing: true });
	});

	test("a magnet fetches metadata, waits for a file choice, and downloads only that", async () => {
		const e = await leecher();
		const dir = tempDir("mag");
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

		// Add with x.pe pointing at the seeder, stopping once the file list is known
		const uri = `${created.magnet}&x.pe=${peer()}`;
		const added = await e.request<AddResult>("add", { source: { kind: "magnet", uri }, dir, metadataOnly: true });
		await e.waitFor(added.hash, "waiting for files", (t) => t.state === "waiting" && t.hasMetadata);
		await until("metadata event", () => e.events.find((x) => x.kind === "metadata"));
		expect(existsSync(join(e.stateDir, "torrents", `${added.hash}.torrent`))).toBe(true);

		// Choose one file
		const d = await e.request<Details>("details", { hash: added.hash });
		const two = d.files.find((f) => f.path.endsWith("two.bin"))!;
		await expect(e.request("select", { hash: added.hash, files: [] })).rejects.toThrow(/at least one file/);
		await e.request("select", { hash: added.hash, files: [two.index] });
		const t = await e.waitFor(added.hash, "selected file done", (x) => x.progress === 1);
		expect(t.size).toBe(FILES["album/two.bin"]);
		expect(existsSync(join(dir, "album/two.bin"))).toBe(true);
		expect(existsSync(join(dir, "album/one.bin"))).toBe(false);
	});

	test("rate limits apply per torrent and engine-wide", async () => {
		const e = await leecher({ downloadLimit: 200_000 });
		const dir = tempDir("lim");
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const added = await e.request<AddResult>("add", { source: { kind: "file", path: torrentFile }, dir });
		await e.request("addPeer", { hash: added.hash, address: peer() });

		// 2 MB at 200 kB/s takes ~10 s: after 2 s it is well short of done
		await Bun.sleep(2000);
		expect(e.torrent(added.hash)!.progress).toBeLessThan(0.6);

		// Lifting the engine limit lets it finish
		const s = await e.request<Settings>("getSettings");
		const r = await e.request<{ restarted: boolean }>("setSettings", { ...s, downloadLimit: 0 });
		expect(r.restarted).toBe(false);
		await e.waitFor(added.hash, "complete after unlimiting", (t) => t.progress === 1);

		// Per-torrent limits are stored and reported
		await e.request("setLimits", { hash: added.hash, download: 1000, upload: 2000 });
		expect((await e.request<Details>("details", { hash: added.hash })).uploadLimit).toBe(2000);
	});
});

// ---------- Library and lifecycle ---------- //

describe("library", () => {
	test("paused torrents, selections and limits survive a restart", async () => {
		const dir = tempDir("lib");
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const first = await new TestEngine("lib").start();
		const added = await first.request<AddResult>("add", { source: { kind: "file", path: torrentFile }, dir, paused: true });
		await first.request("setLimits", { hash: added.hash, download: 5000, upload: 0 });
		await first.waitFor(added.hash, "paused", (t) => t.state === "paused");
		await first.stop();

		// Same state directory, new process
		const second = await new TestEngine("lib", {}, first.stateDir).start();
		cleanups.push(() => {
			second.stop().finally(() => second.cleanup());
		});
		const t = await second.waitFor(added.hash, "restored paused", (x) => x.state === "paused");
		expect(t).toMatchObject({ name: "album", paused: true, dir, downloadLimit: 5000 });

		// Lift the restored limit, resume and finish
		await second.request("setLimits", { hash: added.hash, download: 0, upload: 0 });
		await second.request("resume", { hashes: [added.hash] });
		await second.request("addPeer", { hash: added.hash, address: peer() });
		await second.waitFor(added.hash, "complete", (x) => x.progress === 1);
	});

	test("a finished torrent restores without re-downloading and without a second notification", async () => {
		const dir = tempDir("fin");
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const first = await new TestEngine("fin").start();
		const added = await first.request<AddResult>("add", { source: { kind: "file", path: torrentFile }, dir });
		await first.request("addPeer", { hash: added.hash, address: peer() });
		await first.waitFor(added.hash, "complete", (x) => x.progress === 1);
		await first.stop();

		const second = await new TestEngine("fin", {}, first.stateDir).start();
		cleanups.push(() => {
			second.stop().finally(() => second.cleanup());
		});
		const t = await second.waitFor(added.hash, "restored complete", (x) => x.progress === 1);
		expect(t.downloaded).toBeGreaterThanOrEqual(t.size);
		await Bun.sleep(700);
		expect(second.events.filter((x) => x.kind === "completed")).toEqual([]);
	});

	test("remove keeps or deletes files as asked", async () => {
		const e = await leecher();
		const dir = tempDir("rm");
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const added = await e.request<AddResult>("add", { source: { kind: "file", path: torrentFile }, dir });
		await e.request("addPeer", { hash: added.hash, address: peer() });
		await e.waitFor(added.hash, "complete", (x) => x.progress === 1);

		// Remove, keeping files
		await e.request("remove", { hashes: [added.hash], deleteFiles: false });
		await until("gone from snapshot", () => !e.torrent(added.hash));
		expect(existsSync(join(dir, "album/one.bin"))).toBe(true);
		expect(existsSync(join(e.stateDir, "torrents", `${added.hash}.torrent`))).toBe(false);

		// Add again (instant: files are there) and remove with files
		await e.request("add", { source: { kind: "file", path: torrentFile }, dir });
		await e.waitFor(added.hash, "rechecked complete", (x) => x.progress === 1);
		await e.request("remove", { hashes: [added.hash], deleteFiles: true });
		await until("files deleted", () => !existsSync(join(dir, "album/one.bin")));
		expect(existsSync(join(dir, "album"))).toBe(false);
	});

	test("the queue holds downloads beyond the limit and starts them in order", async () => {
		const e = await leecher({ maxActiveDownloads: 1 });
		// Magnets for torrents nobody has: they stay in metadata, occupying their slot
		const hashes = ["11", "22", "33"].map((h) => h.repeat(20));
		for (const h of hashes) await e.request("add", { source: { kind: "magnet", uri: `magnet:?xt=urn:btih:${h}&dn=q${h[0]}` } });
		await until("queue settles", () => e.snapshot!.torrents.length === 3 && e.snapshot!.torrents.filter((t) => t.state === "queued").length === 2);
		expect(e.torrent(hashes[0]!)!.state).toBe("metadata");

		// Pausing the active one lets the next start
		await e.request("pause", { hashes: [hashes[0]] });
		await e.waitFor(hashes[1]!, "next starts", (t) => t.state === "metadata");
		expect(e.torrent(hashes[0]!)!.state).toBe("paused");
		expect(e.torrent(hashes[2]!)!.state).toBe("queued");

		// Resuming the paused one queues it rather than exceeding the limit
		await e.request("resume", { hashes: [hashes[0]] });
		await e.waitFor(hashes[0]!, "requeued", (t) => t.state === "queued");

		// Raising the limit starts everything
		const s = await e.request<Settings>("getSettings");
		await e.request("setSettings", { ...s, maxActiveDownloads: 0 });
		await until("all active", () => e.snapshot!.torrents.every((t) => t.state === "metadata"));
	});
});

// ---------- Settings and resilience ---------- //

describe("settings and resilience", () => {
	test("invalid settings are refused; a port change restarts the engine with torrents intact", async () => {
		const e = await leecher();
		await e.request("add", { source: { kind: "magnet", uri: `magnet:?xt=urn:btih:${"44".repeat(20)}` } });
		const s = await e.request<Settings>("getSettings");
		await expect(e.request("setSettings", { ...s, encryption: "rot13" })).rejects.toThrow(/Unknown encryption/);
		await expect(e.request("setSettings", { ...s, downloadDir: "" })).rejects.toThrow(/download folder/);

		const port = s.port === 65000 ? 65001 : 65000;
		const r = await e.request<{ restarted: boolean; settings: Settings }>("setSettings", { ...s, port });
		expect(r.restarted).toBe(true);
		await until("new port", () => e.snapshot?.engine?.port === port);
		expect(e.snapshot!.torrents).toHaveLength(1);
		expect(JSON.parse(readFileSync(join(e.stateDir, "settings.json"), "utf8")).port).toBe(port);
	});

	test("the client restarts a crashed engine and the library comes back", async () => {
		const e = await leecher();
		await e.request("add", { source: { kind: "magnet", uri: `magnet:?xt=urn:btih:${"55".repeat(20)}&dn=crash` } });
		await until("library saved", () => existsSync(join(e.stateDir, "library.json")));

		// Kill it the hard way
		const pid = Number(
			Bun.spawnSync(["pgrep", "-f", "--", `--state-dir ${e.stateDir}`])
				.stdout.toString()
				.trim()
				.split("\n")[0],
		);
		expect(pid).toBeGreaterThan(0);
		process.kill(pid, "SIGKILL");

		// In-flight requests fail cleanly, then it's back
		await until("restarted", () => e.client.status().restarts === 1 && e.client.running, 10);
		const snap = await until("torrent restored", async () => true, 1).then(() => e.request<{ torrents: { name: string }[] }>("snapshot"));
		expect(snap.torrents.map((t) => t.name)).toEqual(["crash"]);
	});

	test("requests to a stopped engine fail with an EngineError", async () => {
		const e = await new TestEngine("stopped").start();
		await e.stop();
		e.cleanup();
		await expect(e.request("snapshot")).rejects.toBeInstanceOf(EngineError);
	});
});

// ---------- Slow tide ---------- //

/** The loopback interface's name on this OS. */
const LOOPBACK = process.platform === "darwin" ? "lo0" : "lo";

describe("slow tide", () => {
	test("switching it on applies its limits live, and off lifts them", async () => {
		const e = await leecher({ slowDownloadLimit: 150_000 });
		const dir = tempDir("tide");
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

		// On before anything moves: 2 MB at 150 kB/s is far from done after 2 s
		const r = await e.request<{ settings: Settings; slowTide: SlowTideState }>("setSlowTide", { on: true });
		expect(r.slowTide).toMatchObject({ on: true, scheduled: false });
		expect(r.settings.slowTide).toBe(true);
		const added = await e.request<AddResult>("add", { source: { kind: "file", path: torrentFile }, dir });
		await e.request("addPeer", { hash: added.hash, address: peer() });
		await Bun.sleep(2000);
		expect(e.snapshot!.slowTide!.on).toBe(true);
		expect(e.torrent(added.hash)!.progress).toBeLessThan(0.5);

		// Off: it finishes, and the switch is saved
		await e.request("setSlowTide", { on: false });
		await e.waitFor(added.hash, "complete after slow tide", (t) => t.progress === 1);
		expect((await e.request<Settings>("getSettings")).slowTide).toBe(false);
	});

	test("a schedule switches it on, and a switch by hand holds until its next change", async () => {
		const e = await leecher();
		const s = await e.request<Settings>("getSettings");
		expect(s.slowHours).toHaveLength(168);

		// Every hour slow: on by schedule, with no change ahead
		await e.request("setSettings", { ...s, slowSchedule: true, slowHours: Array(168).fill(true) });
		await until("scheduled", () => e.snapshot?.slowTide?.scheduled);
		expect(e.snapshot!.slowTide).toMatchObject({ on: true, scheduled: true, overridden: false, nextChange: null });

		// Switched off by hand: off, overriding the schedule
		const r = await e.request<{ slowTide: SlowTideState }>("setSlowTide", { on: false });
		expect(r.slowTide).toMatchObject({ on: false, overridden: true });

		// A bad schedule is refused
		await expect(e.request("setSettings", { ...s, slowHours: [true] })).rejects.toThrow(/168 hours/);
	});
});

// ---------- VPN lock ---------- //

describe("vpn lock", () => {
	test("interfaces lists loopback with its address", async () => {
		const e = await leecher();
		const list = await e.request<NetworkInterface[]>("interfaces");
		expect(list.find((i) => i.name === LOOPBACK)).toMatchObject({ loopback: true, addresses: expect.arrayContaining(["127.0.0.1"]) });
	});

	test("locked to an interface that's up, it downloads through that address", async () => {
		const e = await leecher({ bindInterface: LOOPBACK });
		const dir = tempDir("lock-up");
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		expect(e.snapshot!.lock).toEqual({ interface: LOOPBACK, address: "127.0.0.1" });
		const added = await e.request<AddResult>("add", { source: { kind: "file", path: torrentFile }, dir });
		await e.request("addPeer", { hash: added.hash, address: peer() });
		await e.waitFor(added.hash, "complete through the lock", (t) => t.progress === 1);
	});

	test("locked to an interface that's down, nothing connects and torrents wait for it", async () => {
		const e = await leecher({ bindInterface: "riptide-none0" });
		const dir = tempDir("lock-down");
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		expect(e.snapshot!.lock).toEqual({ interface: "riptide-none0", address: null });

		// Added and given a peer, it stays offline with nothing downloaded
		const added = await e.request<AddResult>("add", { source: { kind: "file", path: torrentFile }, dir });
		await e.request("addPeer", { hash: added.hash, address: peer() });
		await e.waitFor(added.hash, "offline", (t) => t.state === "offline");
		await Bun.sleep(1500);
		const t = e.torrent(added.hash)!;
		expect(t.state).toBe("offline");
		expect(t.done).toBe(0);
		expect(t.peers).toBe(0);

		// Unlocking (an engine restart) lets it download
		const s = await e.request<Settings>("getSettings");
		expect((await e.request<{ restarted: boolean }>("setSettings", { ...s, bindInterface: "" })).restarted).toBe(true);
		await e.request("addPeer", { hash: added.hash, address: peer() });
		await e.waitFor(added.hash, "complete after unlocking", (x) => x.progress === 1);
		expect(e.snapshot!.lock).toBeNull();
	});
});
