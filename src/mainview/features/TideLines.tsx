import { useRef } from "react";
import { cssToken, withAlpha } from "../lib/color";
import { useCanvasLoop, type FrameInfo } from "../lib/hooks";

interface TideLinesProps {
	/** Live engine totals, bytes per second; the rip runs harder while data moves. */
	down: number;
	up: number;
	className?: string;
}

/** Wave crests on screen at once, from the horizon to the shore. */
const CRESTS = 11;

/** Seconds for one crest to travel from the horizon to the shore. */
const CREST_S = 14;

/** Seconds for the tide to go out and come back in. */
const TIDE_S = 24;

/** Points along each crest. */
const SEGMENTS = 96;

/** Brightness levels the motes are drawn in, one fill each. */
const MOTE_LEVELS = 4;

/** One mote carried out to sea by the rip. */
interface Mote {
	/** Across the channel, -1..1, and out from the shore, 0 (shore) to 1 (horizon). */
	u: number;
	v: number;
	speed: number;
	size: number;
}

/** Colours read once from the tokens. */
function tokens() {
	return { sea: cssToken("--sea"), accent: cssToken("--accent-strong"), ink: cssToken("--ink") };
}

/** How much of the rip channel is at `x` (0..1 across the width): 1 at its middle, 0 outside it. */
const channel = (x: number, centre: number) => Math.exp(-(((x - centre) / 0.13) ** 2));

/**
 * The surf zone seen from above. Crests roll in from the horizon, bunching and brightening as
 * they near the shore, while the shore's wash rises and falls with the tide. Through the middle
 * a rip channel breaks the crests open: there the waves fade and bow back out to sea, and
 * bronze motes ride the current outward, fanning into the rip's head beyond the break. Moving
 * data runs the rip harder. Decorative only.
 */
