import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { TorrentSource } from "../../shared/types";
import { useCanvasLoop } from "../lib/hooks";
import { toast } from "../components/Toasts";
import { magnetsIn } from "./AddFlow";

/** Reads a dropped file as base64. */
function readBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});
}

/** Turns a drop into sources: .torrent files and any magnet links in dropped text. */
async function sourcesFrom(data: DataTransfer): Promise<TorrentSource[]> {
	const sources: TorrentSource[] = [];
	let skipped = 0;
	for (const file of [...data.files]) {
		if (file.name.toLowerCase().endsWith(".torrent")) sources.push({ kind: "bytes", base64: await readBase64(file), fileName: file.name });
		else skipped++;
	}
	const text = data.getData("text/uri-list") || data.getData("text/plain");
	for (const uri of magnetsIn(text)) sources.push({ kind: "magnet", uri });
	if (skipped > 0 && sources.length === 0) toast("Only .torrent files and magnet links can be added.");
	return sources;
}

/** Rings that contract toward the pointer, as if the current were pulling the file in. */
function PullRings({ at }: { at: { x: number; y: number } }) {
	const canvas = useRef<HTMLCanvasElement>(null);
	const pos = useRef(at);
	pos.current = at;
	const eased = useRef(at);

	useCanvasLoop(canvas, ({ ctx, width, height, time, still }) => {
		const css = getComputedStyle(document.documentElement);
		const accent = css.getPropertyValue("--accent").trim();
		ctx.clearRect(0, 0, width, height);

		// The centre trails the pointer a little
		eased.current = { x: eased.current.x + (pos.current.x - eased.current.x) * 0.2, y: eased.current.y + (pos.current.y - eased.current.y) * 0.2 };
		const { x, y } = still ? pos.current : eased.current;
		const max = Math.hypot(width, height) * 0.6;
		ctx.strokeStyle = accent;
		for (let i = 0; i < 9; i++) {
			// Each ring travels from the edge to the centre, then starts again
			const phase = still ? i / 9 : (time * 0.35 + i / 9) % 1;
			const r = max * (1 - phase) ** 1.6 + 6;
			ctx.globalAlpha = Math.min(1, phase * 2.4) * (0.15 + 0.6 * phase);
			ctx.lineWidth = 1 + phase * 1.5;
			ctx.beginPath();
			ctx.arc(x, y, r, 0, Math.PI * 2);
			ctx.stroke();
		}
		ctx.globalAlpha = 1;
	}, 60);

	return <canvas ref={canvas} className="drop__rings" aria-hidden />;
}

interface DropOverlayProps {
	onSources: (sources: TorrentSource[]) => void;
}

/** Accepts torrents dropped anywhere on the window. */
export function DropOverlay({ onSources }: DropOverlayProps) {
	const [at, setAt] = useState<{ x: number; y: number } | null>(null);
	const depth = useRef(0);

	useEffect(() => {
		const accepts = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].some((t) => t === "Files" || t === "text/uri-list" || t === "text/plain");
		const enter = (e: DragEvent) => {
			if (!accepts(e)) return;
			e.preventDefault();
			depth.current++;
			setAt({ x: e.clientX, y: e.clientY });
		};
		const over = (e: DragEvent) => {
			if (!accepts(e)) return;
			e.preventDefault();
			if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
			setAt({ x: e.clientX, y: e.clientY });
		};
		const leave = () => {
			depth.current = Math.max(0, depth.current - 1);
			if (depth.current === 0) setAt(null);
		};
		const drop = async (e: DragEvent) => {
			e.preventDefault();
			depth.current = 0;
			setAt(null);
			if (!e.dataTransfer) return;
			const sources = await sourcesFrom(e.dataTransfer);
			if (sources.length > 0) onSources(sources);
		};
		window.addEventListener("dragenter", enter);
		window.addEventListener("dragover", over);
		window.addEventListener("dragleave", leave);
		window.addEventListener("drop", drop);
		return () => {
			window.removeEventListener("dragenter", enter);
			window.removeEventListener("dragover", over);
			window.removeEventListener("dragleave", leave);
			window.removeEventListener("drop", drop);
		};
	}, [onSources]);

	return (
		<AnimatePresence>
			{at && (
				<motion.div className="drop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
					<PullRings at={at} />
					<p className="display drop__text">Let go to add it.</p>
				</motion.div>
			)}
		</AnimatePresence>
	);
}
