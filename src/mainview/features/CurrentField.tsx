import { useRef } from "react";
import { cssToken, withAlpha } from "../lib/color";
import { useCanvasLoop, type FrameInfo } from "../lib/hooks";

interface CurrentFieldProps {
	/** Live engine totals, bytes per second. */
	down: number;
	up: number;
	/** Connected peers; adds density. */
	peers: number;
	className?: string;
}

/** One streamline tracer. */
interface Particle {
	x: number;
	y: number;
	/** Inbound (download, bronze) or outbound (upload, sea). */
	out: boolean;
	life: number;
}

/** Colours read once from the tokens. */
function tokens() {
	return { accent: cssToken("--accent"), sea: cssToken("--sea") };
}

/**
 * The velocity of a rip current at a point. u runs -1..1 across the width (0 is the centre);
 * v runs 0 (the shore, at the bottom) to 1 (out to sea, at the top). Water feeds in along the
 * shore from both sides, squeezes through a narrow neck at mid-height, then fans out into a
 * head that curls back at its edges.
 */
function velocity(u: number, v: number, t: number): [number, number] {
	const neck = 0.52;
	const wobble = Math.sin(v * 9 + t * 0.7) * 0.08 + Math.sin(u * 5 - t * 0.4) * 0.05;
	if (v < neck) {
		// Feeder currents: converge toward the centre, accelerating as they rise
		const pull = 1 - v / neck;
		return [-u * (0.9 + pull * 0.8) + wobble, 0.25 + (1 - Math.abs(u)) * 0.95];
	}
	// The head: spread outward and slow down, curling back down at the sides
	const h = (v - neck) / (1 - neck);
	const curl = Math.abs(u) > 0.45 ? -(Math.abs(u) - 0.45) * 2.2 * h : 0;
	return [u * (0.6 + h * 1.4) + wobble, Math.max(-0.9, 1.1 - h * 1.25) + curl];
}

/**
 * The current: a field of streamlines in the shape of a rip current, moving as fast as the
 * engine transfers. Bronze tracers are bytes coming in, sea tracers bytes going out; their mix
 * follows the ratio of the two rates. Downloads flow down, uploads flow up. Idle, it falls almost still. Decorative only: it takes no
 * input and sits under nothing that must be read.
 */
export function CurrentField({ down, up, peers, className = "" }: CurrentFieldProps) {
	const canvas = useRef<HTMLCanvasElement>(null);
	const particles = useRef<Particle[]>([]);
	const colors = useRef<ReturnType<typeof tokens> | null>(null);
	const live = useRef({ down, up, peers });
	live.current = { down, up, peers };
	/** Clock time of the last sweep for near-invisible leftovers. */
	const swept = useRef(0);

	/** A tracer starting along the shore (the bottom) or low on either side. */
	const spawn = (w: number, h: number, outShare: number): Particle => {
		const side = Math.random();
		const x = side < 0.7 ? Math.random() * w : side < 0.85 ? Math.random() * w * 0.08 : w - Math.random() * w * 0.08;
		const y = side < 0.7 ? h - Math.random() * h * 0.06 : h * (0.55 + Math.random() * 0.45);
		return { x, y, out: Math.random() < outShare, life: 3 + Math.random() * 6 };
	};

	/** Half the frame rate while nothing moves: at idle speeds the tracers barely cross a pixel a frame. */
	const fps = () => (live.current.down + live.current.up > 0 ? 30 : 15);

	useCanvasLoop(canvas, ({ ctx, width: w, height: h, dt, time, still }: FrameInfo) => {
		if (w === 0 || h === 0) return;
		const c = (colors.current ??= tokens());
		const { down, up, peers } = live.current;
		const total = down + up;

		// Speed and density follow the totals on a log scale
		const intensity = Math.log10(1 + total / 10_000) / 4; // ~0 idle, ~1 at 100 MB/s
		const speed = (0.035 + Math.min(1.4, intensity) * 0.55) * h; // px/s at unit velocity
		const target = Math.round(Math.min(260, 26 + intensity * 170 + Math.min(peers, 60)));
		const outShare = total > 0 ? up / total : 0.18;

		// Keep the population at its target
		const ps = particles.current;
		while (ps.length < target) ps.push(spawn(w, h, outShare));
		if (ps.length > target) ps.length = target;

		// A still frame traces whole streamlines at once; a live frame advances one step
		const steps = still ? 90 : 1;
		const step = still ? 1 / 30 : dt;
		if (still) {
			ctx.clearRect(0, 0, w, h);
		} else {
			// Fade earlier frames toward transparent, leaving trails over the real background. The
			// fade is 16% a frame at 30 fps and scales with the frame time, so trails keep their
			// length when the loop slows down
			const fade = 1 - 0.84 ** (dt * 30);
			ctx.globalCompositeOperation = "destination-out";
			ctx.fillStyle = `rgb(0 0 0 / ${fade.toFixed(3)})`;
			ctx.fillRect(0, 0, w, h);
			ctx.globalCompositeOperation = "source-over";

			// 8-bit alpha rounds back up, so a multiplicative fade never reaches zero and faint
			// ghosts pile up into hard-edged bands. Every so often, snap near-invisible pixels to clear
			// (a full-canvas readback, so it runs about once a second rather than every few frames).
			if (time - swept.current >= 1) {
				swept.current = time;
				const img = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
				const px = img.data;
				for (let i = 3; i < px.length; i += 4) if (px[i]! < 14) px[i] = 0;
				ctx.putImageData(img, 0, 0);
			}
		}
		ctx.lineWidth = 1.25;
		ctx.lineCap = "round";
		const inbound = new Path2D();
		const outbound = new Path2D();
		for (let s = 0; s < steps; s++) {
			for (let i = 0; i < ps.length; i++) {
				const p = ps[i]!;
				const u = (p.x / w) * 2 - 1;
				const v = 1 - p.y / h;
				const [vx, vy] = velocity(u, v, time + s * step);
				const nx = p.x + vx * speed * step * 0.5;
				const ny = p.y - vy * speed * step;

				// Add the segment; the field flows up, so outbound (upload) draws as simulated and
				// inbound (download) is point-reflected to run down
				if (p.out) {
					outbound.moveTo(p.x, p.y);
					outbound.lineTo(nx, ny);
				} else {
					inbound.moveTo(w - p.x, h - p.y);
					inbound.lineTo(w - nx, h - ny);
				}

				// Move on, or start again at the shore
				p.x = nx;
				p.y = ny;
				p.life -= step;
				if (p.life <= 0 || p.y < -4 || p.y > h + 4 || p.x < -4 || p.x > w + 4) ps[i] = spawn(w, h, outShare);
			}
		}

		// One stroke per colour
		const alpha = still ? 0.35 : 0.85;
		ctx.strokeStyle = withAlpha(c.accent, alpha);
		ctx.stroke(inbound);
		ctx.strokeStyle = withAlpha(c.sea, alpha);
		ctx.stroke(outbound);
	}, fps);

	return <canvas ref={canvas} className={`current ${className}`} aria-hidden />;
}