export function TideLines({ down, up, className = "" }: TideLinesProps) {
	const canvas = useRef<HTMLCanvasElement>(null);
	const colors = useRef<ReturnType<typeof tokens> | null>(null);
	const motes = useRef<Mote[]>([]);
	const live = useRef({ down, up });
	live.current = { down, up };

	/** A mote starting in the feeder at the shore, near the channel. */
	const spawn = (anywhere: boolean): Mote => ({
		u: (Math.random() * 2 - 1) * 0.6,
		v: anywhere ? Math.random() : Math.random() * 0.08,
		speed: 0.6 + Math.random() * 0.7,
		size: 0.8 + Math.random() * 1.1,
	});

	useCanvasLoop(
		canvas,
		({ ctx, width: w, height: h, dt, time, still }: FrameInfo) => {
			if (w === 0 || h === 0) return;
			const c = (colors.current ??= tokens());
			const t = still ? CREST_S * 0.37 : time;
			const total = live.current.down + live.current.up;
			const pull = 0.45 + Math.min(1, Math.log10(1 + total / 10_000) / 4) * 0.55; // 0.45 idle, 1 busy
			ctx.clearRect(0, 0, w, h);

			// The tide: the shore's wash line, low in the frame, rising and falling
			const tide = Math.sin((t / TIDE_S) * Math.PI * 2);
			const shore = h * (0.86 - tide * 0.04);
			// The channel wanders a little, as rips do
			const centre = 0.5 + Math.sin(t * 0.09) * 0.05;

			// Crests: depth p runs 0 at the horizon to 1 at the shore; spacing widens toward the
			// viewer, so the sea reads as receding
			ctx.lineCap = "round";
			for (let k = 0; k < CRESTS; k++) {
				const p = (k / CRESTS + t / CREST_S) % 1;
				const y0 = shore * p ** 1.55;
				const breaking = Math.max(0, (p - 0.72) / 0.28); // the last stretch before the shore
				const fadeIn = Math.min(1, p / 0.18);
				const fadeOut = 1 - breaking ** 3;
				const base = fadeIn * fadeOut * (0.2 + p * 0.55);
				if (base <= 0.01) continue;

				// One stroke per crest, its colour fading out through the channel
				ctx.beginPath();
				for (let s = 0; s <= SEGMENTS; s++) {
					const x = s / SEGMENTS;
					// Swell undulates the crest; the rip bows it back out to sea
					const swell = Math.sin(x * 7 + k * 1.3 + t * 0.35) * 2.2 + Math.sin(x * 17 - t * 0.6 + k) * 0.8;
					const y = y0 + swell * (0.4 + p) - channel(x, centre) * pull * (10 + p * 26);
					if (s === 0) ctx.moveTo(x * w, y);
					else ctx.lineTo(x * w, y);
				}
				const tone = breaking > 0.3 ? c.ink : c.sea;
				const a = base * (breaking > 0.3 ? 0.55 : 1);
				const fade = ctx.createLinearGradient(0, 0, w, 0);
				for (const x of [0, centre - 0.2, centre - 0.08, centre, centre + 0.08, centre + 0.2, 1]) {
					fade.addColorStop(Math.min(1, Math.max(0, x)), withAlpha(tone, a * (1 - channel(x, centre) * (0.75 + 0.22 * pull))));
				}
				ctx.lineWidth = 0.75 + p * 1.6 + breaking * 1.2;
				ctx.strokeStyle = fade;
				ctx.stroke();
			}

			// The wash: a soft line of foam at the shore, broken where the rip feeds
			ctx.beginPath();
			for (let s = 0; s <= SEGMENTS; s++) {
				const x = s / SEGMENTS;
				const y = shore + 6 + Math.sin(x * 11 + t * 0.8) * 1.5 + Math.sin(x * 29 - t * 1.3) * 0.7;
				if (s === 0) ctx.moveTo(x * w, y);
				else ctx.lineTo(x * w, y);
			}
			ctx.lineWidth = 1.5;
			ctx.strokeStyle = withAlpha(c.ink, 0.22);
			ctx.stroke();
			// The sand: a flat step of bronze below the wash
			ctx.fillStyle = withAlpha(c.accent, 0.06);
			ctx.fillRect(0, shore + 7, w, h - shore - 7);

			// Motes: drawn in from the sides along the shore, then carried out through the neck and
			// spread into the head
			const ms = motes.current;
			const target = Math.round(28 + pull * 34);
			// The first fill (and a still frame) spreads them along the whole current
			const scatter = still || ms.length === 0;
			while (ms.length < target) ms.push(spawn(scatter));
			if (ms.length > target) ms.length = target;
			const step = still ? 0 : dt;
			// Batched by brightness, so all the motes cost a few fills rather than one each
			const batches = Array.from({ length: MOTE_LEVELS }, () => new Path2D());
			for (let i = 0; i < ms.length; i++) {
				const m = ms[i]!;
				const neck = m.v < 0.45;
				// Converge into the neck, then fan out beyond the break
				m.u += (neck ? -m.u * 0.5 : m.u * 0.9 + Math.sin(t + i) * 0.05) * step * 0.35;
				m.v += m.speed * pull * step * (neck ? 0.11 : 0.07);
				if (m.v > 1 || Math.abs(m.u) > 1.4) ms[i] = spawn(false);

				// Narrow through the neck, then fanning wide into the head
				const x = (centre + m.u * (0.07 + Math.max(0, m.v - 0.35) ** 1.4 * 0.7)) * w;
				const y = shore - shore * m.v ** 0.8;
				const a = Math.min(1, m.v / 0.1) * (1 - m.v);
				const r = m.size * (1 - m.v * 0.5);
				const batch = batches[Math.min(MOTE_LEVELS - 1, Math.floor(a * MOTE_LEVELS))]!;
				batch.moveTo(x + r, y);
				batch.arc(x, y, r, 0, Math.PI * 2);
			}
			for (let b = 0; b < MOTE_LEVELS; b++) {
				ctx.fillStyle = withAlpha(c.accent, ((b + 1) / MOTE_LEVELS) * 0.9);
				ctx.fill(batches[b]!);
			}
		},
		// Half the frames while nothing transfers: the tide moves slowly enough not to show it
		() => (live.current.down + live.current.up > 0 ? 24 : 15),
	);

	return <canvas ref={canvas} className={`tide-lines ${className}`} aria-hidden />;
}
