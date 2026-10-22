import { memo, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowDown, ArrowUp, FileDown, Link } from "lucide-react";
import type { TorrentSummary } from "../../shared/types";
import { formatBytes, formatDuration, formatRate } from "../../shared/format";
import { ACTIVE_STATES, EASE_OUT, STATE_LABELS, STATUS_SHORT, remaining, SORTS, type FilterId, type SortId } from "../lib/constants";
import { useReducedMotion, useStable } from "../lib/hooks";
import { Button } from "../components/Button";
import { StatusIcon } from "../components/StatusIcon";
import { ProgressBar, flowFor, type ProgressTone } from "../components/ProgressBar";
import { LowWater } from "./LowWater";

// ---------- Columns ---------- //

/** The bar's colour for each state. */
function toneOf(t: TorrentSummary): ProgressTone {
	if (t.state === "error") return "danger";
	if (t.state === "seeding") return "sea";
	if (t.state === "checking") return "accent";
	if (["paused", "queued", "waiting"].includes(t.state)) return "muted";
	return "ink";
}

/** Fully downloaded and healthy: the bar has nothing left to say. */
function isComplete(t: TorrentSummary): boolean {
	return t.hasMetadata && t.progress >= 1 && t.state !== "error" && t.state !== "checking";
}

/** The columns after the name: sort id, header, cell text and CSS class. */
const COLUMNS: {
	id: SortId;
	label: string;
	cell: (t: TorrentSummary) => string;
	className: string;
}[] = [
	{ id: "size", label: "Size", cell: (t) => (t.hasMetadata ? formatBytes(t.size) : "—"), className: "col-size" },
	{ id: "status", label: "Status", cell: (t) => STATUS_SHORT[t.state], className: "col-status" },
	{ id: "seeds", label: "Seeds", cell: (t) => String(t.seeds), className: "col-count" },
	{ id: "peers", label: "Peers", cell: (t) => String(t.peers), className: "col-count" },
	{ id: "down", label: "Down", cell: (t) => (t.downRate > 0 && t.progress < 1 ? formatRate(t.downRate) : ""), className: "col-rate" },
	{ id: "up", label: "Up", cell: (t) => (t.upRate > 0 ? formatRate(t.upRate) : ""), className: "col-rate" },
	{ id: "eta", label: "Left", cell: (t) => (t.state === "downloading" && t.progress < 1 ? formatDuration(remaining(t)) : ""), className: "col-eta" },
];

// ---------- Row ---------- //

/** The name's size at rest and while its details are open (px). */
const NAME_REST = 14;
const NAME_OPEN = 24;

/** Letters past this many swell together, so long names don't keep the wave running. */
const SWELL_LETTERS = 48;

/**
 * The name of the open torrent, set large over the row as the details' title. A swell runs
 * through it letter by letter as it grows; when the details close it settles back as one piece,
 * shrinking toward the row's own name while that fades back in beneath it.
 */
function SwellName({ name, open }: { name: string; open: boolean }) {
	const reduced = useReducedMotion();
	const letters = useMemo(() => Array.from(name), [name]);
	return (
		<motion.span
			className="row__swell"
			aria-hidden="true"
			initial={{ opacity: 0 }}
			animate={open ? { opacity: 1, scale: 1 } : { opacity: 0, scale: reduced ? 1 : NAME_REST / NAME_OPEN }}
			transition={open ? { duration: 0.12, ease: "linear" } : { duration: 0.3, ease: EASE_OUT, opacity: { duration: 0.14, delay: 0.04, ease: "linear" } }}
		>
			{reduced
				? name
				: letters.map((ch, i) => (
						<motion.span key={i} initial={{ fontSize: NAME_REST }} animate={{ fontSize: NAME_OPEN }} transition={{ duration: 0.5, ease: EASE_OUT, delay: Math.min(i, SWELL_LETTERS) * 0.009 }}>
							{ch}
						</motion.span>
					))}
		</motion.span>
	);
}

interface RowProps {
	t: TorrentSummary;
	selected: boolean;
	onSelect: (hash: string, e: MouseEvent) => void;
	onOpen: (t: TorrentSummary) => void;
	onMenu: (t: TorrentSummary, e: MouseEvent) => void;
	onChooseFiles: (t: TorrentSummary) => void;
	/** The details panel, unfolded beneath the row when this is the open torrent. */
	detail?: ReactNode;
}

