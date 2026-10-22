/**
 * Shared React hooks: tweened numbers, the decorative canvas loop, and reduced-motion state.
 */

import { useEffect, useRef, useState, type RefObject } from "react";

/** Whether the user asked for reduced motion; updates live. */
export function useReducedMotion(): boolean {
	const query = "(prefers-reduced-motion: reduce)";
	const [reduced, setReduced] = useState(() => typeof matchMedia !== "undefined" && matchMedia(query).matches);
	useEffect(() => {
		const mq = matchMedia(query);
		const on = () => setReduced(mq.matches);
		mq.addEventListener("change", on);
		return () => mq.removeEventListener("change", on);
	}, []);
	return reduced;
}

/**
 * A number that eases toward `target` over `ms` instead of jumping, so live figures never
 * flicker. Jumps straight there under reduced motion.
 */
export function useTween(target: number, ms = 400): number {
	const [value, setValue] = useState(target);
	const from = useRef(target);
	const current = useRef(target);
	const reduced = useReducedMotion();

	useEffect(() => {
		if (reduced || !Number.isFinite(target)) {
			current.current = target;
			setValue(target);
			return;
		}
		from.current = current.current;
		const start = performance.now();
		let raf = 0;
		let committed = 0;
		const step = (now: number) => {
			const t = Math.min(1, (now - start) / ms);
			const eased = 1 - (1 - t) ** 3;
			current.current = from.current + (target - from.current) * eased;
			// A figure reads as smooth at ~30 updates a second, so skip alternate frames (the last always lands)
			if (t === 1 || now - committed >= 30) {
				committed = now;
				setValue(current.current);
			}
			if (t < 1) raf = requestAnimationFrame(step);
		};
		raf = requestAnimationFrame(step);
		return () => cancelAnimationFrame(raf);
	}, [target, ms, reduced]);

	return value;
}

/** What a canvas drawing gets each frame. */
export interface FrameInfo {
	ctx: CanvasRenderingContext2D;
	/** CSS pixels. */
	width: number;
	height: number;
	/** Seconds since the previous frame (0 on the first and on still frames). */
	dt: number;
	/** Seconds since the loop started. */
	time: number;
	/** True when drawing a single still frame for reduced motion. */
	still: boolean;
}

/**
 * Runs a decorative canvas animation within the design spec's budget: at most `fps` frames a
 * second, device pixel ratio capped at 2, a single still frame (redrawn on resize) under
 * reduced motion, and no frames at all while the page is hidden or the canvas is off screen.
 * Between frames it sleeps on a timer instead of polling every display refresh. `fps` may be a
 * function, read before each frame, so an animation can slow down when little is happening.
 * `draw` is read through a ref, so it may change every render without restarting the loop.
 */
export function useCanvasLoop(canvas: RefObject<HTMLCanvasElement | null>, draw: (f: FrameInfo) => void, fps: number | (() => number) = 30): void {
	const drawRef = useRef(draw);
	drawRef.current = draw;
	const fpsRef = useRef(fps);
	fpsRef.current = fps;
	const reduced = useReducedMotion();

	useEffect(() => {
		const el = canvas.current;
		if (!el) return;
		const ctx = el.getContext("2d");
		if (!ctx) return;

		let width = 0;
		let height = 0;
		let raf = 0;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let last = 0;
		let onScreen = true;
		const start = performance.now();

		// Match the backing store to the element's size
		const resize = () => {
			const rect = el.getBoundingClientRect();
			const dpr = Math.min(2, window.devicePixelRatio || 1);
			width = rect.width;
			height = rect.height;
			const bw = Math.max(1, Math.round(width * dpr));
			const bh = Math.max(1, Math.round(height * dpr));
			// Assigning width/height clears the canvas, so leave an unchanged backing store alone
			if (el.width === bw && el.height === bh) return;
			el.width = bw;
			el.height = bh;
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			if (reduced) frame(performance.now(), true);
		};

		const frame = (now: number, still = false) => {
			const dt = last && !still ? Math.min(0.1, (now - last) / 1000) : 0;
			last = now;
			drawRef.current({ ctx, width, height, dt, time: (now - start) / 1000, still });
		};

		// Whether frames should be running at all
		const paused = () => document.hidden || !onScreen;

		// Sleep until the next frame is nearly due, then let the display pick the exact moment
		const arm = () => {
			clearTimeout(timer);
			cancelAnimationFrame(raf);
			if (paused()) return;
			const rate = typeof fpsRef.current === "function" ? fpsRef.current() : fpsRef.current;
			const wait = Math.max(0, 1000 / rate - (performance.now() - last) - 8);
			timer = setTimeout(() => {
				raf = requestAnimationFrame(tick);
			}, wait);
		};
		const tick = (now: number) => {
			if (paused()) return;
			frame(now);
			arm();
		};

		// Stop while hidden or scrolled away; start again with a fresh clock
		const wake = () => {
			if (paused()) {
				clearTimeout(timer);
				cancelAnimationFrame(raf);
			} else if (!reduced) {
				last = 0;
				arm();
			}
		};

		const observer = new ResizeObserver(resize);
		observer.observe(el);
		const visibility = new IntersectionObserver((entries) => {
			onScreen = entries[entries.length - 1]?.isIntersecting ?? true;
			wake();
		});
		visibility.observe(el);
		document.addEventListener("visibilitychange", wake);
		resize();
		if (!reduced) arm();
		return () => {
			clearTimeout(timer);
			cancelAnimationFrame(raf);
			observer.disconnect();
			visibility.disconnect();
			document.removeEventListener("visibilitychange", wake);
		};
	}, [canvas, reduced]);
}

/**
 * A function with a fixed identity that always calls the latest `fn`. Lets a memoised child
 * take handlers that close over changing state without re-rendering whenever that state does.
 */
export function useStable<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
	const ref = useRef(fn);
	ref.current = fn;
	return useRef((...args: A) => ref.current(...args)).current;
}

/** The previous render's value. */
export function usePrevious<T>(value: T): T | undefined {
	const ref = useRef<T | undefined>(undefined);
	useEffect(() => {
		ref.current = value;
	});
	return ref.current;
}
