/**
 * Single sources of truth for labels, filters, sorting and motion presets.
 */

import type { TorrentState, TorrentSummary } from "../../shared/types";
import { etaTracker } from "../../shared/eta";

// ---------- Window ---------- //

/** Electrobun's drag-region classes for the hidden title bar. */
export const DRAG = "electrobun-webkit-app-region-drag";
export const NO_DRAG = "electrobun-webkit-app-region-no-drag";

// ---------- States ---------- //

export const STATE_LABELS: Record<TorrentState, string> = {
	metadata: "Fetching file list",
	waiting: "Choose files to start",
	checking: "Checking files",
	downloading: "Downloading",
	seeding: "Seeding",
	done: "Finished",
	paused: "Paused",
	queued: "Queued",
	offline: "Waiting for the VPN",
	error: "Stopped by an error",
	closed: "Removed",
};

/** One-word status for the list's Status column. */
export const STATUS_SHORT: Record<TorrentState, string> = {
	metadata: "Metadata",
	waiting: "Choose files",
	checking: "Checking",
	downloading: "Downloading",
	seeding: "Seeding",
	done: "Completed",
	paused: "Paused",
	queued: "Queued",
	offline: "Offline",
	error: "Error",
	closed: "Removed",
};

/** States where data is moving or about to: the row's bar shows the flow texture. */
export const ACTIVE_STATES: ReadonlySet<TorrentState> = new Set(["downloading", "seeding", "metadata", "checking"]);

/** Whether the torrent can be paused (otherwise its primary action is resume). */
export function isPausable(t: TorrentSummary): boolean {
	return !["paused", "queued", "error", "closed"].includes(t.state) && !t.paused;
}

// ---------- Filters ---------- //

export type FilterId = "all" | "downloading" | "seeding" | "completed" | "paused" | "errored";

export interface Filter {
	id: FilterId;
	label: string;
	test: (t: TorrentSummary) => boolean;
	/** Hidden from the sidebar while it matches nothing. */
	hideWhenEmpty?: boolean;
}

export const FILTERS: Filter[] = [
	{ id: "all", label: "All", test: () => true },
	{ id: "downloading", label: "Downloading", test: (t) => ["metadata", "waiting", "checking", "downloading", "queued"].includes(t.state) },
	{ id: "seeding", label: "Seeding", test: (t) => t.state === "seeding" },
	{ id: "completed", label: "Completed", test: (t) => t.hasMetadata && t.progress >= 1 },
	{ id: "paused", label: "Paused", test: (t) => t.state === "paused" },
	{ id: "errored", label: "Errors", test: (t) => t.state === "error", hideWhenEmpty: true },
];

// ---------- Sorting ---------- //

export type SortId = "added" | "name" | "size" | "progress" | "down" | "up" | "eta" | "ratio" | "status" | "seeds" | "peers";

/** Each key sorts ascending into the column's natural order: newest, biggest, fastest first; names A–Z; least time left first. */
export const SORTS: { id: SortId; label: string; key: (t: TorrentSummary) => number | string }[] = [
	{ id: "added", label: "Date added", key: (t) => -t.addedAt },
	{ id: "name", label: "Name", key: (t) => t.name.toLowerCase() },
	{ id: "size", label: "Size", key: (t) => -t.size },
	{ id: "progress", label: "Progress", key: (t) => -t.progress },
	{ id: "down", label: "Download speed", key: (t) => -t.downRate },
	{ id: "up", label: "Upload speed", key: (t) => -t.upRate },
	{ id: "eta", label: "Time left", key: (t) => remaining(t) },
	{ id: "ratio", label: "Ratio", key: (t) => -t.ratio },
	{ id: "status", label: "Status", key: (t) => STATUS_SHORT[t.state] },
	{ id: "seeds", label: "Seeds", key: (t) => -t.seeds },
	{ id: "peers", label: "Peers", key: (t) => -t.peers },
];

/** Seconds left for a torrent, for sorting and display. */
export function remaining(t: TorrentSummary): number {
	return t.state === "downloading" ? etaTracker.get(t.hash) : Infinity;
}

// ---------- Motion ---------- //

/** The spec's easing curves as arrays for motion/react. */
export const EASE_OUT = [0.22, 1, 0.36, 1] as const;
export const EASE_IN_OUT = [0.76, 0, 0.24, 1] as const;
export const EASE_SOFT = [0.33, 1, 0.68, 1] as const;

/**
 * The layer around a panel opened by the tide (see lib/tide.ts). Openings start fast and land
 * softly (ease-out); closings accelerate away (ease-in-out) in about 70% of the time.
 */
export const SHUTTER = {
	/** The scrim behind a modal: in with the water, out just after it. */
	scrim: {
		initial: { opacity: 0 },
		animate: { opacity: 1, transition: { duration: 0.24, ease: EASE_OUT } },
		exit: { opacity: 0, transition: { duration: 0.24, ease: EASE_IN_OUT, delay: 0.08 } },
	},
	/** Under reduced motion: no water, no travel, just the panel appearing. */
	still: {
		initial: { opacity: 0 },
		animate: { opacity: 1, transition: { duration: 0.18, ease: EASE_OUT } },
		exit: { opacity: 0, transition: { duration: 0.14, ease: EASE_OUT } },
	},
} as const;

/** Small things that pop from where they were triggered (menus, popovers); their origin is the trigger. */
export const POP = {
	initial: { opacity: 0, scale: 0.96 },
	animate: { opacity: 1, scale: 1, transition: { duration: 0.18, ease: EASE_OUT, opacity: { duration: 0.12, ease: "linear" } } },
	exit: { opacity: 0, scale: 0.98, transition: { duration: 0.12, ease: EASE_OUT } },
} as const;
