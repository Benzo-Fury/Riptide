import { useEffect, useRef } from "react";
import { cssToken, withAlpha } from "../lib/color";
import { useReducedMotion } from "../lib/hooks";

/** Distance between the bed's pieces, in CSS pixels. */
const SPACING = 14;

/** Pieces drifting in the trickle at once, and the most a visitor can add by clicking. */
const TRICKLE = 24;
const DROPPED_MAX = 12;

/** How fast the trickle runs at its centre, in px/s. Slow on purpose: the current is nearly gone. */
const FLOW = 16;

/** How far the pointer, a stone in the stream, turns the trickle aside. */
const STONE = 64;

/** Shimmer levels for the wet channel, one fill each. */
const GLINT_LEVELS = 5;

/** Resting brightness levels for the dry bed, one fill each. */
const BED_LEVELS = 5;

/** A streak's pieces behind each drifting one, and their spacing along the flow. */
const TAIL = [1, 0.55, 0.3, 0.12];
const TAIL_GAP = 3;

// ---------- Geometry: one meandering channel across the canvas ---------- //

/** The channel's centre line at `x`, in a `w` × `h` canvas. */
const centre = (x: number, w: number, h: number) => {
	const t = (x / w) * Math.PI * 2;
	return h / 2 + h * 0.15 * Math.sin(t * 0.8 + 0.6) + h * 0.045 * Math.sin(t * 2.1 + 1.9);
};

/** Half the width of the dry bed, and of the thin wet line still running down its middle. */
const bedHalf = (x: number, w: number, h: number) => h * (0.3 + 0.04 * Math.sin((x / w) * 7 + 0.4));
const wetHalf = (x: number, w: number, h: number) => h * (0.045 + 0.018 * Math.sin((x / w) * 11 + 2.2));

/** 0..1 across the canvas: the stream comes in from nothing and runs out to nothing. */
const ends = (x: number, w: number) => {
	const e = Math.min(x, w - x) / (w * 0.18);
	return Math.max(0, Math.min(1, e)) ** 1.5;
};

interface BedPiece {
	x: number;
	y: number;
	/** 1..BED_LEVELS for dry pieces; 0 when the piece sits in the wet line and glints instead. */
	level: number;
	/** How deep in the wet line, 0..1, which sets how strongly it glints. */
	wet: number;
}

/** The streambed's resting pieces for a `w` × `h` canvas. */
function bedFor(w: number, h: number): BedPiece[] {
	const cols = Math.max(1, Math.floor(w / SPACING));
	const rows = Math.max(1, Math.floor(h / SPACING));
	const ox = (w - (cols - 1) * SPACING) / 2;
	const oy = (h - (rows - 1) * SPACING) / 2;
	const pieces: BedPiece[] = [];
	for (let r = 0; r < rows; r++)
		for (let c = 0; c < cols; c++) {
			const x = ox + c * SPACING;
			const y = oy + r * SPACING;
			const off = Math.abs(y - centre(x, w, h));
			const fade = ends(x, w);
			// Inside the wet line: a glinting piece
			const wh = wetHalf(x, w, h) + SPACING * 0.5;
			if (off < wh) {
				if (fade > 0.04) pieces.push({ x, y, level: 0, wet: (1 - off / wh) * fade });
				continue;
			}
			// On the dry bed: dimmer toward the banks, gone past them
			const n = off / bedHalf(x, w, h);
			if (n >= 1) continue;
			const level = Math.round((1 - n) ** 0.9 * fade * BED_LEVELS);
			if (level > 0) pieces.push({ x, y, level, wet: 0 });
		}
	return pieces;
}

interface Drift {
	x: number;
	/** Place across the wet line, in its half-widths: 0 is the middle. */
	lane: number;
	/** Each piece's own pace, so the trickle never moves in step. */
	pace: number;
	/** Sideways push from the stone, in px, easing back to 0. */
	push: number;
	/** Bronze pieces are data arriving; the rest are water. */
	bronze: boolean;
	/** Added by a click: it eases into the wet line and leaves at the far end. */
	dropped: boolean;
}

/** A lane biased toward the middle: most of what's left of the current runs down the centre. */
const randomLane = () => (Math.random() * 2 - 1) * (0.35 + Math.random() * 0.65);

