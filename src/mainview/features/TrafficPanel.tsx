import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode, type RefObject } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import type { EncryptionMode, TorrentSummary } from "../../shared/types";
import { formatBytes, formatDuration, formatRate, formatRatio } from "../../shared/format";
import { EASE_OUT, SHUTTER } from "../lib/constants";
import { tideBand as band, useTide } from "../lib/tide";
import { useReducedMotion } from "../lib/hooks";
import { useEngine, useHistory, useLock, useSettings, useTorrents, type RateSample } from "../lib/store";
import { AnimatedNumber, Sparkline } from "../components/Figures";
import { IconButton } from "../components/Button";
import { Tabs } from "../components/Tabs";

type RangeId = "1m" | "5m" | "15m";

const RANGES: { id: RangeId; label: string; seconds: number }[] = [
	{ id: "1m", label: "1 min", seconds: 60 },
	{ id: "5m", label: "5 min", seconds: 300 },
	{ id: "15m", label: "15 min", seconds: 900 },
];

/** Short names for the encryption modes, matching Settings. */
const ENCRYPTION: Record<EncryptionMode, string> = { prefer: "Preferred", plaintext: "Plaintext first", require: "Required", off: "Off" };

/** Torrents listed under "Moving data"; the rest are counted. */
const TOP_TORRENTS = 6;

interface TrafficPanelProps {
	open: boolean;
	/** The sparkline the panel grows out of, and gives focus back to. */
	origin: RefObject<HTMLElement | null>;
	onClose: () => void;
	onShowTorrent: (hash: string) => void;
}

/**
 * The status bar's sparkline, opened up: live rates, a chart of the last few minutes with a
 * crosshair, where the bytes are going and the state of the network. It rises out of the status
 * bar like a tide, its swell centred on the sparkline, and closes on Escape or a click outside.
 */
export function TrafficPanel({ open, origin, onClose, onShowTorrent }: TrafficPanelProps) {
	const close = useRef(onClose);
	close.current = onClose;

	// Escape closes; focus goes back to the sparkline
	useEffect(() => {
		if (!open) return;
		const back = origin.current;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				close.current();
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => {
			window.removeEventListener("keydown", onKey, true);
			back?.focus();
		};
	}, [open, origin]);

	return (
		<AnimatePresence>
			{open && (
				<div className="traffic-layer" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
					<Panel origin={origin} onClose={onClose} onShowTorrent={onShowTorrent} />
				</div>
			)}
		</AnimatePresence>
	);
}

