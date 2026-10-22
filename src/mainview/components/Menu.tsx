import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { POP } from "../lib/constants";

export type MenuItem =
	| { kind?: "item"; label: string; icon?: ReactNode; onSelect: () => void; danger?: boolean; disabled?: boolean; shortcut?: string }
	| { kind: "separator" };

interface MenuProps {
	/** Where it opens, in viewport pixels; null when closed. */
	at: { x: number; y: number } | null;
	items: MenuItem[];
	onClose: () => void;
}

/**
 * A context menu at a point. It opens from that point, stays inside the window, and closes on
 * Escape, a click elsewhere, scrolling or choosing an item. Arrow keys move between items.
 */
export function Menu({ at, items, onClose }: MenuProps) {
	const ref = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState(at);
	// The corner nearest the click, so it grows from the pointer even when pushed back on screen
	const [origin, setOrigin] = useState("top left");

	// Keep it on screen
	useLayoutEffect(() => {
		if (!at || !ref.current) return setPos(at);
		const { width, height } = ref.current.getBoundingClientRect();
		const x = Math.min(at.x, window.innerWidth - width - 8);
		const y = Math.min(at.y, window.innerHeight - height - 8);
		setPos({ x, y });
		setOrigin(`${Math.round(at.x - x)}px ${Math.round(at.y - y)}px`);
	}, [at]);

	// Close on outside interaction; arrows move focus
	useEffect(() => {
		if (!at) return;
		const close = (e: Event) => {
			if (!ref.current?.contains(e.target as Node)) onClose();
		};
		const key = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault();
				const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
				const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
				buttons[(i + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
			}
		};
		window.addEventListener("mousedown", close, true);
		window.addEventListener("wheel", close, true);
		window.addEventListener("keydown", key, true);
		window.addEventListener("blur", onClose);
		return () => {
			window.removeEventListener("mousedown", close, true);
			window.removeEventListener("wheel", close, true);
			window.removeEventListener("keydown", key, true);
			window.removeEventListener("blur", onClose);
		};
	}, [at, onClose]);

	return (
		<AnimatePresence>
			{at && (
				<motion.div ref={ref} role="menu" className="menu" style={{ left: pos?.x ?? at.x, top: pos?.y ?? at.y, transformOrigin: origin }} {...POP}>
					{items.map((item, i) =>
						item.kind === "separator" ? (
							<div key={i} className="menu__sep" role="separator" />
						) : (
							<button
								key={item.label}
								role="menuitem"
								className={`menu__item ${item.danger ? "is-danger" : ""}`}
								disabled={item.disabled}
								onClick={() => {
									onClose();
									item.onSelect();
								}}
							>
								<span className="menu__icon">{item.icon}</span>
								<span className="menu__label">{item.label}</span>
								{item.shortcut && <span className="menu__shortcut">{item.shortcut}</span>}
							</button>
						),
					)}
				</motion.div>
			)}
		</AnimatePresence>
	);
}
