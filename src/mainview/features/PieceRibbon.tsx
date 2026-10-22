import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import type { FileInfo } from "../../shared/types";
import { formatBytes, formatPercent } from "../../shared/format";
import { useCanvasLoop } from "../lib/hooks";
import { decodeBits } from "./PieceMap";

/** Seconds a newly verified stretch glows bright before settling to the torrent's tone. */
const GLOW_S = 1.2;

/** Gap between files, in pixels: wide enough to read each file as its own block. */
const FILE_GAP = 4;

/** Width of one slice of the ribbon, in pixels. */
const SLICE = 2;

/** The narrowest a file's block gets, so small files (subtitles, posters) still show. */
const MIN_FILE = 8;

interface Span {
	file: FileInfo;
	/** The file's name without its folders. */
	name: string;
	/** Left and right edges in the ribbon, 0 to 1. */
	from: number;
	to: number;
}

/** Each file's stretch of the torrent, in torrent order, as fractions of the whole. */
function spansOf(files: FileInfo[]): Span[] {
	const total = files.reduce((sum, f) => sum + f.length, 0) || 1;
	let at = 0;
	return [...files]
		.sort((a, b) => a.index - b.index)
		.map((file) => {
			const from = at / total;
			at += file.length;
			return { file, name: file.path.split("/").pop() || file.path, from, to: at / total };
		});
}

/** A file's block in the ribbon, in pixels. */
interface Box {
	x0: number;
	x1: number;
}

/**
 * Lays the files out across `width` pixels: by length, but every file at least `MIN_FILE` wide,
 * the rest shared among the larger ones. With too many files for that, gaps narrow and then go,
 * and blocks share the width evenly.
 */
function layout(spans: Span[], width: number): Box[] {
	const n = spans.length;
	if (!n || width <= 0) return [];
	const gap = n * (MIN_FILE + FILE_GAP) <= width + FILE_GAP ? FILE_GAP : n * 3 <= width ? 1 : 0;
	const room = Math.max(0, width - gap * (n - 1));
	const least = Math.min(MIN_FILE, room / n);

	// Pin files too small for their share at the minimum until the rest all fit by length
	const lengths = spans.map((s) => s.to - s.from);
	const pinned = new Set<number>();
	let widths: number[] = [];
	for (;;) {
		const free = room - pinned.size * least;
		const total = lengths.reduce((sum, l, i) => (pinned.has(i) ? sum : sum + l), 0);
		widths = lengths.map((l, i) => (pinned.has(i) ? least : total > 0 ? (free * l) / total : free / (n - pinned.size)));
		const short = widths.findIndex((w, i) => !pinned.has(i) && w < least);
		if (short < 0) break;
		pinned.add(short);
	}

	// Edges on whole pixels
	let at = 0;
	return widths.map((w, i) => {
		const x0 = Math.round(at);
		at += w;
		const x1 = Math.round(at);
		at += i < n - 1 ? gap : 0;
		return { x0, x1 };
	});
}

interface PieceRibbonProps {
	bits: string | null | undefined;
	count: number;
	files: FileInfo[];
	/** Clicking a file's stretch goes to it. */
	onOpenFiles: () => void;
}

/**
 * A map of the torrent: one block per file, in order and sized by length (small files kept
 * wide enough to see), filled in the
 * torrent's tone where it's downloaded and left empty where it isn't. A slice that's partly
 * there is filled faintly. Stretches that arrive while you watch flash bright, then settle.
 * Pointing at a block names the file and its progress; files left out are hatched.
 */
