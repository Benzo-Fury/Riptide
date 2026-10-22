/**
 * Test harness: real undercurrentd processes in throwaway state directories, configured for loopback
 * (no DHT, no port mapping) so tests never touch the internet.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Settings, Snapshot, TorrentEvent, TorrentSummary } from "../../src/shared/types";
import { EngineClient } from "../../src/bun/engine-client";

export const ROOT = resolve(import.meta.dir, "../..");
export const BINARY = process.env.UNDERCURRENTD_PATH ?? join(ROOT, "vendor/bin/undercurrentd");

/** A temporary directory removed by `cleanup()`. */
export function tempDir(label: string): string {
	return mkdtempSync(join(tmpdir(), `riptide-test-${label}-`));
}

/** Writes `files` (relative path → size) of pseudo-random bytes under `dir`. */
export function writePayload(dir: string, files: Record<string, number>): void {
	let seed = 0x9e3779b9;
	for (const [rel, size] of Object.entries(files)) {
		const path = join(dir, rel);
		mkdirSync(join(path, ".."), { recursive: true });
		const buf = new Uint8Array(size);
		for (let i = 0; i < size; i++) {
			seed = (seed * 1103515245 + 12345) >>> 0;
			buf[i] = seed >>> 24;
		}
		writeFileSync(path, buf);
	}
}

/** Polls `check` until it returns something truthy, or fails after `seconds`. */
export async function until<T>(what: string, check: () => T | undefined | null | false, seconds = 20): Promise<T> {
	const deadline = Date.now() + seconds * 1000;
	while (Date.now() < deadline) {
		const v = check();
		if (v) return v;
		await Bun.sleep(50);
	}
	throw new Error(`timed out waiting for ${what}`);
}

/** One undercurrentd under test, with every event it sends recorded. */
export class TestEngine {
	readonly stateDir: string;
	readonly client: EngineClient;
	snapshot: Snapshot | null = null;
	readonly events: TorrentEvent[] = [];
	readonly log: string[] = [];

	constructor(label: string, settings: Partial<Settings> = {}, stateDir?: string) {
		this.stateDir = stateDir ?? tempDir(label);

		// Loopback-only settings, unless the test already wrote its own
		const s: Partial<Settings> = { port: 30000 + Math.floor(Math.random() * 20000), dht: false, pex: false, portMapping: false, downloadDir: join(this.stateDir, "downloads"), maxActiveDownloads: 5, ...settings };
		if (!stateDir) writeFileSync(join(this.stateDir, "settings.json"), JSON.stringify(s));

		this.client = new EngineClient({
			binary: BINARY,
			stateDir: this.stateDir,
			onEvent: (name, data) => {
				if (name === "snapshot") this.snapshot = data as Snapshot;
				if (name === "torrent") this.events.push(data as TorrentEvent);
			},
			log: (line) => this.log.push(line),
		});
	}

	async start(): Promise<this> {
		await this.client.start();
		this.snapshot = await this.client.request<Snapshot>("snapshot");
		return this;
	}

	request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
		return this.client.request<T>(method, params, timeoutMs);
	}

	/** The listening port, from the latest snapshot. */
	get port(): number {
		return this.snapshot?.engine?.port ?? 0;
	}

	torrent(hash: string): TorrentSummary | undefined {
		return this.snapshot?.torrents.find((t) => t.hash === hash);
	}

	/** Waits until the torrent's summary satisfies `check`. */
	waitFor(hash: string, what: string, check: (t: TorrentSummary) => boolean, seconds = 20): Promise<TorrentSummary> {
		return until(`${what} (${hash.slice(0, 8)})`, () => {
			const t = this.torrent(hash);
			return t && check(t) ? t : undefined;
		}, seconds);
	}

	async stop(): Promise<void> {
		await this.client.stop();
	}

	cleanup(): void {
		rmSync(this.stateDir, { recursive: true, force: true });
	}
}
