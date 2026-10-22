/**
 * Time-left estimates that hold still. A torrent's reported rate swings from snapshot to
 * snapshot (peers choke, pieces land in bursts), so dividing what's left by it makes the figure
 * jump. Instead the rate is smoothed over a window, and the shown figure counts down with the
 * clock, only moving to a new estimate when the two really disagree.
 */

import type { TorrentSummary } from "./types";

/** Seconds of history the smoothed rate leans on (an exponential time constant). */
const RATE_WINDOW_S = 20;
/** Seconds without a byte arriving before the estimate gives up and shows "∞". */
const STALL_S = 45;
/** How far the shown figure may sit from the fresh estimate before it jumps, as a fraction... */
const BAND = 0.12;
/** ...and the least that counts as a real disagreement, in seconds. */
const BAND_MIN_S = 5;
/** Share of the gap to the fresh estimate pulled in per second while inside the band. */
const DRIFT_PER_S = 0.05;

/** What's tracked for one downloading torrent. */
interface Track {
	/** Smoothed bytes per second. */
	rate: number;
	/** Decayed sum of rate × seconds and of seconds; their quotient is `rate`, with no warm-up bias. */
	weighted: number;
	weight: number;
	/** Snapshot time (ms) of the last update. */
	at: number;
	/** Snapshot time (ms) a byte last arrived. */
	movedAt: number;
	/** Bytes left at the last update. */
	left: number;
	/** The figure on display, in seconds as of `at`; null until there's a rate. */
	shown: number | null;
}

/** Keeps a steady seconds-left figure for each downloading torrent across snapshots. */
export class EtaTracker {
	private tracks = new Map<string, Track>();

	/** Takes in a snapshot: updates downloading torrents and forgets the rest. */
	update(torrents: readonly TorrentSummary[], at: number): void {
		const live = new Set<string>();
		for (const t of torrents) {
			if (t.state !== "downloading") continue;
			live.add(t.hash);
			this.track(t.hash, Math.max(0, t.size - t.done), t.downRate, at);
		}
		for (const hash of this.tracks.keys()) if (!live.has(hash)) this.tracks.delete(hash);
	}

	/** Seconds left for a torrent, or Infinity when it isn't downloading or nothing is arriving. */
	get(hash: string): number {
		const tr = this.tracks.get(hash);
		if (!tr) return Infinity;
		if (tr.left <= 0) return 0;
		return tr.shown ?? Infinity;
	}

	/** Folds one torrent's sample into its track. */
	private track(hash: string, left: number, sample: number, at: number): void {
		const tr = this.tracks.get(hash);
		if (!tr) {
			this.tracks.set(hash, { rate: sample, weighted: 0, weight: 0, at, movedAt: at, left, shown: sample > 0 ? left / sample : null });
			return;
		}
		const dt = (at - tr.at) / 1000;
		if (dt <= 0) return;

		// Average the rate over a sliding window so one snapshot's burst or dip barely moves it
		const decay = Math.exp(-dt / RATE_WINDOW_S);
		tr.weighted = tr.weighted * decay + sample * dt;
		tr.weight = tr.weight * decay + dt;
		tr.rate = tr.weighted / tr.weight;
		if (sample > 0 || left < tr.left) tr.movedAt = at;
		if (at - tr.movedAt > STALL_S * 1000) tr.rate = 0;

		const fresh = tr.rate > 1 ? left / tr.rate : null;
		if (fresh === null) {
			tr.shown = null;
		} else if (tr.shown === null) {
			tr.shown = fresh;
		} else {
			// Count down with the clock; follow the estimate gently, or jump if it's way off
			const predicted = Math.max(0, tr.shown - dt);
			const gap = fresh - predicted;
			if (Math.abs(gap) > Math.max(BAND_MIN_S, BAND * predicted)) tr.shown = fresh;
			else tr.shown = predicted + gap * (1 - Math.exp(-DRIFT_PER_S * dt));
		}
		tr.at = at;
		tr.left = left;
	}
}

/** The app's tracker, fed by every snapshot. */
export const etaTracker = new EtaTracker();