/** One torrent: name, then figures in columns, with the progress bar along the bottom until it's done. */
const Row = memo(function Row({ t, selected, onSelect, onOpen, onMenu, onChooseFiles, detail }: RowProps) {
	// Keep the group unfolded around the drawer until it has finished sliding shut
	const [unfolded, setUnfolded] = useState(false);
	if (detail && !unfolded) setUnfolded(true);
	const active = ACTIVE_STATES.has(t.state);
	const rate = t.state === "seeding" ? t.upRate : t.downRate;
	const complete = isComplete(t);
	return (
		<motion.div
			layout="position"
			className={`row-group ${detail || unfolded ? "is-unfolded" : ""} ${detail ? "is-open" : ""}`}
			initial={{ opacity: 0, clipPath: "inset(0 0 100% 0)" }}
			animate={{ opacity: 1, clipPath: "inset(0 0 0% 0)" }}
			exit={{ opacity: 0, x: -16, transition: { duration: 0.18 } }}
			transition={{ duration: 0.45, ease: EASE_OUT }}
		>
			<div
				role="row"
				aria-selected={selected}
				aria-expanded={!!detail}
				data-hash={t.hash}
				className={`row ${selected ? "is-selected" : ""} row--${t.state}`}
				onMouseDown={(e) => e.button === 0 && onSelect(t.hash, e)}
				onDoubleClick={() => onOpen(t)}
				onContextMenu={(e) => {
					e.preventDefault();
					if (!selected) onSelect(t.hash, e);
					onMenu(t, e);
				}}
			>
				<div className="row__main" role="gridcell">
					<StatusIcon state={t.state} label={STATE_LABELS[t.state]} />
					<span className="row__title">
						<span className="row__name ellipsis" data-tip={t.name}>
							{t.name}
						</span>
						{/* Its own presence, so the list's initial={false} doesn't skip the swell */}
						<AnimatePresence>{unfolded && <SwellName name={t.name} open={!!detail} />}</AnimatePresence>
					</span>
				</div>
				{COLUMNS.map((c) =>
					c.id === "status" && t.state === "waiting" ? (
						<div key={c.id} role="gridcell" className={`row__cell ${c.className}`}>
							<Button
								variant="secondary"
								className="row__choose"
								onMouseDown={(e) => e.stopPropagation()}
								onClick={(e) => {
									e.stopPropagation();
									onChooseFiles(t);
								}}
							>
								Choose files
							</Button>
						</div>
					) : (
						<span key={c.id} role="gridcell" className={`row__cell ${c.className}`} data-tip={c.id === "status" && t.error ? t.error : undefined}>
							{c.cell(t)}
						</span>
					),
				)}
				{!complete && (
					<div className="row__bar">
						<ProgressBar value={t.progress} tone={toneOf(t)} flow={active ? flowFor(rate) : 0} indeterminate={t.state === "metadata"} complete={t.hasMetadata && t.progress >= 1} label={`${t.name} progress`} />
					</div>
				)}
			</div>
			<AnimatePresence initial={false} onExitComplete={() => setUnfolded(false)}>
				{detail}
			</AnimatePresence>
		</motion.div>
	);
});

// ---------- Empty states ---------- //

/**
 * Every empty view's layout: a heading that says what's empty, a line on what would be here, the
 * way forward, and a low stream beside it, nearly run dry.
 */
function EmptyState({ title, text, heading: Heading = "h2", children }: { title: string; text: string; heading?: "h1" | "h2"; children?: ReactNode }) {
	return (
		<div className="nothing">
			<div className="nothing__text">
				<Heading className="display nothing__title">{title}</Heading>
				<p className="nothing__lede">{text}</p>
				{children && <div className="nothing__actions">{children}</div>}
			</div>
			<LowWater className="nothing__water" />
		</div>
	);
}

/** The first run, before any torrent is added. */
function EmptyLibrary({ onAddFile, onAddMagnet }: { onAddFile: () => void; onAddMagnet: () => void }) {
	return (
		<div className="empty">
			<EmptyState heading="h1" title="Nothing in the current yet." text="Add a torrent file or paste a magnet link. You can also drop either anywhere in this window.">
				<Button variant="primary" icon={<FileDown size={15} strokeWidth={1.5} />} onClick={onAddFile}>
					Add torrent file
				</Button>
				<Button icon={<Link size={15} strokeWidth={1.5} />} onClick={onAddMagnet}>
					Paste magnet link
				</Button>
			</EmptyState>
		</div>
	);
}

/** What each sidebar filter would show, said when it shows nothing. */
const NOTHING: Record<FilterId, { title: string; text: string }> = {
	all: { title: "No torrents here.", text: "Add a torrent file or paste a magnet link to start." },
	downloading: { title: "Nothing downloading.", text: "Torrents show here while they fetch their files, and while they wait their turn in the queue." },
	seeding: { title: "Nothing seeding.", text: "Finished torrents show here while they share their pieces with other people." },
	completed: { title: "Nothing finished yet.", text: "Torrents land here once every file you chose is downloaded and checked." },
	paused: { title: "Nothing paused.", text: "Pause a torrent and it waits here until you resume it." },
	errored: { title: "No errors.", text: "Torrents that stop on a problem, like a full disk, show here with what went wrong." },
};

/** The longest search shown in the heading, so it keeps to two lines. */
const QUERY_SHOWN = 22;

