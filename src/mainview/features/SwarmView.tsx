import { useEffect, useRef, useState, type PointerEvent } from "react";
import type { PeerInfo } from "../../shared/types";
import { formatBytes, formatRate } from "../../shared/format";
import { cssToken, withAlpha } from "../lib/color";
import { useCanvasLoop, type FrameInfo } from "../lib/hooks";

interface SwarmViewProps {
	peers: PeerInfo[];
	/** Shown in the middle under "You". */
	caption: string;
}

/** A peer as drawn: where it sits, and when it arrived or left (for fading in and out). */
interface Node {
	peer: PeerInfo;
	/** 0 to 2π, from the address, so a peer keeps its place. */
	angle: number;
	jitter: number;
	/** Seconds on the loop's clock. */
	born: number;
	gone: number | null;
	/** Particles to emit, carried between frames. */
	inbound: number;
	outbound: number;
	/** Last drawn position, for hovering. */
	x: number;
	y: number;
}

/** A packet of data on its way: from a peer to you (in) or from you to a peer (out). */
interface Particle {
	address: string;
	inbound: boolean;
	/** 0 at the start of its trip, 1 at the end. */
	t: number;
	/** Trips per second. */
	speed: number;
	/** Sideways offset, so streams have width. */
	lane: number;
}

/** Round trips mapped onto the orbits: 1 ms at the inner ring, 1 s at the outer. */
const RTT_NEAR = 1;
const RTT_FAR = 1000;
const RINGS = [1, 10, 100, 1000];
/** Seconds a peer takes to appear or fade away. */
const FADE = 0.7;
const MAX_PARTICLES = 900;

/** A well-mixed 32-bit hash of an address (FNV-1a, then a finaliser so near addresses spread). */
function hashOf(address: string): number {
	let h = 2166136261;
	for (let i = 0; i < address.length; i++) h = Math.imul(h ^ address.charCodeAt(i), 16777619);
	h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
	h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
	return (h ^ (h >>> 16)) >>> 0;
}

/** A stable angle for an address, so peers don't jump around between refreshes. */
function angleOf(address: string): number {
	return (hashOf(address) / 2 ** 32) * Math.PI * 2;
}

/** A small stable nudge off the orbit, so peers with the same round trip don't stack. */
function jitterOf(address: string): number {
	return (hashOf(`${address}#`) / 2 ** 32 - 0.5) * 0.12;
}

/** Where on the orbits a round trip sits: 0 is the inner ring, 1 the outer; unknown is outermost. */
function orbitOf(rttMs: number): number {
	if (!rttMs) return 1.05;
	return Math.min(1.05, Math.max(0, Math.log(rttMs / RTT_NEAR) / Math.log(RTT_FAR / RTT_NEAR)));
}

/** Particles a second for a rate: none at rest, about 3 at 16 kB/s, about 30 at 100 MB/s. */
function emission(rate: number): number {
	return rate <= 0 ? 0 : Math.min(32, 1.5 + Math.log2(1 + rate / 16_000) * 2.4);
}

/**
 * The swarm, live: you in the middle, each connected peer on an orbit set by its round trip.
 * Bronze packets stream in from the peers sending to you, sea ones out to the peers you serve,
 * as fast and as dense as the bytes. Seeds are solid, other peers hollow. Hover a peer for its
 * details; the table in the Peers tab has the same data to read.
 */
