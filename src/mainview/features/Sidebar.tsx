import { motion } from "motion/react";
import { Settings as SettingsIcon } from "lucide-react";
import type { TorrentSummary } from "../../shared/types";
import { formatRate, splitRate } from "../../shared/format";
import { DRAG, EASE_OUT, FILTERS, type FilterId } from "../lib/constants";
import { useEngine } from "../lib/store";
import { useTween } from "../lib/hooks";
import { CurrentField } from "./CurrentField";

interface SidebarProps {
	torrents: TorrentSummary[];
	filter: FilterId;
	onFilter: (id: FilterId) => void;
	view: "list" | "settings";
	onSettings: () => void;
}

/** One filter in the list, with its count. */
function FilterItem({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
	return (
		<button className={`nav__item ${active ? "is-active" : ""}`} onClick={onClick} aria-current={active ? "page" : undefined}>
			{active && <motion.span layoutId="nav-active" className="nav__pill" transition={{ duration: 0.3, ease: EASE_OUT }} />}
			<span className="nav__label">{label}</span>
			<span className="nav__count">{count}</span>
		</button>
	);
}

/** The live download figure, set large, with the upload rate beneath. */
function RateFigure({ down, up, peers }: { down: number; up: number; peers: number }) {
	const shownDown = useTween(down, 600);
	const [figure, unit] = splitRate(shownDown);
	return (
		<div className="rate-figure" aria-live="off">
			<p className="rate-figure__value">
				<span className="rate-figure__num">{figure}</span>
				<span className="rate-figure__unit">{unit}</span>
			</p>
			<p className="rate-figure__line">
				{down > 0 || up > 0 ? `in from ${peers} ${peers === 1 ? "peer" : "peers"} · ${formatRate(up)} out` : "Still water. Nothing is moving."}
			</p>
		</div>
	);
}

/** The sidebar: wordmark, filters, settings, and the current at the bottom. */
export function Sidebar({ torrents, filter, onFilter, view, onSettings }: SidebarProps) {
	const engine = useEngine();
	return (
		<aside className="sidebar">
			<div className={`sidebar__bar ${DRAG}`} />
			<div className="sidebar__brand">
				<span className="display sidebar__wordmark">Riptide</span>
			</div>
			<nav className="nav" aria-label="Filters">
				{FILTERS.map((f) => {
					const count = torrents.filter(f.test).length;
					if (f.hideWhenEmpty && count === 0) return null;
					return <FilterItem key={f.id} label={f.label} count={count} active={view === "list" && filter === f.id} onClick={() => onFilter(f.id)} />;
				})}
				<button className={`nav__item nav__item--settings ${view === "settings" ? "is-active" : ""}`} onClick={onSettings} aria-current={view === "settings" ? "page" : undefined}>
					{view === "settings" && <motion.span layoutId="nav-active" className="nav__pill" transition={{ duration: 0.3, ease: EASE_OUT }} />}
					<SettingsIcon size={15} strokeWidth={1.5} className="nav__icon" />
					<span className="nav__label">Settings</span>
				</button>
			</nav>
			<div className="sidebar__current">
				<CurrentField down={engine?.downRate ?? 0} up={engine?.upRate ?? 0} peers={engine?.peers ?? 0} />
				<RateFigure down={engine?.downRate ?? 0} up={engine?.upRate ?? 0} peers={engine?.peers ?? 0} />
			</div>
		</aside>
	);
}
