import type { ReactNode } from "react";
import type { TorrentState } from "../../shared/types";

/** A wave, three crests wide, drawn at the given height. */
const wave = (y: number) => `M1 ${y} q2.25 -3 4.5 0 t4.5 0 t4.5 0`;

/** A near-flat swell, for still water. */
const flat = (y: number) => `M1 ${y} q2.25 -1.2 4.5 0 t4.5 0 t4.5 0`;

/** One small animated glyph per state, drawn in the current colour. */
const GLYPHS: Record<TorrentState, ReactNode> = {
	// The seeding streams run backwards: sinking onto the surface
	downloading: (
		<>
			<path className="si-rise si-rise--down" d="M5 14 q-2 -3 0 -6 t0 -6" />
			<path className="si-rise si-rise--down si-rise--late" d="M11 14 q-2 -3 0 -6 t0 -6" />
		</>
	),
	// Streams rising off the surface, one behind the other
	seeding: (
		<>
			<path className="si-rise" d="M5 14 q-2 -3 0 -6 t0 -6" />
			<path className="si-rise si-rise--late" d="M11 14 q-2 -3 0 -6 t0 -6" />
		</>
	),
	// A pearl resting on calm water
	done: (
		<>
			<path d={wave(11)} />
			<circle className="si-bob" cx="8" cy="5.5" r="2" />
		</>
	),
	// Slack water: two near-flat swells, breathing
	paused: (
		<>
			<path className="si-breathe" d={flat(5.5)} />
			<path className="si-breathe si-breathe--late" d={flat(10.5)} />
		</>
	),
	// Beads waiting their turn on a swell
	queued: (
		<>
			<path d={wave(11)} />
			<circle className="si-bead" cx="4" cy="5" r="1.2" fill="currentColor" stroke="none" />
			<circle className="si-bead si-bead--2" cx="8" cy="5" r="1.2" fill="currentColor" stroke="none" />
			<circle className="si-bead si-bead--3" cx="12" cy="5" r="1.2" fill="currentColor" stroke="none" />
		</>
	),
	// An eddy: two currents circling at different speeds
	checking: (
		<>
			<circle className="si-eddy" cx="8" cy="8" r="5.6" strokeDasharray="10 25.2" />
			<circle className="si-eddy si-eddy--back" cx="8" cy="8" r="2.8" strokeDasharray="6 11.6" />
		</>
	),
	// A bright crest sweeping along two swells, reading the water
	metadata: (
		<>
			<path opacity="0.3" d={wave(5)} />
			<path className="si-scan" d={wave(5)} />
			<path opacity="0.3" d={wave(11)} />
			<path className="si-scan si-scan--late" d={wave(11)} />
		</>
	),
	// A buoy bobbing, waiting to be told where to go
	waiting: (
		<>
			<path className="si-flow si-flow--slow" d={wave(12)} />
			<g className="si-bob">
				<circle cx="8" cy="6" r="2.4" />
				<path d="M8 3.6 V1.5" />
			</g>
		</>
	),
	// A broken line, flickering
	offline: (
		<>
			<path d="M1 8 q2.25 -3 4.5 0" />
			<path className="si-flicker" d="M10 8 q2.25 -3 4.5 0" />
			<circle className="si-flicker si-flicker--late" cx="8" cy="8" r="0.8" fill="currentColor" stroke="none" />
		</>
	),
	// A water-drawn exclamation mark above a choppy swell
	error: (
		<>
			<path className="si-breathe" d="M8 1.8 v5.4" />
			<circle className="si-bob" cx="8" cy="9.6" r="1" fill="currentColor" stroke="none" />
			<path className="si-flow" d={wave(14.2)} />
		</>
	),
	closed: <path opacity="0.45" d={wave(8)} />,
};

/** The animated riptide-flavoured icon for a torrent's state. */
export function StatusIcon({ state, label }: { state: TorrentState; label?: string }) {
	return (
		<svg className="si" viewBox="0 0 16 16" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label={label} aria-hidden={label ? undefined : true}>
			{GLYPHS[state]}
		</svg>
	);
}