export function SwarmView({ peers, caption }: SwarmViewProps) {
	const canvas = useRef<HTMLCanvasElement>(null);
	const nodes = useRef(new Map<string, Node>());
	const particles = useRef<Particle[]>([]);
	const colors = useRef<{ accent: string; sea: string; ink: string; muted: string; ground: string } | null>(null);
	const clock = useRef(0);
	const [hover, setHover] = useState<{ peer: PeerInfo; x: number; y: number } | null>(null);

	const known = nodes.current;

	// Keep a node per peer; departed ones linger to fade out
	useEffect(() => {
		const latest = new Map(peers.map((p) => [p.address, p]));
		for (const [address, peer] of latest) {
			const n = known.get(address);
			if (n) {
				n.peer = peer;
				n.gone = null;
			} else known.set(address, { peer, angle: angleOf(address), jitter: jitterOf(address), born: clock.current, gone: null, inbound: Math.random(), outbound: Math.random(), x: 0, y: 0 });
		}
		for (const [address, n] of known) if (!latest.has(address) && n.gone === null) n.gone = clock.current;
	}, [peers, known]);

	useCanvasLoop(canvas, ({ ctx, width: w, height: h, dt, time, still }: FrameInfo) => {
		if (w === 0 || h === 0) return;
		clock.current = time;
		const c = (colors.current ??= { accent: cssToken("--accent"), sea: cssToken("--sea"), ink: cssToken("--ink"), muted: cssToken("--muted"), ground: cssToken("--surface") });
		ctx.clearRect(0, 0, w, h);

		// The orbits: a flattened disc around you
		const cx = w / 2;
		const cy = h / 2;
		const outer = Math.min(w * 0.42, h * 1.4);
		const inner = Math.max(30, outer * 0.14);
		const squash = Math.min(1, (h * 0.44) / outer);
		const radius = (orbit: number) => inner + (outer - inner) * orbit;
		const at = (angle: number, orbit: number): [number, number] => [cx + Math.cos(angle) * radius(orbit), cy + Math.sin(angle) * radius(orbit) * squash];

		ctx.lineWidth = 1;
		ctx.font = "11px Satoshi, system-ui, sans-serif";
		ctx.textAlign = "center";
		ctx.textBaseline = "bottom";
		for (const ms of RINGS) {
			const r = radius(orbitOf(ms));
			ctx.strokeStyle = withAlpha(c.ink, 0.06);
			ctx.beginPath();
			ctx.ellipse(cx, cy, r, r * squash, 0, 0, Math.PI * 2);
			ctx.stroke();
			ctx.fillStyle = withAlpha(c.muted, 0.7);
			ctx.fillText(ms >= 1000 ? `${ms / 1000} s` : `${ms} ms`, cx, cy - r * squash - 2);
		}

		// Age out peers that have finished fading
		for (const [address, n] of known) if (n.gone !== null && time - n.gone > FADE) known.delete(address);

		// Spokes and emission, peer by peer
		const ps = particles.current;
		for (const n of known.values()) {
			const [x, y] = at(n.angle, orbitOf(n.peer.rttMs) + n.jitter);
			n.x = x;
			n.y = y;
			const life = still ? 1 : Math.min(1, (time - n.born) / FADE) * (n.gone === null ? 1 : Math.max(0, 1 - (time - n.gone) / FADE));
			const busy = n.peer.downRate + n.peer.upRate > 0;
			ctx.strokeStyle = withAlpha(n.peer.downRate > 0 ? c.accent : n.peer.upRate > 0 ? c.sea : c.ink, (busy ? 0.2 : 0.05) * life);
			ctx.beginPath();
			ctx.moveTo(cx, cy);
			ctx.lineTo(x, y);
			ctx.stroke();

			if (still || n.gone !== null) continue;
			n.inbound += emission(n.peer.downRate) * dt;
			n.outbound += emission(n.peer.upRate) * dt;
			const speed = (rate: number) => 0.45 + Math.min(1.4, Math.log10(1 + rate / 50_000) * 0.5);
			for (; n.inbound >= 1 && ps.length < MAX_PARTICLES; n.inbound--) ps.push({ address: n.peer.address, inbound: true, t: 0, speed: speed(n.peer.downRate), lane: (Math.random() - 0.5) * 7 });
			for (; n.outbound >= 1 && ps.length < MAX_PARTICLES; n.outbound--) ps.push({ address: n.peer.address, inbound: false, t: 0, speed: speed(n.peer.upRate), lane: (Math.random() - 0.5) * 7 });
			n.inbound = Math.min(n.inbound, 2);
			n.outbound = Math.min(n.outbound, 2);
		}

		// Packets in flight: inbound ones gather speed as they reach you, outbound ones ease out
		const bronze = new Path2D();
		const sea = new Path2D();
		for (let i = ps.length - 1; i >= 0; i--) {
			const p = ps[i]!;
			const n = known.get(p.address);
			p.t += p.speed * dt;
			if (!n || p.t >= 1) {
				ps.splice(i, 1);
				continue;
			}
			const along = p.inbound ? p.t * p.t : 1 - (1 - p.t) * (1 - p.t);
			const [fx, fy, tx, ty] = p.inbound ? [n.x, n.y, cx, cy] : [cx, cy, n.x, n.y];
			const dx = tx - fx;
			const dy = ty - fy;
			const len = Math.hypot(dx, dy) || 1;
			const side = p.lane * Math.sin(Math.PI * along);
			const x = fx + dx * along - (dy / len) * side;
			const y = fy + dy * along + (dx / len) * side;
			const path = p.inbound ? bronze : sea;
			path.moveTo(x + 1.6, y);
			path.arc(x, y, 1.6, 0, Math.PI * 2);
		}
		ctx.fillStyle = c.accent;
		ctx.fill(bronze);
		ctx.fillStyle = c.sea;
		ctx.fill(sea);

		// The peers: seeds solid, the rest hollow, sized by how much is moving
		for (const n of known.values()) {
			const life = still ? 1 : Math.min(1, (time - n.born) / FADE) * (n.gone === null ? 1 : Math.max(0, 1 - (time - n.gone) / FADE));
			const rate = n.peer.downRate + n.peer.upRate;
			const r = (3 + Math.min(5, Math.sqrt(rate / 60_000))) * (0.4 + 0.6 * life);
			const tone = n.peer.downRate > 0 ? c.accent : n.peer.upRate > 0 ? c.sea : c.muted;
			ctx.globalAlpha = life;
			ctx.beginPath();
			ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
			if (n.peer.seed) {
				ctx.fillStyle = tone;
				ctx.fill();
			} else {
				ctx.fillStyle = c.ground;
				ctx.fill();
				ctx.lineWidth = 1.5;
				ctx.strokeStyle = tone;
				ctx.stroke();
			}
			if (hover?.peer.address === n.peer.address) {
				ctx.lineWidth = 1;
				ctx.strokeStyle = c.ink;
				ctx.beginPath();
				ctx.arc(n.x, n.y, r + 4, 0, Math.PI * 2);
				ctx.stroke();
			}
		}
		ctx.globalAlpha = 1;

		// You, breathing with the total rate
		const total = peersTotal(known);
		const pulse = still ? 0 : Math.sin(time * (1.2 + Math.min(4, Math.log10(1 + total / 100_000)))) * 1.5;
		ctx.fillStyle = c.ink;
		ctx.beginPath();
		ctx.arc(cx, cy, 9 + pulse, 0, Math.PI * 2);
		ctx.fill();
		ctx.fillStyle = withAlpha(c.ink, 0.08);
		ctx.beginPath();
		ctx.arc(cx, cy, 18 + pulse * 2, 0, Math.PI * 2);
		ctx.fill();
	});

	// Hover: the nearest peer within reach
	const onMove = (e: PointerEvent<HTMLCanvasElement>) => {
		const rect = e.currentTarget.getBoundingClientRect();
		const x = e.clientX - rect.left;
		const y = e.clientY - rect.top;
		let best: Node | null = null;
		let bestD = 14;
		for (const n of known.values()) {
			const d = Math.hypot(n.x - x, n.y - y);
			if (n.gone === null && d < bestD) {
				best = n;
				bestD = d;
			}
		}
		setHover(best ? { peer: best.peer, x: best.x, y: best.y } : null);
	};

	const sending = peers.filter((p) => p.downRate > 0).length;
	const receiving = peers.filter((p) => p.upRate > 0).length;
	return (
		<div className="swarm">
			<canvas ref={canvas} className="swarm__field" onPointerMove={onMove} onPointerLeave={() => setHover(null)} aria-label={`The swarm: ${peers.length} peers, ${sending} sending to you, ${receiving} receiving from you.`} role="img" />
			<div className="swarm__you" aria-hidden>
				<span>You</span>
				<span className="muted">{caption}</span>
			</div>
			<ul className="swarm__legend" aria-hidden>
				<li>
					<i className="swarm__key swarm__key--seed" /> Seed
				</li>
				<li>
					<i className="swarm__key" /> Peer
				</li>
				<li>
					<i className="swarm__key swarm__key--in" /> To you
				</li>
				<li>
					<i className="swarm__key swarm__key--out" /> From you
				</li>
				<li className="muted">Distance is round trip</li>
			</ul>
			{hover && (
				<div className={`swarm__tip ${hover.x > (canvas.current?.clientWidth ?? 0) * 0.6 ? "is-flipped" : ""}`} style={{ left: hover.x, top: hover.y }}>
					<strong className="selectable">{hover.peer.address}</strong>
					<span className="muted">{hover.peer.client || "Unknown client"}</span>
					<span>
						↓ {formatRate(hover.peer.downRate)} · ↑ {formatRate(hover.peer.upRate)}
					</span>
					<span className="muted">
						{hover.peer.rttMs ? `${hover.peer.rttMs} ms` : "Round trip unknown"} · {formatBytes(hover.peer.downloaded)} received · {hover.peer.seed ? "seed" : "peer"}
						{hover.peer.encrypted ? " · encrypted" : ""}
					</span>
				</div>
			)}
		</div>
	);
}

/** The swarm's total rate, for your pulse. */
function peersTotal(nodes: Map<string, Node>): number {
	let total = 0;
	for (const n of nodes.values()) if (n.gone === null) total += n.peer.downRate + n.peer.upRate;
	return total;
}
