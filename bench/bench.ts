/**
 * Riptide against qBittorrent on one machine: downloading 4 GiB from a local swarm and seeding to local
 * downloaders. Riptide runs as the app runs it: its own undercurrentd, driven through EngineClient.
 * qBittorrent runs as the app, in a throwaway profile, through Undercurrent's bench driver.
 *
 *   bun bench/bench.ts [--runs 3]
 *
 * Needs Undercurrent beside this folder with its release build and examples
 * (`cargo build --release --examples`), `bun run engine`, and qBittorrent in /Applications.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decode, encode, totalLength, type Value } from "../../Undercurrent/bench/bencode";
import { BIN, ENGINES, ROOT as UC, cpu, type Ctx, type Engine, seeding as seedingWith } from "../../Undercurrent/bench/engines";
import type { AddResult } from "../src/shared/types";
import { TestEngine } from "../tests/bun/harness";

const arg = (name: string, fallback: number): number => {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};
const RUNS = arg("runs", 3);
const WORK = join(UC, ".bench");
const PAYLOAD = join(WORK, "payload-4096m");
const qbt = ENGINES.qbittorrent as Engine;

// ---------- Helpers ---------- //

/** A minimal HTTP tracker that answers every announce with `ports` on 127.0.0.1. */
function tracker(): { url: string; ports: number[]; stop: () => void } {
	const ports: number[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch() {
			const compact = Buffer.alloc(ports.length * 6);
			ports.forEach((port, i) => {
				compact.set([127, 0, 0, 1], i * 6);
				compact.writeUInt16BE(port, i * 6 + 4);
			});
			return new Response(Buffer.from(encode({ interval: 30, peers: compact })));
		},
	});
	return { url: `http://127.0.0.1:${server.port}/announce`, ports, stop: () => server.stop(true) };
}

/** The pid of the undercurrentd this process started. */
async function enginePid(): Promise<number> {
	const out = await new Response(Bun.spawn(["pgrep", "-P", String(process.pid), "undercurrentd"]).stdout).text();
	return Number(out.trim().split("\n").pop());
}

