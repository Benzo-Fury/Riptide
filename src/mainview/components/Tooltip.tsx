import { useEffect, useRef, useState } from "react";

/** How long the pointer rests on a control before its tip appears, so a pointer passing over stays quiet. */
const SHOW_DELAY_MS = 600;
/** After a tip that was showing closes, moving to another one within this window skips the wait. */
const WARM_MS = 400;
/** Gap between the control and its tip, and the nearest a tip sits to the window edge. */
const GAP = 8;
const EDGE = 8;

interface Tip {
	text: string;
	x: number;
	y: number;
	/** True when there was no room beneath and the tip sits above its control. */
	above: boolean;
}

/** Finds the control a tip belongs to: the nearest ancestor carrying `data-tip`. */
function hostOf(target: EventTarget | null): HTMLElement | null {
	return target instanceof Element ? target.closest<HTMLElement>("[data-tip]") : null;
}

/**
 * The one tooltip for the whole app. Controls opt in with a `data-tip` attribute and this reads it
 * by event delegation, so nothing else carries tooltip state. Lives once, near the root.
 */
export function TooltipHost() {
	const [tip, setTip] = useState<Tip | null>(null);
	const bubble = useRef<HTMLDivElement>(null);
	const host = useRef<HTMLElement | null>(null);
	const timer = useRef<number>(0);
	const warmUntil = useRef(0);
	/** Whether a tip is on screen (rather than waiting out its delay). */
	const shown = useRef(false);

	useEffect(() => {
		/** Measures the control and places the tip centred beneath it (above when it would overflow). */
		const place = (el: HTMLElement) => {
			const r = el.getBoundingClientRect();
			const below = r.bottom + GAP + 32 < window.innerHeight;
			setTip({ text: el.dataset.tip ?? "", x: r.left + r.width / 2, y: below ? r.bottom + GAP : r.top - GAP, above: !below });
		};
		const hide = () => {
			window.clearTimeout(timer.current);
			// Only a tip that was actually read warms the next one; passing over a control doesn't
			if (shown.current) warmUntil.current = Date.now() + WARM_MS;
			shown.current = false;
			host.current = null;
			setTip(null);
		};
		const open = (el: HTMLElement) => {
			if (el === host.current) return;
			window.clearTimeout(timer.current);
			host.current = el;
			const wait = shown.current || Date.now() < warmUntil.current ? 0 : SHOW_DELAY_MS;
			timer.current = window.setTimeout(() => {
				shown.current = true;
				place(el);
			}, wait);
		};

		const onOver = (e: PointerEvent) => {
			if (e.pointerType === "touch") return;
			const el = hostOf(e.target);
			if (el) open(el);
			else if (host.current) hide();
		};
		const onFocus = (e: FocusEvent) => {
			const el = hostOf(e.target);
			if (el && (e.target as Element).matches(":focus-visible")) open(el);
		};
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && hide();

		document.addEventListener("pointerover", onOver);
		document.addEventListener("pointerdown", hide, true);
		document.addEventListener("focusin", onFocus);
		document.addEventListener("focusout", hide);
		document.addEventListener("keydown", onKey);
		window.addEventListener("blur", hide);
		window.addEventListener("scroll", hide, true);
		return () => {
			window.clearTimeout(timer.current);
			document.removeEventListener("pointerover", onOver);
			document.removeEventListener("pointerdown", hide, true);
			document.removeEventListener("focusin", onFocus);
			document.removeEventListener("focusout", hide);
			document.removeEventListener("keydown", onKey);
			window.removeEventListener("blur", hide);
			window.removeEventListener("scroll", hide, true);
		};
	}, []);

	// Keep the tip inside the window once its real width is known
	useEffect(() => {
		const el = bubble.current;
		if (!tip || !el) return;
		const half = el.offsetWidth / 2;
		const x = Math.min(Math.max(tip.x, half + EDGE), window.innerWidth - half - EDGE);
		el.style.left = `${x}px`;
	}, [tip]);

	if (!tip) return null;
	return (
		<div ref={bubble} role="tooltip" className={`tip ${tip.above ? "tip--above" : ""}`} style={{ left: tip.x, top: tip.y }}>
			{tip.text}
		</div>
	);
}

interface TipProps {
	text: string;
	children: React.ReactNode;
}

/**
 * Gives a control its tip. The wrapper carries the attribute rather than the button because a
 * disabled button swallows pointer events, and a greyed-out control is the one that most needs
 * explaining.
 */
export function Tip({ text, children }: TipProps) {
	return (
		<span className="tip-host" data-tip={text}>
			{children}
		</span>
	);
}