/** A filter or search with no torrents: what's empty, and a way back. */
function NothingHere({ filter, query, onShowAll, onClearQuery }: { filter: FilterId; query: string; onShowAll: () => void; onClearQuery: () => void }) {
	const shown = query.length > QUERY_SHOWN ? `${query.slice(0, QUERY_SHOWN - 1)}…` : query;
	const copy = query ? { title: `Nothing matches “${shown}”.`, text: "No torrent has that in its name. Try another word, or clear the search." } : NOTHING[filter];
	return (
		<EmptyState title={copy.title} text={copy.text}>
			{query ? <Button onClick={onClearQuery}>Clear search</Button> : filter !== "all" ? <Button onClick={onShowAll}>Show all torrents</Button> : null}
		</EmptyState>
	);
}

// ---------- List ---------- //

interface TorrentListProps {
	torrents: TorrentSummary[];
	/** True when the library has torrents but the filter or search hides them all. */
	filtered: boolean;
	/** The sidebar filter in effect, for what an empty list says. */
	filter: FilterId;
	query: string;
	onShowAll: () => void;
	onClearQuery: () => void;
	sort: SortId;
	/** Reverse the column's natural order (clicking a sorted header again). */
	reversed: boolean;
	onSort: (id: SortId) => void;
	selection: Set<string>;
	onSelect: (hash: string, e: MouseEvent) => void;
	onClearSelection: () => void;
	onOpen: (t: TorrentSummary) => void;
	onMenu: (t: TorrentSummary, e: MouseEvent) => void;
	onChooseFiles: (t: TorrentSummary) => void;
	onAddFile: () => void;
	onAddMagnet: () => void;
	/** The torrent whose details are unfolded, and the panel to show under it. */
	detailHash: string | null;
	detail: ReactNode;
}

/** The torrent table: sortable header, rows, and the empty states. */
export function TorrentList(props: TorrentListProps) {
	const { torrents, filtered, query, sort, reversed, onSort, selection } = props;
	const [hoverSort, setHoverSort] = useState<SortId | null>(null);
	// The parent's handlers close over state that changes every snapshot; give the memoised rows steady ones
	const onSelect = useStable(props.onSelect);
	const onOpen = useStable(props.onOpen);
	const onMenu = useStable(props.onMenu);
	const onChooseFiles = useStable(props.onChooseFiles);

	if (torrents.length === 0 && !filtered) return <EmptyLibrary onAddFile={props.onAddFile} onAddMagnet={props.onAddMagnet} />;

	const sortArrow = (id: SortId) =>
		sort === id ? reversed ? <ArrowUp size={12} strokeWidth={2} /> : <ArrowDown size={12} strokeWidth={2} /> : hoverSort === id ? <ArrowDown size={12} strokeWidth={2} className="muted" /> : null;
	const header = (id: SortId, label: string, className: string) => (
		<button
			role="columnheader"
			aria-sort={sort === id ? (reversed ? "ascending" : "descending") : "none"}
			className={`list__head-cell ${className} ${sort === id ? "is-sorted" : ""}`}
			onClick={() => onSort(id)}
			onMouseEnter={() => setHoverSort(id)}
			onMouseLeave={() => setHoverSort(null)}
		>
			{label}
			{sortArrow(id)}
		</button>
	);

	return (
		<div className="list" role="grid" aria-label="Torrents" aria-multiselectable>
			<div className="list__head" role="row">
				{header("name", "Name", "col-name")}
				{COLUMNS.map((c) => header(c.id, c.label, c.className))}
			</div>
			<div className="list__body" onMouseDown={(e) => e.target === e.currentTarget && props.onClearSelection()}>
				{torrents.length === 0 ? (
					<NothingHere filter={props.filter} query={query} onShowAll={props.onShowAll} onClearQuery={props.onClearQuery} />
				) : (
					<AnimatePresence initial={false}>
						{torrents.map((t) => (
							<Row
								key={t.hash}
								t={t}
								selected={selection.has(t.hash)}
								onSelect={onSelect}
								onOpen={onOpen}
								onMenu={onMenu}
								onChooseFiles={onChooseFiles}
								detail={t.hash === props.detailHash ? props.detail : undefined}
							/>
						))}
					</AnimatePresence>
				)}
			</div>
		</div>
	);
}

/** Sorts torrents by a column in its natural order (newest, biggest, fastest first; names A–Z), or reversed. */
export function sortTorrents(list: TorrentSummary[], sort: SortId, reversed: boolean): TorrentSummary[] {
	const key = SORTS.find((s) => s.id === sort)?.key ?? SORTS[0]!.key;
	const sorted = [...list].sort((a, b) => {
		const ka = key(a);
		const kb = key(b);
		return ka < kb ? -1 : ka > kb ? 1 : b.addedAt - a.addedAt;
	});
	return reversed ? sorted.reverse() : sorted;
}