function driftAt(x: number): Drift {
	return { x, lane: randomLane(), pace: 0.7 + Math.random() * 0.6, push: 0, bronze: Math.random() < 0.14, dropped: false };
}

/**
 * Low water for the empty views: the bed of a stream with almost nothing in it. A dry bed of
 * resting pieces, a thin wet line down its middle that glints as the last of the current slides
 * over it, and a sparse trickle of pieces drifting slowly downstream, now and then a bronze one,
 * like data that hasn't started arriving. The pointer is a stone the trickle parts around; a click
 * drops a few bronze pieces into the bed, and they ease into the current and drift away.
 *
 * The trickle runs continuously but cheaply: a few hundred batched rects a frame, paused while the
 * window is hidden. Under reduced motion it is a still bed with the trickle stopped in place.
 * Decorative only.
 */
export function LowWater({ className = "" }: { className?: string }) {
	const canvas = useRef<HTMLCanvasElement>(null);
	const reduced = useReducedMotion();

	useEffect(() => {
		const el = canvas.current;
		const host = el?.parentElement;
		const ctx = el?.getContext("2d");
		if (!el || !host || !ctx) return;

		const colors = { bed: cssToken("--muted"), sea: cssToken("--sea"), accent: cssToken("--accent") };
		let width = 0;
		let height = 0;
		let bed: BedPiece[] = [];
		let drifts: Drift[] = [];
		/** The stone, in canvas pixels; null while the pointer is away. */
		let stone: { x: number; y: number } | null = null;
		let raf = 0;
		let last = 0;
		let time = 0;

		// ---------- Drawing ---------- //

		const yOf = (d: Drift) => centre(d.x, width, height) + d.lane * wetHalf(d.x, width, height) * 1.4 + d.push;

		const draw = () => {
			ctx.clearRect(0, 0, width, height);

			// The dry bed, one fill per brightness level
			const dry = Array.from({ length: BED_LEVELS + 1 }, () => new Path2D());
			// The wet line, its glint travelling slowly downstream
			const glint = Array.from({ length: GLINT_LEVELS }, () => new Path2D());
			for (const p of bed) {
				if (p.level) {
					dry[p.level]!.rect(p.x - 1, p.y - 1, 2, 2);
					continue;
				}
				const wave = 0.5 + 0.5 * Math.sin(p.x * 0.045 - time * 0.9 + Math.sin(p.y * 0.2) * 0.8);
				const g = Math.min(GLINT_LEVELS - 1, Math.floor(p.wet * (0.35 + wave * 0.65) * GLINT_LEVELS));
				glint[g]!.rect(p.x - 1, p.y - 1, 2, 2);
			}
			ctx.fillStyle = colors.bed;
			for (let l = 1; l <= BED_LEVELS; l++) {
				ctx.globalAlpha = (l / BED_LEVELS) * 0.34;
				ctx.fill(dry[l]!);
			}
			ctx.fillStyle = colors.sea;
			for (let g = 0; g < GLINT_LEVELS; g++) {
				ctx.globalAlpha = 0.2 + (g / (GLINT_LEVELS - 1)) * 0.55;
				ctx.fill(glint[g]!);
			}

			// The trickle: each piece with a short fading streak behind it
			ctx.globalAlpha = 1;
			for (const d of drifts) {
				const fade = ends(d.x, width);
				if (fade <= 0.02) continue;
				for (let k = 0; k < TAIL.length; k++) {
					const x = d.x - k * TAIL_GAP;
					const y = centre(x, width, height) + d.lane * wetHalf(x, width, height) * 1.4 + d.push;
					const size = k === 0 ? 3 : 2;
					ctx.fillStyle = withAlpha(d.bronze ? colors.accent : colors.sea, TAIL[k]! * fade * (d.bronze ? 1 : 0.85));
					ctx.fillRect(x - size / 2, y - size / 2, size, size);
				}
			}
		};

		// ---------- Motion ---------- //

		const step = (dt: number) => {
			time += dt;
			for (let n = drifts.length - 1; n >= 0; n--) {
				const d = drifts[n]!;
				// Laminar: the middle of the line runs faster than its edges
				let speed = FLOW * d.pace * (1 - 0.45 * Math.min(1, d.lane * d.lane));

				// The stone parts the trickle and slows what passes it
				const y = yOf(d);
				const near = stone ? Math.hypot(d.x - stone.x, y - stone.y) : Infinity;
				if (stone && near < STONE) {
					const k = (1 - near / STONE) ** 2;
					const side = y >= stone.y ? 1 : -1;
					d.push += (side * k * 22 - d.push * 0.2) * Math.min(1, dt * 5);
					speed *= 1 - 0.55 * k;
				} else d.push *= Math.exp(-1.6 * dt);

				// A dropped piece eases into the current; every piece wanders a little
				if (d.dropped) d.lane *= Math.exp(-0.7 * dt);
				d.lane += (Math.random() - 0.5) * 0.25 * dt;
				d.lane = Math.max(-2.5, Math.min(2.5, d.lane));
				d.x += speed * dt;

				// Out the far end: water comes round again, dropped pieces are gone
				if (d.x > width + TAIL.length * TAIL_GAP) {
					if (d.dropped) drifts.splice(n, 1);
					else Object.assign(d, driftAt(-Math.random() * width * 0.2));
				}
			}
		};

		// ---------- Loop: paused while the window is hidden ---------- //

		const tick = (now: number) => {
			const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
			last = now;
			step(dt);
			draw();
			raf = requestAnimationFrame(tick);
		};
		const start = () => {
			if (!raf && !reduced && !document.hidden) raf = requestAnimationFrame(tick);
		};
		const stop = () => {
			cancelAnimationFrame(raf);
			raf = 0;
			last = 0;
		};
		const onVisibility = () => (document.hidden ? stop() : start());

		// ---------- Size ---------- //

		const resize = () => {
			const rect = el.getBoundingClientRect();
			const dpr = Math.min(2, window.devicePixelRatio || 1);
			if (rect.width === width && rect.height === height) return;
			const sx = width ? rect.width / width : 1;
			width = rect.width;
			height = rect.height;
			el.width = Math.max(1, Math.round(width * dpr));
			el.height = Math.max(1, Math.round(height * dpr));
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			bed = bedFor(width, height);
			// The trickle keeps its place along the stream, or is laid out fresh on first size
			if (drifts.length) for (const d of drifts) d.x *= sx;
			else drifts = Array.from({ length: TRICKLE }, () => driftAt(Math.random() * width));
			draw();
		};
		const observer = new ResizeObserver(resize);
		observer.observe(el);
		resize();

		// ---------- Input, from anywhere over the empty view ---------- //

		const local = (e: PointerEvent) => {
			const rect = el.getBoundingClientRect();
			return { x: e.clientX - rect.left, y: e.clientY - rect.top };
		};
		const onMove = (e: PointerEvent) => {
			stone = local(e);
		};
		const onLeave = () => {
			stone = null;
		};
		const onDown = (e: PointerEvent) => {
			if (e.button !== 0 || (e.target as Element).closest("button, a, input")) return;
			const p = local(e);
			if (p.x < 0 || p.x > width || p.y < -STONE || p.y > height + STONE) return;
			// A few bronze pieces, set down where the click landed, measured in the line's half-widths
			const lane = (p.y - centre(p.x, width, height)) / (wetHalf(p.x, width, height) * 1.4);
			const dropped = drifts.filter((d) => d.dropped).length;
			for (let i = 0; i < Math.min(3, DROPPED_MAX - dropped); i++)
				drifts.push({ x: p.x + (i - 1) * 6, lane: Math.max(-2.5, Math.min(2.5, lane + (Math.random() - 0.5) * 0.6)), pace: 0.8 + Math.random() * 0.4, push: 0, bronze: true, dropped: true });
		};

		if (!reduced) {
			host.addEventListener("pointermove", onMove);
			host.addEventListener("pointerleave", onLeave);
			host.addEventListener("pointerdown", onDown);
			document.addEventListener("visibilitychange", onVisibility);
			start();
			return () => {
				stop();
				observer.disconnect();
				host.removeEventListener("pointermove", onMove);
				host.removeEventListener("pointerleave", onLeave);
				host.removeEventListener("pointerdown", onDown);
				document.removeEventListener("visibilitychange", onVisibility);
			};
		}
		return () => observer.disconnect();
	}, [reduced]);

	return <canvas ref={canvas} className={`low-water ${className}`} aria-hidden />;
}
