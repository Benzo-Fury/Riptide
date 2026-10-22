import { FileDown, FilePlus2, Link, Pause, Play, RefreshCw, Search, Trash2, X } from "lucide-react";
import { DRAG, NO_DRAG } from "../lib/constants";
import { Button, IconButton } from "../components/Button";

interface ToolbarProps {
	/** The list's filter, set from the palette. */
	query: string;
	onQuery: (q: string) => void;
	onSearch: () => void;
	onAddFile: () => void;
	onAddMagnet: () => void;
	onCreate: () => void;
	/** Selection-dependent actions; disabled when they can't apply. */
	canPause: boolean;
	canResume: boolean;
	canRemove: boolean;
	onPause: () => void;
	onResume: () => void;
	onRemove: () => void;
	canRecheck: boolean;
	onRecheck: () => void;
	/** How many torrents are selected, shown beside the actions when more than one. */
	selectedCount: number;
}

/**
 * The toolbar's search: it opens the command palette, which finds torrents, commands and
 * settings. A filter the palette set on the list shows here, with a way to clear it.
 */
export function SearchTrigger({ query = "", onSearch, onClear }: { query?: string; onSearch: () => void; onClear?: () => void }) {
	return (
		<div className={`search search--trigger ${NO_DRAG}`}>
			<button className="search__button" onClick={onSearch} aria-label={query ? `Search; the list shows “${query}”` : "Search"} aria-haspopup="dialog">
				<Search size={14} strokeWidth={1.5} className="search__icon" />
				<span className={`search__text ellipsis ${query ? "" : "muted"}`}>{query || "Search"}</span>
				{!query && <kbd className="search__kbd">⌘K</kbd>}
			</button>
			{query && onClear && (
				<button className="search__clear" aria-label="Clear search" data-tip="Clear search" onClick={onClear}>
					<X size={12} strokeWidth={2} />
				</button>
			)}
		</div>
	);
}

/** The top bar: it's also the window's drag region; every control opts out of dragging. */
export function Toolbar(p: ToolbarProps) {
	return (
		<header className={`toolbar ${DRAG}`}>
			<div className={`toolbar__group ${NO_DRAG}`}>
				<Button variant="primary" icon={<FileDown size={15} strokeWidth={1.5} />} onClick={p.onAddFile}>
					Add torrent
				</Button>
				<IconButton label="Add magnet link" onClick={p.onAddMagnet}>
					<Link size={16} strokeWidth={1.5} />
				</IconButton>
				<IconButton label="Create torrent" onClick={p.onCreate}>
					<FilePlus2 size={16} strokeWidth={1.5} />
				</IconButton>
			</div>
			<div className={`toolbar__group ${NO_DRAG}`}>
				<IconButton label="Resume" onClick={p.onResume} disabled={!p.canResume}>
					<Play size={16} strokeWidth={1.5} />
				</IconButton>
				<IconButton label="Pause" onClick={p.onPause} disabled={!p.canPause}>
					<Pause size={16} strokeWidth={1.5} />
				</IconButton>
				<IconButton label="Check files again" onClick={p.onRecheck} disabled={!p.canRecheck}>
					<RefreshCw size={16} strokeWidth={1.5} />
				</IconButton>
				<IconButton label="Remove" onClick={p.onRemove} disabled={!p.canRemove}>
					<Trash2 size={16} strokeWidth={1.5} />
				</IconButton>
				{p.selectedCount > 1 && <span className="toolbar__count muted">{p.selectedCount} selected</span>}
			</div>
			<div className="toolbar__spacer" />
			<SearchTrigger query={p.query} onSearch={p.onSearch} onClear={() => p.onQuery("")} />
		</header>
	);
}