/** A Riptide engine in a throwaway state directory, with the local-test settings qBittorrent gets too. */
async function riptide(label: string, dir: string): Promise<TestEngine> {
	return new TestEngine(label, { encryption: "plaintext", downloadDir: dir }).start();
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const range = (xs: number[]): string => (Math.min(...xs) === Math.max(...xs) ? (xs[0] as number).toFixed(1) : `${Math.min(...xs).toFixed(1)}–${Math.max(...xs).toFixed(1)}`);

/** A pause and a flush of pending writes, so one run's writes don't land in the next run's time. */
async function settle(): Promise<void> {
	await Bun.sleep(5000);
	await Bun.spawn(["sync"]).exited;
}

// ---------- Downloading ---------- //

/** One download of the payload from the local swarm: seconds, CPU seconds and peak MB. */
async function downloadOnce(who: "riptide" | "qbittorrent", torrent: string, total: number): Promise<{ seconds: number; cpu: number }> {
	await settle();
	const dir = join(WORK, `riptide-dl-${who}`);
	await rm(dir, { recursive: true, force: true });
	await mkdir(dir, { recursive: true });
	const ctx: Ctx = { work: WORK, local: true, encryption: "plain", maxPeers: 200, total };
	try {
		if (who === "qbittorrent") {
			const leech = await qbt.leech(torrent, dir, ctx);
			const c0 = await cpu(leech.pid);
			const started = performance.now();
			while (!(await leech.status().catch(() => ({ done: false }))).done) await Bun.sleep(50);
			const seconds = (performance.now() - started) / 1000;
			const c1 = await cpu(leech.pid);
			await leech.stop();
			return { seconds, cpu: c1.user + c1.sys - c0.user - c0.sys };
		}
		const e = await riptide("dl", dir);
		const pid = await enginePid();
		const c0 = await cpu(pid);
		const started = performance.now();
		const added = await e.request<AddResult>("add", { source: { kind: "file", path: torrent }, dir });
		await e.waitFor(added.hash, "complete", (t) => t.progress === 1, 600);
		const seconds = (performance.now() - started) / 1000;
		const c1 = await cpu(pid);
		await e.stop();
		e.cleanup();
		return { seconds, cpu: c1.user + c1.sys - c0.user - c0.sys };
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

// ---------- Seeding ---------- //

/** One engine seeding the payload to 8 connections from `sink` for 20 s: Mbit/s and CPU seconds. */
async function seedOnce(who: "riptide" | "qbittorrent", torrent: string, total: number): Promise<{ mbitps: number; cpu: number; gb: number }> {
	await settle();
	const ctx: Ctx = { work: WORK, local: true, encryption: "plain", maxPeers: 200, total };
	let pid: number;
	let port: number;
	let stop: () => Promise<unknown>;
	if (who === "qbittorrent") {
		const s = await seedingWith(qbt, torrent, join(PAYLOAD, "data"), ctx);
		({ pid, port } = s);
		stop = s.stop;
	} else {
		const e = await riptide("seed", join(PAYLOAD, "data"));
		const added = await e.request<AddResult>("add", { source: { kind: "file", path: torrent }, dir: join(PAYLOAD, "data") });
		await e.waitFor(added.hash, "seeding", (t) => t.state === "seeding", 120);
		pid = await enginePid();
		port = e.port;
		stop = async () => {
			await e.stop();
			e.cleanup();
		};
	}
	try {
		const c0 = await cpu(pid);
		const sink = Bun.spawn([BIN.sink, torrent, `127.0.0.1:${port}`, "--conns", "8", "--seconds", "20", "--crypto", "plain"], { stdout: "pipe", stderr: "ignore" });
		const out = JSON.parse(await new Response(sink.stdout).text()) as { bytes: number; mbitps: number };
		const c1 = await cpu(pid);
		return { mbitps: out.mbitps, cpu: c1.user + c1.sys - c0.user - c0.sys, gb: out.bytes / 1e9 };
	} finally {
		await stop();
	}
}

// ---------- Main ---------- //

const info = decode(await readFile(join(PAYLOAD, "info.bin")));
const total = totalLength(encode({ info }));
const track = tracker();
const torrent = join(WORK, "riptide-bench.torrent");
await writeFile(torrent, encode({ announce: new TextEncoder().encode(track.url), info: info as Value }));
const gb = total / 1e9;
const who = ["riptide", "qbittorrent"] as const;
const dl: Record<string, { seconds: number; cpu: number }[]> = { riptide: [], qbittorrent: [] };
const up: Record<string, { mbitps: number; cpu: number; gb: number }[]> = { riptide: [], qbittorrent: [] };

const seeds: Array<{ stop: () => Promise<unknown> }> = [];
try {
	console.error("starting 4 seeders…");
	for (let i = 0; i < 4; i++) {
		const s = await seedingWith(ENGINES.undercurrent as Engine, torrent, join(PAYLOAD, "data"), { work: WORK, local: true, encryption: "prefer", maxPeers: 200, total, threads: 1 });
		seeds.push(s);
		track.ports.push(s.port);
	}
	await downloadOnce("riptide", torrent, total); // warm-up, not counted
	for (let run = 0; run < RUNS; run++) {
		for (const w of run % 2 ? [...who].reverse() : who) {
			const r = await downloadOnce(w, torrent, total);
			dl[w]?.push(r);
			console.error(`download ${w} run ${run + 1}: ${((total * 8) / 1e6 / r.seconds).toFixed(0)} Mbit/s, ${r.cpu.toFixed(1)} s CPU`);
		}
	}
} finally {
	for (const s of seeds) await s.stop();
}
for (let run = 0; run < RUNS; run++) {
	for (const w of run % 2 ? [...who].reverse() : who) {
		const r = await seedOnce(w, torrent, total);
		up[w]?.push(r);
		console.error(`seed ${w} run ${run + 1}: ${r.mbitps.toFixed(0)} Mbit/s, ${r.cpu.toFixed(1)} s CPU`);
	}
}
track.stop();

console.log("| App | Download (Gbit/s) | CPU s/GB down | Seeding (Gbit/s) | CPU s/GB up |");
console.log("|---|---|---|---|---|");
for (const w of who) {
	const d = dl[w] ?? [];
	const u = up[w] ?? [];
	console.log(`| ${w} | ${range(d.map((r) => (total * 8) / 1e9 / r.seconds))} | ${(mean(d.map((r) => r.cpu)) / gb).toFixed(2)} | ${range(u.map((r) => r.mbitps / 1000))} | ${mean(u.map((r) => r.cpu / r.gb)).toFixed(2)} |`);
}
