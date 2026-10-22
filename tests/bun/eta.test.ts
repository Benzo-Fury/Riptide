/** The time-left tracker: steady under a jumpy rate, honest when the transfer really changes. */

import { describe, expect, test } from "bun:test";
import { EtaTracker } from "../../src/shared/eta";
import type { TorrentSummary } from "../../src/shared/types";

const MB = 1024 * 1024;

/** A downloading torrent with `left` bytes remaining at `rate`. */
function torrent(left: number, rate: number): TorrentSummary {
	return { hash: "a", state: "downloading", size: 1000 * MB, done: 1000 * MB - left, downRate: rate } as TorrentSummary;
}

describe("EtaTracker", () => {
	test("barely moves while the reported rate swings", () => {
		const tracker = new EtaTracker();
		let left = 500 * MB;
		const seen: number[] = [];
		// 70 s of half-second snapshots whose rate alternates 2 and 10 MB/s (avg 6)
		for (let i = 0; i < 140; i++) {
			const rate = (i % 6 < 3 ? 2 : 10) * MB;
			tracker.update([torrent(left, rate)], i * 500);
			left -= rate / 2;
			if (i >= 20) seen.push(tracker.get("a") + i * 0.5);
		}
		// "now + time left" is the predicted finish; it should hold within a few percent
		const spread = Math.max(...seen) - Math.min(...seen);
		expect(spread / seen[0]).toBeLessThan(0.1);
	});

	test("counts down by the clock at a constant rate", () => {
		const tracker = new EtaTracker();
		let left = 400 * MB;
		for (let i = 0; i < 20; i++) {
			tracker.update([torrent(left, 5 * MB)], i * 1000);
			left -= 5 * MB;
		}
		expect(Math.abs(tracker.get("a") - left / (5 * MB))).toBeLessThan(2);
	});

	test("follows a real, lasting change in speed", () => {
		const tracker = new EtaTracker();
		let left = 3000 * MB;
		for (let i = 0; i < 150; i++) {
			const rate = (i < 30 ? 2 : 20) * MB;
			tracker.update([torrent(left, rate)], i * 1000);
			left -= rate;
		}
		expect(tracker.get("a") / (left / (20 * MB))).toBeCloseTo(1, 0);
	});

	test("a short stall doesn't flip to infinity, a long one does", () => {
		const tracker = new EtaTracker();
		let left = 500 * MB;
		for (let i = 0; i < 20; i++) {
			tracker.update([torrent(left, 5 * MB)], i * 1000);
			left -= 5 * MB;
		}
		for (let i = 20; i < 30; i++) tracker.update([torrent(left, 0)], i * 1000);
		expect(Number.isFinite(tracker.get("a"))).toBe(true);
		for (let i = 30; i < 90; i++) tracker.update([torrent(left, 0)], i * 1000);
		expect(tracker.get("a")).toBe(Infinity);
	});

	test("forgets torrents that stop downloading", () => {
		const tracker = new EtaTracker();
		tracker.update([torrent(100 * MB, 5 * MB)], 0);
		tracker.update([{ ...torrent(100 * MB, 0), state: "paused" }], 1000);
		expect(tracker.get("a")).toBe(Infinity);
	});
});
