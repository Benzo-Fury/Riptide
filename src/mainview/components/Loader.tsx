import { useRef, type ReactNode } from "react";
import { motion } from "motion/react";
import { EASE_OUT } from "../lib/constants";
import { cssToken, withAlpha } from "../lib/color";
import { useCanvasLoop, type FrameInfo } from "../lib/hooks";

interface LoaderProps {
	/** What's being waited for, set large: "Reading settings". */
	label: string;
	/** A quieter line under the label. */
	detail?: ReactNode;
	/** Shown under everything once the wait is in trouble (a retry button). */
	action?: ReactNode;
}

/** One tracer in the whirlpool, in polar coordinates around the eye. */
interface Tracer {
	/** Distance from the eye: 1 is the rim, 0 the bottom of the funnel. */
	r: number;
	theta: number;
	/** Upload-coloured (sea) rather than bronze. */
	sea: boolean;
}

/** Tracers per 10,000 px² of loader, and the most there can be. */
const DENSITY = 0.85;
const MAX_TRACERS = 520;
/** Where tracers sink out of sight and start again at the rim. */
const EYE = 0.07;
/** Tilt of the whirlpool's plane: the vertical squash of its rings. */
const TILT = 0.36;
/** Alpha bands, rim to eye; tracers are batched into one path per band and colour. */
const BANDS = [0.22, 0.5, 0.85];

/** A tracer starting somewhere along the outer water. */
function spawn(anywhere: boolean): Tracer {
	return { r: anywhere ? EYE + Math.random() * (1.15 - EYE) : 0.9 + Math.random() * 0.3, theta: Math.random() * Math.PI * 2, sea: Math.random() < 0.22 };
}

/**
 * A full-area wait: a whirlpool seen at a tilt, its tracers spiralling faster as they fall
 * into a funnel under the label. Fades in after a beat, so a quick load never flashes it.
 * Fills its nearest positioned ancestor; decorative apart from the text, which is announced.
 */
export function Loader({ label, detail, action }: LoaderProps) {
	const canvas = useRef<HTMLCanvasElement>(null);
	const tracers = useRef<Tracer[]>([]);
	const colors = useRef<{ accent: string; sea: string } | null>(null);

	useCanvasLoop(canvas, ({ ctx, width: w, height: h, dt, time, still }: FrameInfo) => {
		if (w === 0 || h === 0) return;
		const c = (colors.current ??= { accent: cssToken("--accent"), sea: cssToken("--sea") });

		// The eye sits above the label; the rim reaches past the edges
		const cx = w / 2;
		const cy = h * 0.42;
		const R = Math.max(w * 0.62, h * 0.9);
		const depth = h * 0.16;

		// Screen position of a polar point: a tilted ring that sinks as it nears the eye
		const at = (r: number, theta: number): [number, number] => {
			const sink = (1 - Math.min(1, r)) ** 3 * depth;
			return [cx + Math.cos(theta) * r * R, cy + Math.sin(theta) * r * R * TILT + sink];
		};

		// Keep the population in step with the area
		const ts = tracers.current;
		const target = Math.min(MAX_TRACERS, Math.round(((w * h) / 10_000) * DENSITY));
		while (ts.length < target) ts.push(spawn(true));
		if (ts.length > target) ts.length = target;

		// A still frame clears and traces whole arcs; a live one fades the last into trails
		if (still) {
			ctx.clearRect(0, 0, w, h);
		} else {
			ctx.globalCompositeOperation = "destination-out";
			ctx.fillStyle = "rgb(0 0 0 / 0.14)";
			ctx.fillRect(0, 0, w, h);
			ctx.globalCompositeOperation = "source-over";
		}

		// Guide rings drifting inward, one every few seconds (faint: the trails stack them up)
		ctx.lineWidth = 1;
		for (let i = 0; i < 4; i++) {
			const r = 1.1 - ((time * 0.05 + i / 4) % 1) * (1.1 - EYE * 2);
			ctx.strokeStyle = withAlpha(c.accent, 0.016 * Math.min(1, r * 2));
			ctx.beginPath();
			const [, y] = at(r, Math.PI / 2);
			const [, y0] = at(r, -Math.PI / 2);
			ctx.ellipse(cx, (y + y0) / 2, r * R, (y - y0) / 2, 0, 0, Math.PI * 2);
			ctx.stroke();
		}

		// Advance every tracer: faster spin and stronger pull the deeper it is
		const paths = BANDS.map(() => ({ bronze: new Path2D(), sea: new Path2D() }));
		const steps = still ? 40 : 1;
		const step = still ? 1 / 20 : dt;
		for (let s = 0; s < steps; s++) {
			for (let i = 0; i < ts.length; i++) {
				const t = ts[i]!;
				const deep = 1 - Math.min(1, t.r);
				const spin = 0.22 + 2.4 * deep ** 2.2;
				const pull = 0.035 + 0.16 * deep ** 1.5;
				const [x0, y0] = at(t.r, t.theta);
				t.theta += spin * step;
				t.r -= pull * step;
				const [x1, y1] = at(t.r, t.theta);

				// Batch by depth, so tracers brighten as they fall
				const band = deep < 0.45 ? 0 : deep < 0.8 ? 1 : 2;
				const path = t.sea ? paths[band]!.sea : paths[band]!.bronze;
				path.moveTo(x0, y0);
				path.lineTo(x1, y1);

				// Gone into the eye: start again at the rim
				if (t.r < EYE) ts[i] = spawn(false);
			}
		}

		// One stroke per band and colour
		ctx.lineCap = "round";
		paths.forEach((p, band) => {
			const alpha = BANDS[band]! * (still ? 0.6 : 1);
			ctx.lineWidth = 1 + band * 0.35;
			ctx.strokeStyle = withAlpha(c.accent, alpha);
			ctx.stroke(p.bronze);
			ctx.strokeStyle = withAlpha(c.sea, alpha);
			ctx.stroke(p.sea);
		});
	});

	return (
		<motion.div className="loader" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.15, duration: 0.6, ease: EASE_OUT }}>
			<canvas ref={canvas} className="loader__field" aria-hidden />
			<div className="loader__eye" aria-hidden />
			<div className="loader__copy" role="status" aria-live="polite">
				<span className="loader__label">{label}</span>
				{detail && <span className="loader__detail">{detail}</span>}
				{action && <div className="loader__action">{action}</div>}
			</div>
		</motion.div>
	);
}
