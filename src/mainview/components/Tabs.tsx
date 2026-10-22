import { motion } from "motion/react";
import { EASE_OUT } from "../lib/constants";

interface TabsProps<T extends string> {
	tabs: { id: T; label: string; count?: number }[];
	value: T;
	onChange: (id: T) => void;
	/** Distinguishes the sliding highlight when several tab sets are on screen. */
	layoutId: string;
}

/** Filled pill tabs; the highlight slides to the chosen tab. Arrow keys move between tabs. */
export function Tabs<T extends string>({ tabs, value, onChange, layoutId }: TabsProps<T>) {
	const move = (dir: number) => {
		const i = tabs.findIndex((t) => t.id === value);
		const next = tabs[(i + dir + tabs.length) % tabs.length];
		if (next) onChange(next.id);
	};
	return (
		<div
			className="tabs"
			role="tablist"
			onKeyDown={(e) => {
				if (e.key === "ArrowRight") move(1);
				if (e.key === "ArrowLeft") move(-1);
			}}
		>
			{tabs.map((t) => (
				<button key={t.id} role="tab" aria-selected={t.id === value} tabIndex={t.id === value ? 0 : -1} className={`tabs__tab ${t.id === value ? "is-active" : ""}`} onClick={() => onChange(t.id)}>
					{t.id === value && <motion.span layoutId={layoutId} className="tabs__pill" transition={{ duration: 0.28, ease: EASE_OUT }} />}
					<span className="tabs__label">{t.label}</span>
					{t.count !== undefined && <span className="tabs__count">{t.count}</span>}
				</button>
			))}
		</div>
	);
}
