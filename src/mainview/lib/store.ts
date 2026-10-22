/**
 * App-wide state that arrives from the main process: the latest snapshot, a short history of
 * engine rates, settings and engine status. React reads it through the hooks at the bottom.
 */

import { useSyncExternalStore } from "react";
import { etaTracker } from "../../shared/eta";
import { RateSmoother } from "../../shared/rates";
import type { AppInfo, EngineStatus, Settings, Snapshot } from "../../shared/types";
import { call, onPush } from "./bridge";

/** Samples the status bar's sparkline shows: the last minute (one per snapshot, ~2 Hz). */
export const HISTORY_LENGTH = 120;
/** Samples kept in all, for the traffic panel's longest range: fifteen minutes. */
export const LONG_HISTORY_LENGTH = 1800;

export interface RateSample {
	at: number;
	down: number;
	up: number;
	peers: number;
}

interface State {
	snapshot: Snapshot | null;
	history: RateSample[];
	settings: Settings | null;
	engineStatus: EngineStatus;
	appInfo: AppInfo | null;
}

let state: State = {
	snapshot: null,
	history: [],
	settings: null,
	engineStatus: { running: true, error: null, restarts: 0 },
	appInfo: null,
};

const subscribers = new Set<() => void>();

function set(patch: Partial<State>): void {
	state = { ...state, ...patch };
	for (const fn of subscribers) fn();
}

/** Smooths the rates every view shows, so a passing dip in the swarm doesn't flicker through. */
const rates = new RateSmoother();

/** Whether two flat records hold the same values. */
function sameFields(a: object, b: object): boolean {
	const ka = Object.keys(a) as (keyof typeof a)[];
	return ka.length === Object.keys(b).length && ka.every((k) => Object.is(a[k], b[k]));
}

/**
 * Reuses the previous snapshot's torrent objects wherever nothing changed (and its whole list
 * when nothing did), so memoised rows and the lists derived from the torrents skip their work.
 */
function shareUnchanged(next: Snapshot, prev: Snapshot | null): Snapshot {
	if (!prev) return next;
	const before = new Map(prev.torrents.map((t) => [t.hash, t]));
	const torrents = next.torrents.map((t) => {
		const old = before.get(t.hash);
		return old && sameFields(old, t) ? old : t;
	});
	const same = torrents.length === prev.torrents.length && torrents.every((t, i) => t === prev.torrents[i]);
	return { ...next, torrents: same ? prev.torrents : torrents };
}

/** Takes in a snapshot and appends its totals to the rate history. */
function applySnapshot(raw: Snapshot): void {
	// Time-left figures are smoothed across snapshots, so feed them before anything renders.
	// They keep the raw rates: the tracker does its own, longer smoothing
	etaTracker.update(raw.torrents, raw.at);
	const snapshot = shareUnchanged(rates.apply(raw), state.snapshot);
	const sample = { at: snapshot.at, down: snapshot.engine?.downRate ?? 0, up: snapshot.engine?.upRate ?? 0, peers: snapshot.engine?.peers ?? 0 };
	set({ snapshot, history: [...state.history, sample].slice(-LONG_HISTORY_LENGTH) });
}

/** A startup load's first wait for an answer before trying again; doubles each try. */
const RETRY_AFTER_MS = 1000;
const RETRY_LIMIT_MS = 8000;
/** Tries before a startup load gives up and settles with its last error. */
const RETRY_ATTEMPTS = 5;

/**
 * Runs a read-only call until it answers, so one failed or unanswered startup call (the engine
 * still starting, say) doesn't leave a view waiting for good. An attempt that fails, or stays
 * silent past its wait, is followed by another (an earlier attempt that answers late still
 * counts). After `RETRY_ATTEMPTS`, the last error stands.
 */
function persist<T>(send: () => Promise<T>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let done = false;
		let tries = 0;
		let wait = RETRY_AFTER_MS;
		let timer: ReturnType<typeof setTimeout> | undefined;

		// The next attempt, unless one already answered or the budget is spent
		const again = (error: unknown) => {
			if (done) return;
			clearTimeout(timer);
			if (tries >= RETRY_ATTEMPTS) {
				done = true;
				reject(error);
				return;
			}
			timer = setTimeout(attempt, wait);
			wait = Math.min(RETRY_LIMIT_MS, wait * 2);
		};

		// One try: an answer wins; an error or silence schedules the next
		const attempt = () => {
			tries++;
			send().then(
				(value) => {
					if (done) return;
					done = true;
					clearTimeout(timer);
					resolve(value);
				},
				(error) => again(error),
			);
			timer = setTimeout(() => again(new Error("Riptide didn't answer.")), wait);
		};
		attempt();
	});
}

/**
 * Defaults for settings an older engine doesn't send yet (mirrors undercurrentd's), so their
 * fields show real values instead of blanks or NaN.
 */
const SETTINGS_FALLBACK: Partial<Settings> = { acceptIncoming: true, maxHalfOpen: 100, maxBufferBytes: 512 * 1024 * 1024, webSeeds: 3, preventSleep: true };

/** Settings as the engine sent them, with anything it left out filled in. */
const complete = (settings: Settings): Settings => ({ ...SETTINGS_FALLBACK, ...settings });

/** Fetches settings (again), keeping what's there if it fails. */
export function loadSettings(): Promise<void> {
	return persist(() => call("getSettings")).then(
		(settings) => set({ settings: complete(settings) }),
		() => {},
	);
}

/**
 * Loads initial state and subscribes to pushes. Call once at startup. Each value lands as it
 * arrives; the promise settles once all three have answered or given up.
 */
export async function startStore(): Promise<void> {
	onPush("snapshot", applySnapshot);
	onPush("engineStatus", (engineStatus) => {
		set({ engineStatus });
		// A restarted engine may have new settings
		if (engineStatus.running) void loadSettings();
	});
	await Promise.allSettled([persist(() => call("appInfo")).then((appInfo) => set({ appInfo })), persist(() => call("snapshot")).then(applySnapshot), loadSettings()]);
}

/** Replaces settings after a successful save. */
export function setSettings(settings: Settings): void {
	set({ settings: complete(settings) });
}

export function getState(): State {
	return state;
}

function subscribe(fn: () => void): () => void {
	subscribers.add(fn);
	return () => subscribers.delete(fn);
}

// ---------- Hooks ---------- //

export function useStore<T>(select: (s: State) => T): T {
	return useSyncExternalStore(subscribe, () => select(state));
}

export const useSnapshot = () => useStore((s) => s.snapshot);
export const useTorrents = () => useStore((s) => s.snapshot?.torrents ?? EMPTY);
export const useEngine = () => useStore((s) => s.snapshot?.engine ?? null);
export const useHistory = () => useStore((s) => s.history);
export const useSettings = () => useStore((s) => s.settings);
export const useEngineStatus = () => useStore((s) => s.engineStatus);
export const useAppInfo = () => useStore((s) => s.appInfo);
export const useSlowTide = () => useStore((s) => s.snapshot?.slowTide ?? null);
export const useLock = () => useStore((s) => s.snapshot?.lock ?? null);

const EMPTY: never[] = [];