/** The floating panel; mounted only while open so its opening is measured fresh each time. */
function Panel({ origin, onClose, onShowTorrent }: Omit<TrafficPanelProps, "open">) {
	const engine = useEngine();
	const history = useHistory();
	const torrents = useTorrents();
	const lock = useLock();
	const settings = useSettings();
	const reduced = useReducedMotion();
	const [range, setRange] = useState<RangeId>("1m");
	const panel = useRef<HTMLDivElement>(null);
	// Figures count up from zero once the water reaches them
	const [risen, setRisen] = useState(reduced);
	const { clip, shade } = useTide(panel, {
		reduced,
		origin: (p) => {
			const o = origin.current?.getBoundingClientRect();
			return o ? o.left + o.width / 2 - p.left : p.width - 120;
		},
	});
	useEffect(() => {
		const timer = setTimeout(() => setRisen(true), 260);
		return () => clearTimeout(timer);
	}, []);

	// The samples in range, and the figures drawn from them
	const seconds = RANGES.find((r) => r.id === range)!.seconds;
	const samples = useMemo(() => {
		const last = history.at(-1)?.at ?? 0;
		return history.filter((s) => s.at >= last - seconds * 1000);
	}, [history, seconds]);
	const stats = useMemo(() => {
		let peakDown = 0;
		let peakUp = 0;
		let sumDown = 0;
		let sumUp = 0;
		for (const s of samples) {
			peakDown = Math.max(peakDown, s.down);
			peakUp = Math.max(peakUp, s.up);
			sumDown += s.down;
			sumUp += s.up;
		}
		const n = Math.max(1, samples.length);
		return { peakDown, peakUp, avgDown: sumDown / n, avgUp: sumUp / n };
	}, [samples]);

	const down = engine?.sessionDownloaded ?? 0;
	const up = engine?.sessionUploaded ?? 0;
	const ratio = down > 0 ? formatRatio(up / down) : up > 0 ? "∞" : "–";
	const span = samples.length > 1 ? (samples.at(-1)!.at - samples[0]!.at) / 1000 : 0;
	const live = (n: number) => (risen ? n : 0);

	return (
		<div ref={panel} role="dialog" aria-modal="true" aria-label="Traffic" className="traffic">
			<motion.div className="float-shade" aria-hidden="true" {...(reduced ? SHUTTER.still : { style: { opacity: shade } })} />
			<motion.div className="traffic__clip" style={{ clipPath: clip }} {...(reduced ? SHUTTER.still : {})}>
					<div className="traffic__inner">
						<motion.header className="traffic__head" {...band(4, reduced)}>
							<h2 className="traffic__title">Traffic</h2>
							<Tabs tabs={RANGES} value={range} onChange={setRange} layoutId="traffic-range" />
							<IconButton label="Close" onClick={onClose}>
								<X size={16} strokeWidth={1.5} />
							</IconButton>
						</motion.header>

						<motion.div className="traffic__figures" {...band(3, reduced)}>
							<Figure icon={<ArrowDown size={14} strokeWidth={2} className="status__in" />} label="Download" value={live(engine?.downRate ?? 0)} note={`Peak ${formatRate(stats.peakDown)}`} title={`Average ${formatRate(stats.avgDown)} over the range`} />
							<Figure icon={<ArrowUp size={14} strokeWidth={2} className="status__out" />} label="Upload" value={live(engine?.upRate ?? 0)} note={`Peak ${formatRate(stats.peakUp)}`} title={`Average ${formatRate(stats.avgUp)} over the range`} />
							<div className="traffic-figure">
								<span className="traffic-figure__label">This session</span>
								<span className="traffic-figure__value">
									<span className="traffic-figure__num">{ratio}</span>
									<span className="traffic-figure__unit">ratio</span>
								</span>
								<span className="traffic-figure__note">
									{formatBytes(down)} in · {formatBytes(up)} out
								</span>
							</div>
							<div className="traffic-figure">
								<span className="traffic-figure__label">Peers</span>
								<span className="traffic-figure__value">
									<AnimatedNumber className="traffic-figure__num" value={live(engine?.peers ?? 0)} format={(n) => String(Math.round(n))} />
									<Sparkline width={72} height={18} length={Math.max(2, samples.length)} label="Connected peers over the range" series={[{ values: samples.map((s) => s.peers), color: "var(--muted)" }]} />
								</span>
								<span className="traffic-figure__note">{engine?.halfOpen ? `${engine.halfOpen} connecting` : "None connecting"}</span>
							</div>
						</motion.div>

						<motion.div className="traffic__chart-band" {...band(2, reduced)}>
							<TrafficChart samples={samples} seconds={seconds} reduced={reduced} />
							<p className="traffic__since">{span < seconds - 5 ? `Recorded since Riptide opened, ${formatDuration(span)} ago. The chart fills in as it runs.` : " "}</p>
						</motion.div>

						<div className="traffic__lower">
							<motion.section className="traffic__section" {...band(1, reduced)}>
								<h3 className="traffic__subhead">Moving data</h3>
								<Movers torrents={torrents} onShow={onShowTorrent} />
							</motion.section>
							<motion.section className="traffic__section" {...band(0, reduced)}>
								<h3 className="traffic__subhead">Network</h3>
								<dl className="traffic__net">
									<NetRow label="Port" value={engine ? String(engine.announcePort || engine.port) : "–"} />
									<NetRow label="Router mapping" value={settings ? (settings.portMapping ? "On" : "Off") : "–"} off={settings?.portMapping === false} />
									<NetRow label="DHT" value={settings?.dht === false ? "Off" : engine?.dhtNodes ? `${engine.dhtNodes} nodes` : "Starting"} off={settings?.dht === false} />
									<NetRow label="Peer exchange" value={settings ? (settings.pex ? "On" : "Off") : "–"} off={settings?.pex === false} />
									<NetRow label="Encryption" value={settings ? ENCRYPTION[settings.encryption] : "–"} off={settings?.encryption === "off"} />
									<NetRow
										label="Interface"
										value={lock ? (lock.address ? lock.interface : `${lock.interface} down`) : "Any"}
										data-tip={lock?.address ? `Every connection goes through ${lock.interface} (${lock.address}).` : undefined}
										danger={!!lock && !lock.address}
									/>
								</dl>
							</motion.section>
						</div>
					</div>
			</motion.div>
		</div>
	);
}