export function PieceRibbon({ bits, count, files, onOpenFiles }: PieceRibbonProps) {
	const canvas = useRef<HTMLCanvasElement>(null);
	const spans = useMemo(() => spansOf(files), [files]);
	const have = useRef<Uint8Array>(new Uint8Array(0));
	/** When each piece was first seen verified (canvas clock); 0 for "before we looked". */
	const bornAt = useRef<Float32Array>(new Float32Array(0));
	const clock = useRef(0);
	const [hover, setHover] = useState<number | null>(null);
	const hoverRef = useRef<number | null>(null);
	/** The last drawn layout and its width, for pointing and the marker. */
	const boxes = useRef<{ width: number; list: Box[] }>({ width: 0, list: [] });
	hoverRef.current = hover;

	// Fold new data in, timestamping pieces that just arrived
	useEffect(() => {
		const next = decodeBits(bits, count);
		const prev = have.current;
		const born = bornAt.current.length === count ? bornAt.current : new Float32Array(count);
		const fresh = prev.length === count;
		for (let i = 0; i < count; i++) if (next[i] && !prev[i]) born[i] = fresh ? clock.current : 0;
		have.current = next;
		bornAt.current = born;
	}, [bits, count]);

	useCanvasLoop(canvas, ({ ctx, width, height, time, still }) => {
		clock.current = time;
		const css = getComputedStyle(document.documentElement);
		const track = css.getPropertyValue("--surface-3").trim();
		const well = css.getPropertyValue("--surface-2").trim();
		const flash = css.getPropertyValue("--ink").trim();
		const tone = getComputedStyle(ctx.canvas).getPropertyValue("--tone").trim() || flash;
		ctx.clearRect(0, 0, width, height);
		if (count === 0 || width === 0) return;

		const list = boxes.current.width === width && boxes.current.list.length === spans.length ? boxes.current.list : layout(spans, width);
		boxes.current = { width, list };
		const lit = hoverRef.current;
		for (const [i, s] of spans.entries()) {
			const { x0, x1 } = list[i]!;
			if (x1 - x0 < 1) continue;
			const focus = lit === null || lit === i;
			ctx.globalAlpha = focus ? 1 : 0.45;

			// A file left out is hatched, whatever it shares with its neighbours' pieces
			if (!s.file.selected) {
				ctx.fillStyle = well;
				ctx.fillRect(x0, 0, x1 - x0, height);
				ctx.save();
				ctx.beginPath();
				ctx.rect(x0, 0, x1 - x0, height);
				ctx.clip();
				ctx.strokeStyle = track;
				ctx.lineWidth = 1.5;
				for (let x = x0 - height; x < x1; x += 6) {
					ctx.moveTo(x, height);
					ctx.lineTo(x + height, 0);
				}
				ctx.stroke();
				ctx.restore();
				continue;
			}
			ctx.fillStyle = track;
			ctx.fillRect(x0, 0, x1 - x0, height);

			// The file's own pieces, spread across its block; slices run edge to edge, so a
			// finished file reads as one solid block
			const f0 = s.from * count;
			const f1 = s.to * count;
			const cols = Math.max(1, Math.round((x1 - x0) / SLICE));
			for (let c = 0; c < cols; c++) {
				const p0 = Math.min(count - 1, Math.floor(f0 + ((f1 - f0) * c) / cols));
				const p1 = Math.min(count, Math.max(p0 + 1, Math.ceil(f0 + ((f1 - f0) * (c + 1)) / cols)));
				let n = 0;
				let newest = 0;
				for (let p = p0; p < p1; p++) {
					if (have.current[p]) {
						n++;
						newest = Math.max(newest, bornAt.current[p] ?? 0);
					}
				}
				if (!n) continue;
				const age = still || newest === 0 ? 1 : Math.min(1, (time - newest) / GLOW_S);
				// Whole pixels, so neighbouring slices meet without seams
				const cx = x0 + Math.round(((x1 - x0) * c) / cols);
				const cw = x0 + Math.round(((x1 - x0) * (c + 1)) / cols) - cx;
				const share = n / (p1 - p0);
				ctx.fillStyle = age < 1 ? flash : tone;
				ctx.globalAlpha = (focus ? 1 : 0.4) * (share < 1 ? 0.25 + 0.5 * share : 1) * (0.85 + 0.15 * (1 - age));
				if (cw > 0) ctx.fillRect(cx, 0, cw, height);
			}
		}
		ctx.globalAlpha = 1;
	}, 30);

	const onMove = (e: PointerEvent<HTMLCanvasElement>) => {
		// The block under the pointer, or the nearer one across a gap
		const r = e.currentTarget.getBoundingClientRect();
		const { width, list } = boxes.current;
		const x = ((e.clientX - r.left) / r.width) * width;
		const i = list.findIndex((b, j) => x < (list[j + 1] ? (b.x1 + list[j + 1]!.x0) / 2 : Infinity));
		setHover(i >= 0 ? i : null);
	};

	const h = hover !== null ? spans[hover] : undefined;
	const hb = hover !== null && boxes.current.width ? boxes.current.list[hover] : undefined;
	const verified = useMemo(() => decodeBits(bits, count).reduce((n, b) => n + b, 0), [bits, count]);

	// The legend names only what the map shows
	const missing = spans.some((s) => s.file.selected && s.file.downloaded < s.file.length);
	const skipped = spans.some((s) => !s.file.selected);
	const legend = [
		...(verified > 0 ? [{ key: "have", label: "Downloaded" }] : []),
		...(missing ? [{ key: "missing", label: "Not yet" }] : []),
		...(skipped ? [{ key: "skipped", label: "Left out" }] : []),
	];
	return (
		<div className="ribbon">
			<div className="ribbon__well">
				<canvas
					ref={canvas}
					className="ribbon__canvas"
					role="img"
					aria-label={`${spans.length === 1 ? "One file" : `${spans.length} files`}; ${verified} of ${count} pieces downloaded. Click to see the files.`}
					onPointerMove={onMove}
					onPointerLeave={() => setHover(null)}
					onClick={onOpenFiles}
				/>
				{hb && <span className="ribbon__marker" style={{ left: `${(hb.x0 / boxes.current.width) * 100}%`, width: `${((hb.x1 - hb.x0) / boxes.current.width) * 100}%` }} aria-hidden="true" />}
			</div>
			<p className="ribbon__readout" aria-live="off">
				{h ? (
					<>
						<span className="ribbon__file ellipsis">{h.name}</span>
						<span className="ribbon__meta">
							{h.file.selected ? `${formatPercent(h.file.length ? h.file.downloaded / h.file.length : 1)} of ${formatBytes(h.file.length)}` : `Left out · ${formatBytes(h.file.length)}`}
							{spans.length > 1 && ` · file ${hover! + 1} of ${spans.length}`}
						</span>
					</>
				) : (
					<>
						<span className="ribbon__file">
							{spans.length > 1 ? `${spans.length} files` : "One file"}
							<span className="muted"> · point at one for details</span>
						</span>
						<span className="ribbon__legend">
							{legend.map((l) => (
								<span key={l.key} className="ribbon__key">
									<span className={`ribbon__swatch ribbon__swatch--${l.key}`} aria-hidden="true" />
									{l.label}
								</span>
							))}
						</span>
					</>
				)}
			</p>
		</div>
	);
}
