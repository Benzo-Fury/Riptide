import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Search } from "lucide-react";
import { EASE_OUT, SHUTTER } from "../lib/constants";
import { tideBand, useTide } from "../lib/tide";
import { useReducedMotion } from "../lib/hooks";

/** One thing the palette can do. */
export interface PaletteItem {
	id: string;
	label: string;
	/** Items are listed under their group, groups in the order they first appear. */
	group: string;
	/** A quieter line at the right: a state, a shortcut. */
	hint?: string;
	icon?: ReactNode;
	/** Extra words that find it ("limit" finds slow tide). */
	keywords?: string;
	/**
	 * Listed only once something is typed, and only when every typed word appears in its label,
	 * keywords or group (settings, which would crowd the list otherwise).
	 */
	searchOnly?: boolean;
	run: () => void;
}

interface CommandPaletteProps {
	open: boolean;
	onClose: () => void;
	items: PaletteItem[];
	/** Items made from what's typed ("Filter the list by …"), listed after the matches. */
	queryItems?: (query: string) => PaletteItem[];
	/** The query it opens with, selected so typing replaces it. */
	initialQuery?: string;
	placeholder?: string;
}

/** The most items shown at once; typing narrows the rest down. */
const LIMIT = 60;

/**
 * Scores `text` against `query` as a subsequence: every query character must appear in order.
 * Starts of words and runs of consecutive characters score higher. Returns null for no match,
 * with the matched positions for highlighting.
 */
export function fuzzy(query: string, text: string): { score: number; hits: number[] } | null {
	const q = query.toLowerCase().replace(/\s+/g, "");
	if (!q) return { score: 0, hits: [] };
	const t = text.toLowerCase();
	const hits: number[] = [];
	let score = 0;
	let from = 0;
	for (const ch of q) {
		const i = t.indexOf(ch, from);
		if (i < 0) return null;
		const start = i === 0 || /[\s\-_./·]/.test(t[i - 1]!);
		const run = hits.length > 0 && hits[hits.length - 1] === i - 1;
		score += 1 + (start ? 6 : 0) + (run ? 4 : 0) - Math.min(3, (i - from) * 0.1);
		hits.push(i);
		from = i + 1;
	}
	// Shorter texts are closer matches
	return { score: score - t.length * 0.02, hits };
}

/** `text` with the matched characters marked. */
function Marked({ text, hits }: { text: string; hits: number[] }) {
	if (!hits.length) return <>{text}</>;
	const set = new Set(hits);
	return (
		<>
			{[...text].map((ch, i) =>
				set.has(i) ? (
					<mark key={i} className="palette__hit">
						{ch}
					</mark>
				) : (
					ch
				),
			)}
		</>
	);
}

/**
 * A command palette: type to find any action or torrent, arrows to move, Enter to run, Escape
 * to close. The tide pours down over it from the top edge, its search then its list surfacing.
 */
export function CommandPalette({ open, ...panel }: CommandPaletteProps) {
	return <AnimatePresence>{open && <Panel key="palette" {...panel} />}</AnimatePresence>;
}

/** The open palette. Mounted on each opening, so it always starts with an empty query. */
function Panel({ onClose, items, queryItems, initialQuery = "", placeholder = "Search torrents, commands and settings" }: Omit<CommandPaletteProps, "open">) {
	const [query, setQuery] = useState(initialQuery);
	const [active, setActive] = useState(0);
	const list = useRef<HTMLDivElement>(null);
	const panel = useRef<HTMLDivElement>(null);
	const reduced = useReducedMotion();
	const { clip, shade } = useTide(panel, { reduced, from: "top", duration: 0.5 });

	// Matches, best first when there's a query; grouped in their given order otherwise
	const matches = useMemo(() => {
		const searching = !!query.trim();
		const words = query.toLowerCase().split(/\s+/).filter(Boolean);
		const scored = items
			.map((item) => {
				if (item.searchOnly && (!searching || !words.every((w) => `${item.label} ${item.keywords ?? ""} ${item.group}`.toLowerCase().includes(w)))) return null;
				const label = fuzzy(query, item.label);
				const extra = label ? null : fuzzy(query, `${item.keywords ?? ""} ${item.group}`);
				return label ? { item, score: label.score, hits: label.hits } : extra ? { item, score: extra.score - 5, hits: [] } : null;
			})
			.filter((m): m is NonNullable<typeof m> => m !== null);
		if (searching) scored.sort((a, b) => b.score - a.score);
		const extra = searching && queryItems ? queryItems(query.trim()).map((item) => ({ item, score: 0, hits: [] as number[] })) : [];
		return [...scored.slice(0, LIMIT), ...extra];
	}, [items, queryItems, query]);

	useEffect(() => setActive(0), [query]);

	// Keep the active row in view
	useEffect(() => {
		list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
	}, [active]);

	const run = (i: number) => {
		const m = matches[i];
		if (!m) return;
		onClose();
		// After the close, so dialogs the command opens get focus
		setTimeout(m.item.run, 0);
	};

	const onKey = (e: KeyboardEvent) => {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setActive((a) => Math.min(matches.length - 1, a + 1));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setActive((a) => Math.max(0, a - 1));
		} else if (e.key === "Enter") {
			e.preventDefault();
			run(active);
		} else if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			onClose();
		}
	};

	// Group headings where the group changes (only without a query, when order is by group)
	const grouped = !query.trim();
	return (
		<motion.div className="dialog-layer palette-layer" {...SHUTTER.scrim} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
			<div ref={panel} role="dialog" aria-modal="true" aria-label="Command palette" className="palette" onKeyDown={onKey}>
				<motion.div className="float-shade" aria-hidden="true" {...(reduced ? SHUTTER.still : { style: { opacity: shade } })} />
				<motion.div className="palette__clip" style={{ clipPath: clip }} {...(reduced ? SHUTTER.still : {})}>
					<motion.div className="palette__search" {...tideBand(0, reduced, "top")}>
						<Search size={16} strokeWidth={1.5} className="palette__icon" />
						<input
							autoFocus
							onFocus={(e) => e.target.select()}
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder={placeholder}
							spellCheck={false}
							autoComplete="off"
							role="combobox"
							aria-expanded="true"
							aria-controls="palette-list"
							aria-activedescendant={matches[active] ? `palette-${matches[active]!.item.id}` : undefined}
						/>
						<kbd className="palette__esc">esc</kbd>
					</motion.div>
					<motion.div ref={list} id="palette-list" className="palette__list" role="listbox" {...tideBand(1, reduced, "top")}>
						{matches.length === 0 && <p className="palette__none">Nothing matches “{query}”.</p>}
						{matches.map((m, i) => (
							<div key={m.item.id}>
								{grouped && (i === 0 || matches[i - 1]!.item.group !== m.item.group) && <p className="palette__group">{m.item.group}</p>}
								<div id={`palette-${m.item.id}`} data-index={i} role="option" aria-selected={i === active} className={`palette__item ${i === active ? "is-active" : ""}`} onMouseMove={() => i !== active && setActive(i)} onClick={() => run(i)}>
									{i === active && <motion.span layoutId="palette-active" className="palette__pill" transition={{ duration: 0.18, ease: EASE_OUT }} />}
									<span className="palette__glyph">{m.item.icon}</span>
									<span className="palette__label ellipsis">
										<Marked text={m.item.label} hits={m.hits} />
									</span>
									{m.item.hint && <span className="palette__hint ellipsis">{m.item.hint}</span>}
								</div>
							</div>
						))}
					</motion.div>
				</motion.div>
			</div>
		</motion.div>
	);
}