interface FigureProps {
	icon: ReactNode;
	label: string;
	value: number;
	note: string;
	title?: string;
}

/** A live rate set large, with its unit smaller beside it. */
function Figure({ icon, label, value, note, title }: FigureProps) {
	return (
		<div className="traffic-figure" data-tip={title}>
			<span className="traffic-figure__label">
				{icon}
				{label}
			</span>
			<AnimatedNumber className="traffic-figure__value" value={value} format={formatRate} />
			<span className="traffic-figure__note">{note}</span>
		</div>
	);
}

interface NetRowProps {
	label: string;
	value: string;
	title?: string;
	/** A feature switched off: the value steps back. */
	off?: boolean;
	danger?: boolean;
}

/** One line of the network list: the name on the left, its state on the right. */
function NetRow({ label, value, title, off, danger }: NetRowProps) {
	return (
		<div className="net-row" data-tip={title}>
			<dt className="net-row__label">{label}</dt>
			<dd className={`net-row__value ${off ? "is-off" : ""} ${danger ? "is-danger" : ""}`}>{value}</dd>
		</div>
	);
}

// ---------- Chart ---------- //

const PAD = { top: 10, right: 12, bottom: 22, left: 64 };
const CHART_H = 180;

/** A round axis maximum at or above `max`, with its tick step (1, 2 or 5 × a power of ten). */
function niceScale(max: number): { top: number; step: number } {
	const raw = Math.max(max, 1000) / 3;
	const mag = 10 ** Math.floor(Math.log10(raw));
	const step = ([1, 2, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag;
	return { top: Math.ceil(max / step) * step || step * 3, step };
}

/** Averages samples into at most `buckets` points, so a long range draws as cleanly as a short one. */
function downsample(samples: RateSample[], buckets: number): RateSample[] {
	if (samples.length <= buckets) return samples;
	const size = samples.length / buckets;
	const out: RateSample[] = [];
	for (let b = 0; b < buckets; b++) {
		const group = samples.slice(Math.floor(b * size), Math.floor((b + 1) * size));
		if (!group.length) continue;
		const avg = (k: "down" | "up" | "peers") => group.reduce((sum, s) => sum + s[k], 0) / group.length;
		out.push({ at: group.at(-1)!.at, down: avg("down"), up: avg("up"), peers: avg("peers") });
	}
	return out;
}

/** Width of an element, following resizes. */
function useWidth(ref: RefObject<HTMLElement | null>): number {
	const [width, setWidth] = useState(0);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		setWidth(el.clientWidth);
		const ro = new ResizeObserver(() => setWidth(el.clientWidth));
		ro.observe(el);
		return () => ro.disconnect();
	}, [ref]);
	return width;
}

interface TrafficChartProps {
	samples: RateSample[];
	seconds: number;
	reduced: boolean;
}

