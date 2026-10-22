/**
 * Transfer rates that read calmly. The engine's rates are ~1 s averages, and a swarm's throughput
 * swings by half or more from second to second as peers choke and unchoke, so a figure that
 * follows them jitters. Instead each rate follows the engine's over a few seconds: a short dip
 * and recovery barely moves it, while a lasting change still arrives within a few seconds.
 */

import type { Snapshot } from "./types";

/** Seconds a rate takes to cover ~63% of a change (an exponential time constant). */
const RATE_WINDOW_S = 4;
/** A shorter constant once the engine reports nothing at all, so a stop doesn't linger. */
const STOP_WINDOW_S = 1;
/** Below this many bytes per second a falling rate reads as zero. */
const FLOOR = 1024;

/** One smoothed rate. */
interface Track {
	value: number;
	/** Snapshot time (ms) of the last update. */
	at: number;
}

/** Keeps a smoothed copy of every rate in the snapshots it's fed. */
export class RateSmoother {
	private tracks = new Map<string, Track>();

	/** A copy of `snapshot` with its engine and torrent rates smoothed. */
	apply(snapshot: Snapshot): Snapshot {
		const at = snapshot.at;
		const live = new Set<string>();
		const rate = (key: string, sample: number, stopped = false) => {
			live.add(key);
			return this.follow(key, sample, at, stopped);
		};

		const engine = snapshot.engine && { ...snapshot.engine, downRate: rate("engine:down", snapshot.engine.downRate), upRate: rate("engine:up", snapshot.engine.upRate) };
		const torrents = snapshot.torrents.map((t) => {
			// A pause or the queue stops a torrent outright, so its figure drops with it
			const stopped = t.paused || t.queued || t.state === "error";
			return { ...t, downRate: rate(`${t.hash}:down`, t.downRate, stopped), upRate: rate(`${t.hash}:up`, t.upRate, stopped) };
		});

		// Forget torrents that are gone
		for (const key of this.tracks.keys()) if (!live.has(key)) this.tracks.delete(key);
		return { ...snapshot, engine, torrents };
	}

	/** Moves one rate toward its latest sample. */
	private follow(key: string, sample: number, at: number, stopped: boolean): number {
		const tr = this.tracks.get(key);
		if (!tr || stopped) {
			this.tracks.set(key, { value: stopped ? 0 : sample, at });
			return stopped ? 0 : sample;
		}
		const dt = (at - tr.at) / 1000;
		if (dt <= 0) return tr.value;

		// Ease toward the sample; quicker when the engine says nothing is moving
		const window = sample === 0 ? STOP_WINDOW_S : RATE_WINDOW_S;
		tr.value += (sample - tr.value) * (1 - Math.exp(-dt / window));
		if (tr.value < FLOOR && sample < tr.value) tr.value = 0;
		tr.at = at;
		return tr.value;
	}
}
