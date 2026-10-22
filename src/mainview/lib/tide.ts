/**
 * The tide: a panel opening behind a water line that rises over it (or pours down it), with a
 * swell over the place it came from, and drains away when it closes. Shared by the traffic panel,
 * the dialogs and the command palette.
 */

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { animate, useMotionValue, usePresence, useTransform, type MotionValue } from "motion/react";
import { EASE_IN_OUT, EASE_OUT, EASE_SOFT } from "./constants";

/** Points along the water line; one every this many pixels. */
const STEP = 16;

/**
 * The clip while the tide is `level` of the way in (0 clear of the panel, 1 over it): a water line
 * with a swell at `origin` and a ripple that both die away as it lands, so the opened panel is an
 * exact rectangle. The far corners are pinned to the panel's edge in percent, so anything that
 * grows after it was measured is still covered.
 */
function tideClip(level: number, w: number, h: number, origin: number, from: TideFrom): string {
	const surge = Math.sin(Math.PI * Math.min(1, level));
	const crest = Math.min(72, h * 0.3) * surge;
	const ripple = 5 * surge;
	const spread = Math.max(120, w * 0.24);
	const reach = h * level;
	const edge = from === "bottom" ? "100%" : "0%";
	const points = [`0% ${edge}`];
	for (let x = 0; x <= w + STEP - 1; x += STEP) {
		const px = Math.min(x, w);
		const swell = crest * Math.exp(-(((px - origin) / spread) ** 2));
		const d = Math.max(0, Math.min(h, reach + swell + ripple * Math.sin(px / 38 + level * 9)));
		points.push(`${px.toFixed(1)}px ${(from === "bottom" ? h - d : d).toFixed(1)}px`);
	}
	points.push(`100% ${edge}`);
	return `polygon(${points.join(", ")})`;
}

export type TideFrom = "bottom" | "top";

interface TideOptions {
	/** The edge the water comes from. */
	from?: TideFrom;
	/** Where the swell crests, in pixels from the panel's left; its middle when not given. */
	origin?: (panel: DOMRect) => number | null;
	reduced: boolean;
	/** Seconds to rise; it drains in a little over half that. */
	duration?: number;
}

/** The last part of the rise over which the panel's shadow surfaces (and the first part of the drain, as it goes). */
const SHADE_FROM = 0.8;

export interface Tide {
	/** The clip-path for the panel's surface. */
	clip: MotionValue<string>;
	/**
	 * Opacity for the panel's shadow, a layer of its own behind the surface (`.float-shade`). The
	 * shadow is never drawn from the clip: a filter recomputed from a moving water line every frame
	 * flickers in WebKit and leaves a smear as the water drains. It surfaces once the panel lands.
	 */
	shade: MotionValue<number>;
}

/**
 * The clip-path and shadow for a panel opened by the tide. Call it from a component mounted inside
 * AnimatePresence: it holds the panel's exit until the water has drained. The panel is measured
 * after its contents lay out, and again whenever it resizes, so the water always covers all of it.
 */
export function useTide(panel: RefObject<HTMLElement | null>, { from = "bottom", origin, reduced, duration = 0.62 }: TideOptions): Tide {
	const [present, safeToRemove] = usePresence();
	const [ready, setReady] = useState(false);
	const box = useRef<{ w: number; h: number; origin: number } | null>(null);
	const at = useRef(origin);
	at.current = origin;

	// The tide: 0 is clear of the panel, 1 is over it. Until measured, the panel stays under water.
	const level = useMotionValue(reduced ? 1 : 0);
	const hidden = from === "bottom" ? "inset(100% 0px 0px 0px)" : "inset(0px 0px 100% 0px)";
	const clip = useTransform(level, (l) => {
		const b = box.current;
		if (reduced || l >= 1) return "none";
		if (!b) return hidden;
		return tideClip(l, b.w, b.h, b.origin, from);
	});
	const shade = useTransform(level, (l) => Math.max(0, Math.min(1, (l - SHADE_FROM) / (1 - SHADE_FROM))));

	useLayoutEffect(() => {
		const el = panel.current;
		if (!el) return;
		const measure = () => {
			const r = el.getBoundingClientRect();
			const o = at.current?.(r);
			box.current = { w: Math.round(r.width), h: Math.round(r.height), origin: Math.max(0, Math.min(r.width, o ?? r.width / 2)) };
		};
		measure();
		setReady(true);
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, [panel]);

	// In once measured; out (draining faster than it rose) before unmounting
	useEffect(() => {
		if (!ready) return;
		if (!present) {
			if (reduced) return safeToRemove();
			const out = animate(level, 0, { duration: duration * 0.55, ease: EASE_IN_OUT });
			out.then(() => safeToRemove());
			return () => out.stop();
		}
		if (reduced) return;
		const rise = animate(level, 1, { duration, ease: EASE_SOFT });
		return () => rise.stop();
	}, [ready, present, reduced, level, safeToRemove, duration]);

	return { clip, shade };
}

/**
 * One band of a tide-opened panel, surfacing as the water passes it. `depth` counts from the edge
 * the water comes from, so the nearest band surfaces first.
 */
export function tideBand(depth: number, reduced: boolean, from: TideFrom = "bottom") {
	if (reduced) return {};
	return {
		initial: { opacity: 0, y: from === "bottom" ? 14 : -14 },
		animate: { opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE_OUT, delay: 0.1 + depth * 0.06 } },
		exit: { opacity: 0, y: 6, transition: { duration: 0.14, ease: EASE_IN_OUT } },
	};
}