/**
 * Download as a filled area and upload as a line on one rate axis, newest at the right. A
 * crosshair follows the pointer and reads out both rates and the peers at that moment.
 */
function TrafficChart({ samples, seconds, reduced }: TrafficChartProps) {
	const box = useRef<HTMLDivElement>(null);
	const width = useWidth(box);
	const [hover, setHover] = useState<number | null>(null);

	const plotW = Math.max(0, width - PAD.left - PAD.right);
	const plotH = CHART_H - PAD.top - PAD.bottom;
	const now = samples.at(-1)?.at ?? Date.now();
	const start = now - seconds * 1000;

	const geo = useMemo(() => {
		const points = downsample(samples, Math.max(2, Math.floor(plotW / 2)));
		const { top, step } = niceScale(Math.max(0, ...points.map((s) => Math.max(s.down, s.up))));
		const x = (at: number) => PAD.left + ((at - start) / (seconds * 1000)) * plotW;
		const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
		const line = (k: "down" | "up") => points.map((s, i) => `${i ? "L" : "M"}${x(s.at).toFixed(1)},${y(s[k]).toFixed(1)}`).join("");
		const down = line("down");
		const area = points.length ? `${down}L${x(points.at(-1)!.at).toFixed(1)},${y(0)}L${x(points[0]!.at).toFixed(1)},${y(0)}Z` : "";
		const ticks: number[] = [];
		for (let v = 0; v <= top + 1e-6; v += step) ticks.push(v);
		return { points, x, y, down, up: line("up"), area, ticks };
	}, [samples, plotW, plotH, start, seconds]);

	// The crosshair snaps to the nearest drawn point
	const onMove = (e: PointerEvent<SVGRectElement>) => {
		const px = e.clientX - e.currentTarget.getBoundingClientRect().left + PAD.left;
		let best = -1;
		let dist = Infinity;
		geo.points.forEach((s, i) => {
			const d = Math.abs(geo.x(s.at) - px);
			if (d < dist) {
				dist = d;
				best = i;
			}
		});
		setHover(best >= 0 ? best : null);
	};

	const h = hover !== null ? geo.points[hover] : undefined;
	const last = geo.points.at(-1);
	const ago = h ? Math.round((now - h.at) / 1000) : 0;
	const tipLeft = h ? geo.x(h.at) : 0;
	return (
		<div className="traffic-chart" ref={box}>
			<div className="traffic-chart__legend" aria-hidden="true">
				<span>
					<i className="traffic-chart__key is-area" />
					Download
				</span>
				<span>
					<i className="traffic-chart__key is-line" />
					Upload
				</span>
			</div>
			{width > 0 && (
				<svg width={width} height={CHART_H} viewBox={`0 0 ${width} ${CHART_H}`} role="img" aria-label={`Download and upload rates over the last ${seconds / 60} minutes`}>
					{/* Axis: recessive grid and rate labels */}
					{geo.ticks.map((v) => (
						<g key={v}>
							<line x1={PAD.left} x2={PAD.left + plotW} y1={geo.y(v)} y2={geo.y(v)} className={v === 0 ? "traffic-chart__base" : "traffic-chart__grid"} />
							<text x={PAD.left - 10} y={geo.y(v)} className="traffic-chart__tick" textAnchor="end" dominantBaseline="middle">
								{formatRate(v)}
							</text>
						</g>
					))}
					<text x={PAD.left} y={CHART_H - 4} className="traffic-chart__tick">
						{seconds / 60} min ago
					</text>
					<text x={PAD.left + plotW} y={CHART_H - 4} className="traffic-chart__tick" textAnchor="end">
						Now
					</text>

					{/* Series, filling up from the baseline as the tide comes in */}
					<motion.g style={{ originY: 1 }} initial={reduced ? false : { scaleY: 0, opacity: 0 }} animate={{ scaleY: 1, opacity: 1 }} transition={{ duration: 0.9, ease: EASE_OUT, delay: 0.32 }}>
						<path d={geo.area} className="traffic-chart__area" />
						<path d={geo.down} className="traffic-chart__line is-down" />
						<path d={geo.up} className="traffic-chart__line is-up" />
						{last && !h && (
							<>
								<circle cx={geo.x(last.at)} cy={geo.y(last.down)} r={4} className="traffic-chart__dot is-down" />
								<circle cx={geo.x(last.at)} cy={geo.y(last.up)} r={4} className="traffic-chart__dot is-up" />
							</>
						)}
					</motion.g>

					{/* Crosshair */}
					{h && (
						<g pointerEvents="none">
							<line x1={geo.x(h.at)} x2={geo.x(h.at)} y1={PAD.top} y2={PAD.top + plotH} className="traffic-chart__cross" />
							<circle cx={geo.x(h.at)} cy={geo.y(h.down)} r={4} className="traffic-chart__dot is-down" />
							<circle cx={geo.x(h.at)} cy={geo.y(h.up)} r={4} className="traffic-chart__dot is-up" />
						</g>
					)}
					<rect x={PAD.left} y={PAD.top} width={plotW} height={plotH} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
				</svg>
			)}
			{h && (
				<div className={`traffic-chart__tip ${tipLeft > width - 180 ? "is-left" : ""}`} style={{ left: tipLeft, top: PAD.top + 28 }}>
					<span className="traffic-chart__when">{ago <= 1 ? "Now" : `${formatDuration(ago)} ago`}</span>
					<span className="traffic-chart__row">
						<i className="traffic-chart__key is-line is-down" />
						<strong>{formatRate(h.down)}</strong>
						<span>down</span>
					</span>
					<span className="traffic-chart__row">
						<i className="traffic-chart__key is-line" />
						<strong>{formatRate(h.up)}</strong>
						<span>up</span>
					</span>
					<span className="traffic-chart__row">
						<strong>{Math.round(h.peers)}</strong>
						<span>peers</span>
					</span>
				</div>
			)}
		</div>
	);
}

