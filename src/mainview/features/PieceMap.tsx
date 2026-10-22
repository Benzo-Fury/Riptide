import { useEffect, useRef } from "react";
import { useCanvasLoop } from "../lib/hooks";

interface PieceMapProps {
	/** Verified pieces as a base64 bitfield in wire order. */
	bits: string | null | undefined;
	count: number;
}

/** Decodes a base64 wire-order bitfield into one boolean per piece. */
export function decodeBits(b64: string | null | undefined, count: number): Uint8Array {
	const out = new Uint8Array(count);
	if (!b64) return out;
	const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
	for (let i = 0; i < count; i++) out[i] = (bytes[i >> 3]! >> (7 - (i & 7))) & 1;
	return out;
}

/** Seconds a newly verified piece takes to bloom to full size. */
const BLOOM_S = 0.6;

/**
 * Every piece as a cell, filled once verified. Pieces verified while you watch bloom in from
 * small to full size. Big torrents group several pieces per cell; a cell fills in proportion
 * to how many of its pieces are verified.
 */
export function PieceMap({ bits, count }: PieceMapProps) {
	const canvas = useRef<HTMLCanvasElement>(null);
	const have = useRef<Uint8Array>(new Uint8Array(0));
	/** When each piece was first seen verified (seconds, canvas clock); 0 for "before we looked". */
	const bornAt = useRef<Float32Array>(new Float32Array(0));
	const clock = useRef(0);
	/** Bumped whenever the piece data changes, so an idle map knows to redraw. */
	const version = useRef(0);
	/** Until when (canvas clock) a bloom is still playing. */
	const animatingUntil = useRef(0);
	/** What the canvas last showed; a frame identical to it is skipped. */
	const drawn = useRef("");

	// Fold new data in, timestamping pieces that just arrived
	useEffect(() => {
		const next = decodeBits(bits, count);
		const prev = have.current;
		const born = bornAt.current.length === count ? bornAt.current : new Float32Array(count);
		const fresh = prev.length === count;
		for (let i = 0; i < count; i++) if (next[i] && !prev[i]) born[i] = fresh ? clock.current : 0;
		have.current = next;
		bornAt.current = born;
		version.current++;
		animatingUntil.current = clock.current + BLOOM_S + 0.1;
	}, [bits, count]);

	useCanvasLoop(canvas, ({ ctx, width, height, time, still }) => {
		clock.current = time;
		const css = getComputedStyle(document.documentElement);
		const empty = css.getPropertyValue("--surface-2").trim();
		const fill = css.getPropertyValue("--ink").trim();

		// Nothing to redraw while the data, size and colours are as last drawn and no bloom is playing
		const key = `${ctx.canvas.width}x${ctx.canvas.height}|${count}|${version.current}|${empty}|${fill}`;
		if (key === drawn.current && time > animatingUntil.current) return;
		drawn.current = key;
		ctx.clearRect(0, 0, width, height);
		if (count === 0) return;

		// Lay cells out to fill the box: square-ish, at least 4px
		const gap = 2;
		const perCell = Math.max(1, Math.ceil(count / Math.floor((width * height) / 36)));
		const cells = Math.ceil(count / perCell);
		const size = Math.max(4, Math.floor(Math.sqrt((width * height) / cells)) - gap);
		const cols = Math.max(1, Math.floor((width + gap) / (size + gap)));

		for (let c = 0; c < cells; c++) {
			const x = (c % cols) * (size + gap);
			const y = Math.floor(c / cols) * (size + gap);
			if (y > height) break;

			// Background cell
			ctx.fillStyle = empty;
			ctx.fillRect(x, y, size, size);

			// Its share of verified pieces, and how recently the newest arrived
			let n = 0;
			let newest = 0;
			for (let p = c * perCell; p < Math.min(count, (c + 1) * perCell); p++) {
				if (have.current[p]) {
					n++;
					newest = Math.max(newest, bornAt.current[p] ?? 0);
				}
			}
			if (n === 0) continue;
			const age = still || newest === 0 ? 1 : Math.min(1, (time - newest) / BLOOM_S);
			const grow = 0.6 + 0.4 * (1 - (1 - age) ** 3);
			const s = size * grow;
			ctx.globalAlpha = (n / perCell) * (0.35 + 0.65 * age);
			ctx.fillStyle = fill;
			ctx.fillRect(x + (size - s) / 2, y + (size - s) / 2, s, s);
			ctx.globalAlpha = 1;
		}
	}, 30);

	return <canvas ref={canvas} className="piece-map" role="img" aria-label={`${count} pieces`} />;
}
