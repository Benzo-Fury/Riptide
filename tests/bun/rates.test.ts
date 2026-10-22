/** The rate smoother: shrugs off a passing dip, follows a lasting change, and stops with a pause. */

import { describe, expect, test } from "bun:test";
import { RateSmoother } from "../../src/shared/rates";
import type { Snapshot, TorrentSummary } from "../../src/shared/types";

const MB = 1024 * 1024;

/** A snapshot at `at` ms with one torrent downloading at `rate`. */
function snapshot(at: number, rate: number, paused = false): Snapshot {
	const t = { hash: "a", state: paused ? "paused" : "downloading", downRate: rate, upRate: 0, paused, queued: false } as TorrentSummary;
	return { at, engine: { downRate: rate, upRate: 0 } as Snapshot["engine"], engineError: null, torrents: [t] };
}

describe("RateSmoother", () => {
	test("a one-second dip barely moves the figure", () => {
		const s = new RateSmoother();
		let out = s.apply(snapshot(0, 12 * MB));
		// 12 MB/s, then 1 s at 4 MB/s, then back
		const rates = [...Array(20).fill(12), 4, 4, ...Array(4).fill(12)];
		let low = Infinity;
		rates.forEach((r, i) => {
			out = s.apply(snapshot((i + 1) * 500, r * MB));
			low = Math.min(low, out.engine!.downRate);
		});
		expect(low).toBeGreaterThan(10 * MB);
		expect(out.torrents[0].downRate).toBeGreaterThan(low);
	});

	test("a lasting change arrives within a few seconds", () => {
		const s = new RateSmoother();
		s.apply(snapshot(0, 12 * MB));
		let out = s.apply(snapshot(500, 4 * MB));
		for (let i = 2; i <= 20; i++) out = s.apply(snapshot(i * 500, 4 * MB));
		// Most of the way there after 10 s
		expect((12 * MB - out.engine!.downRate) / (8 * MB)).toBeGreaterThan(0.9);
	});

	test("a pause drops the torrent's figure at once, and the total soon after", () => {
		const s = new RateSmoother();
		s.apply(snapshot(0, 12 * MB));
		let out = s.apply(snapshot(500, 0, true));
		expect(out.torrents[0].downRate).toBe(0);
		for (let i = 2; i <= 30; i++) out = s.apply(snapshot(i * 500, 0, true));
		expect(out.engine!.downRate).toBe(0);
	});
});