// ---------- Torrents ---------- //

/** The torrents moving the most data, each with its share of the traffic split into down and up. */
function Movers({ torrents, onShow }: { torrents: TorrentSummary[]; onShow: (hash: string) => void }) {
	const moving = useMemo(() => torrents.filter((t) => t.downRate + t.upRate > 0).sort((a, b) => b.downRate + b.upRate - (a.downRate + a.upRate)), [torrents]);
	if (!moving.length) return <p className="traffic__empty">Nothing is moving right now.</p>;

	const total = moving.reduce((sum, t) => sum + t.downRate + t.upRate, 0);
	const max = moving[0]!.downRate + moving[0]!.upRate;
	const rest = moving.length - TOP_TORRENTS;
	return (
		<ol className="movers">
			{moving.slice(0, TOP_TORRENTS).map((t) => (
				<motion.li key={t.hash} layout="position" transition={{ duration: 0.3, ease: EASE_OUT }}>
					<button className="mover" onClick={() => onShow(t.hash)} data-tip={`Show ${t.name}`}>
						<span className="mover__name ellipsis">{t.name}</span>
						<span className="mover__share">{Math.round(((t.downRate + t.upRate) / total) * 100)}%</span>
						<span className="mover__bar" aria-hidden="true">
							{t.downRate > 0 && <span className="mover__seg is-down" style={{ flexBasis: `${(t.downRate / max) * 100}%` }} />}
							{t.upRate > 0 && <span className="mover__seg is-up" style={{ flexBasis: `${(t.upRate / max) * 100}%` }} />}
						</span>
						<span className="mover__rates">
							{t.downRate > 0 && <span>↓ {formatRate(t.downRate)}</span>}
							{t.upRate > 0 && <span>↑ {formatRate(t.upRate)}</span>}
						</span>
					</button>
				</motion.li>
			))}
			{rest > 0 && <li className="traffic__empty">and {rest} more</li>}
		</ol>
	);
}
