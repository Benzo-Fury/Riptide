import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { MotionConfig } from "motion/react";
import { ArrowLeft, ArrowRight, Copy, Search, SlidersHorizontal, FileOutput, FilePlus2, FolderOpen, ListChecks, ListFilter, Lock, Magnet, PackagePlus, Pause, Play, RefreshCw, Settings as SettingsIcon, Trash2, Waves } from "lucide-react";
import type { TorrentSource, TorrentSummary, UiCommand } from "../shared/types";
import { formatPercent } from "../shared/format";
import { DRAG, FILTERS, NO_DRAG, STATE_LABELS, isPausable, type FilterId, type SortId } from "./lib/constants";
import { actions } from "./lib/actions";
import { call, onPush } from "./lib/bridge";
import { useSettings, useSlowTide, useSnapshot, useTorrents } from "./lib/store";
import { Button } from "./components/Button";
import { CommandPalette, type PaletteItem } from "./components/CommandPalette";
import { Menu, type MenuItem } from "./components/Menu";
import { ToastHost, toast, toastError } from "./components/Toasts";
import { AddDialog, ChooseFilesDialog, MagnetDialog } from "./features/AddFlow";
import { useClipboardMagnets } from "./features/ClipboardMagnets";
import { CreateDialog } from "./features/CreateDialog";
import { DetailsDrawer } from "./features/DetailsDrawer";
import { DropOverlay } from "./features/DropOverlay";
import { RemoveDialog } from "./features/RemoveDialog";
import { SettingsView, type SettingsReveal } from "./features/SettingsView";
import { Sidebar } from "./features/Sidebar";
import { StatusBar } from "./features/StatusBar";
import { SearchTrigger, Toolbar } from "./features/Toolbar";
import { TorrentList, sortTorrents } from "./features/TorrentList";
import { SETTINGS_INDEX } from "./lib/settingsIndex";

/** Commands arrive from both the page's keys and the app menu; ignore the echo of one keypress. */
const COMMAND_ECHO_MS = 300;

/** Whether focus is in a text field (where keys belong to the field). */
const typing = () => {
	const el = document.activeElement;
	return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
};

export function App() {
	const torrents = useTorrents();
	const [view, setView] = useState<"list" | "settings">("list");
	const [filter, setFilter] = useState<FilterId>("all");
	const [query, setQuery] = useState("");
	const [sort, setSort] = useState<SortId>("added");
	const [reversed, setReversed] = useState(false);
	const [selection, setSelection] = useState<Set<string>>(new Set());
	const [anchor, setAnchor] = useState<string | null>(null);
	// The torrent whose details are unfolded; clicking its row again folds them away
	const [openHash, setOpenHash] = useState<string | null>(null);

	const [addQueue, setAddQueue] = useState<TorrentSource[]>([]);
	const [magnetOpen, setMagnetOpen] = useState(false);
	const [createOpen, setCreateOpen] = useState(false);
	const [removing, setRemoving] = useState<{ list: TorrentSummary[]; withFiles: boolean }>({ list: [], withFiles: false });
	const [choosing, setChoosing] = useState<TorrentSummary | null>(null);
	const [menu, setMenu] = useState<{ at: { x: number; y: number }; items: MenuItem[] } | null>(null);
	const [paletteOpen, setPaletteOpen] = useState(false);
	const settings = useSettings();
	const snapshot = useSnapshot();
	const tide = useSlowTide();
	const [settingsReveal, setSettingsReveal] = useState<SettingsReveal | null>(null);

	// ---------- Derived ---------- //

	const visible = useMemo(() => {
		const f = FILTERS.find((x) => x.id === filter) ?? FILTERS[0]!;
		const q = query.trim().toLowerCase();
		return sortTorrents(
			torrents.filter((t) => f.test(t) && (!q || t.name.toLowerCase().includes(q) || t.hash.startsWith(q))),
			sort,
			reversed,
		);
	}, [torrents, filter, query, sort, reversed]);

	const selected = useMemo(() => torrents.filter((t) => selection.has(t.hash)), [torrents, selection]);
	const focused = useMemo(() => torrents.find((t) => t.hash === anchor && selection.has(t.hash)) ?? selected[0] ?? null, [torrents, anchor, selection, selected]);

	// Forget selected torrents that were removed
	useEffect(() => {
		const hashes = new Set(torrents.map((t) => t.hash));
		if ([...selection].some((h) => !hashes.has(h))) setSelection(new Set([...selection].filter((h) => hashes.has(h))));
	}, [torrents, selection]);

	// ---------- Adding ---------- //

	const enqueue = useCallback((sources: TorrentSource[]) => {
		setView("list");
		setAddQueue((q) => [...q, ...sources]);
	}, []);

	const addFiles = useCallback(async () => {
		try {
			const paths = await call("pickTorrentFiles");
			if (paths.length) enqueue(paths.map((path) => ({ kind: "file", path })));
		} catch (e) {
			toastError(e);
		}
	}, [enqueue]);

	/** From the magnet dialog: one link gets the add dialog; several are added with defaults. */
	const addMagnets = useCallback(
		async (sources: TorrentSource[]) => {
			if (sources.length === 1) return enqueue(sources);
			const results = await Promise.allSettled(sources.map((source) => call("add", { source })));
			const added = results.filter((r) => r.status === "fulfilled" && !r.value.existing).length;
			const failed = results.filter((r) => r.status === "rejected").length;
			toast(`Added ${added} of ${sources.length} links${failed ? `; ${failed} couldn't be read` : ""}.`, failed ? "error" : "success");
		},
		[enqueue],
	);

	const doneWithSource = useCallback((s: TorrentSource) => setAddQueue((q) => q.filter((x) => x !== s)), []);
	const onAdded = useCallback((hash: string) => {
		setFilter("all");
		setSelection(new Set([hash]));
		setAnchor(hash);
	}, []);

	// ---------- Selection ---------- //

	const onSelect = useCallback(
		(hash: string, e: MouseEvent) => {
			// Shift extends from the anchor; Cmd toggles; a plain click selects one
			if (e.shiftKey && anchor) {
				const a = visible.findIndex((t) => t.hash === anchor);
				const b = visible.findIndex((t) => t.hash === hash);
				if (a >= 0 && b >= 0) {
					const [lo, hi] = a < b ? [a, b] : [b, a];
					setSelection(new Set(visible.slice(lo, hi + 1).map((t) => t.hash)));
					return;
				}
			}
			if (e.metaKey || e.ctrlKey) {
				const next = new Set(selection);
				if (next.has(hash)) next.delete(hash);
				else next.add(hash);
				setSelection(next);
			} else if (!(e.type === "contextmenu" && selection.has(hash))) {
				setSelection(new Set([hash]));
				if (e.type !== "contextmenu") setOpenHash((open) => (open === hash ? null : hash));
			}
			setAnchor(hash);
		},
		[anchor, visible, selection],
	);

	const hashes = (list: TorrentSummary[]) => list.map((t) => t.hash);
	const canPause = selected.some(isPausable);
	const canResume = selected.some((t) => !isPausable(t));

	// ---------- Context menu ---------- //

	const openMenu = useCallback(
		(t: TorrentSummary, e: MouseEvent) => {
			const targets = selection.has(t.hash) ? selected : [t];
			const one = targets.length === 1 ? targets[0]! : null;
			const items: MenuItem[] = [
				targets.some(isPausable)
					? { label: "Pause", icon: <Pause size={14} strokeWidth={1.5} />, onSelect: () => actions.pause(hashes(targets)) }
					: { label: "Resume", icon: <Play size={14} strokeWidth={1.5} />, onSelect: () => actions.resume(hashes(targets)) },
				...(one?.state === "waiting" ? [{ label: "Choose files…", icon: <ListChecks size={14} strokeWidth={1.5} />, onSelect: () => setChoosing(one) }] : []),
				{ label: "Check files again", icon: <RefreshCw size={14} strokeWidth={1.5} />, onSelect: () => actions.recheck(hashes(targets)), disabled: targets.every((x) => !x.hasMetadata) },
				{ kind: "separator" },
				{ label: "Open", icon: <FolderOpen size={14} strokeWidth={1.5} />, onSelect: () => one && actions.open(one), disabled: !one?.hasMetadata },
				{ label: "Show in Finder", onSelect: () => one && actions.reveal(one), disabled: !one?.hasMetadata },
				{ kind: "separator" },
				{ label: "Copy magnet link", icon: <Copy size={14} strokeWidth={1.5} />, onSelect: () => one && actions.copyMagnet(one.hash), disabled: !one },
				{ label: "Save .torrent file…", icon: <FileOutput size={14} strokeWidth={1.5} />, onSelect: () => one && actions.exportTorrent(one.hash), disabled: !one?.hasMetadata },
				{ kind: "separator" },
				{ label: targets.length > 1 ? `Remove ${targets.length} torrents…` : "Remove…", icon: <Trash2 size={14} strokeWidth={1.5} />, onSelect: () => setRemoving({ list: targets, withFiles: false }) },
				{ label: "Remove and delete files…", danger: true, onSelect: () => setRemoving({ list: targets, withFiles: true }) },
			];
			setMenu({ at: { x: e.clientX, y: e.clientY }, items });
		},
		[selection, selected],
	);

	// ---------- Commands ---------- //

	const lastCommand = useRef<{ name: UiCommand; at: number } | null>(null);
	const runCommand = useCallback(
		(name: UiCommand) => {
			const now = Date.now();
			if (lastCommand.current?.name === name && now - lastCommand.current.at < COMMAND_ECHO_MS) return;
			lastCommand.current = { name, at: now };
			switch (name) {
				case "addFile":
					return void addFiles();
				case "addMagnet":
					return setMagnetOpen(true);
				case "create":
					return setCreateOpen(true);
				case "settings":
					return setView("settings");
				case "pauseAll":
					return actions.pause(hashes(torrents));
				case "resumeAll":
					return actions.resume(hashes(torrents.filter((t) => !isPausable(t))));
				case "selectAll":
					setView("list");
					return setSelection(new Set(hashes(visible)));
				case "find":
					return setPaletteOpen(true);
				case "palette":
					return setPaletteOpen((o) => !o);
				case "slowTide":
					return actions.setSlowTide(!tide?.on);
			}
		},
		[addFiles, torrents, visible, tide],
	);

	// Pushes from the main process
	useEffect(() => {
		const offs = [
			onPush("command", ({ name }) => runCommand(name)),
			onPush("openSources", ({ sources }) => enqueue(sources)),
			onPush("torrentEvent", (e) => {
				if (e.kind === "completed") toast(`Finished: ${e.name}`, "success");
				if (e.kind === "error") toast(`${e.name} stopped: ${e.message ?? "an error occurred"}`, "error");
			}),
		];
		return () => offs.forEach((off) => off());
	}, [runCommand, enqueue]);

	// Torrents opened from outside before the UI was ready
	useEffect(() => {
		call("takePendingSources")
			.then((s) => s.length && enqueue(s))
			.catch(() => {});
	}, [enqueue]);

	// A magnet added to choose files later announces when its list arrives
	const prevStates = useRef(new Map<string, string>());
	useEffect(() => {
		for (const t of torrents) {
			const was = prevStates.current.get(t.hash);
			if (t.state === "waiting" && was && was !== "waiting") toast(`${t.name}: the file list is here.`, "info", { label: "Choose files", onSelect: () => setChoosing(t) });
			prevStates.current.set(t.hash, t.state);
		}
	}, [torrents]);

	// ---------- Keyboard ---------- //

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const mod = e.metaKey || e.ctrlKey;
			const dialogOpen = !!document.querySelector(".dialog-layer, .traffic-layer");

			// App shortcuts (also in the menu; the page claims them first so they work in the browser too)
			if (mod && !e.shiftKey && !e.altKey) {
				const map: Record<string, UiCommand> = { o: "addFile", u: "addMagnet", n: "create", ",": "settings", f: "find", k: "palette" };
				const cmd = map[e.key.toLowerCase()];
				if (cmd && (!dialogOpen || (cmd === "palette" && paletteOpen))) {
					e.preventDefault();
					return runCommand(cmd);
				}
				if (e.key.toLowerCase() === "a" && !typing() && !dialogOpen && view === "list") {
					e.preventDefault();
					return runCommand("selectAll");
				}
			}
			if (typing() || dialogOpen || view !== "list") return;

			// List keys
			if ((e.key === "Backspace" || e.key === "Delete") && selected.length) {
				e.preventDefault();
				setRemoving({ list: selected, withFiles: e.shiftKey });
			} else if (e.key === " " && selected.length) {
				e.preventDefault();
				if (canPause) actions.pause(hashes(selected.filter(isPausable)));
				else actions.resume(hashes(selected));
			} else if (e.key === "Escape") {
				setSelection(new Set());
			} else if (e.key === "Enter" && focused) {
				actions.open(focused);
			} else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && visible.length) {
				e.preventDefault();
				const i = visible.findIndex((t) => t.hash === (anchor ?? ""));
				const next = visible[Math.max(0, Math.min(visible.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))]!;
				setSelection(e.shiftKey ? new Set([...selection, next.hash]) : new Set([next.hash]));
				setAnchor(next.hash);
				document.querySelector(`[data-hash="${next.hash}"]`)?.scrollIntoView({ block: "nearest" });
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [runCommand, view, selected, selection, canPause, focused, visible, anchor, paletteOpen]);

	// Magnet links copied elsewhere, offered when the window comes back
	useClipboardMagnets(settings?.clipboardMagnets !== false && snapshot !== null, torrents, enqueue);

	// ---------- Palette ---------- //

	/** Brings one torrent into view, selected with its details unfolded. */
	const showTorrent = useCallback((hash: string) => {
		setView("list");
		setFilter("all");
		setQuery("");
		setSelection(new Set([hash]));
		setAnchor(hash);
		setOpenHash(hash);
		setTimeout(() => document.querySelector(`[data-hash="${hash}"]`)?.scrollIntoView({ block: "nearest" }), 50);
	}, []);

	/** Opens settings at one setting. */
	const openSettings = useCallback((reveal: Omit<SettingsReveal, "at">) => {
		setView("settings");
		setSettingsReveal({ ...reveal, at: Date.now() });
	}, []);

	// A reveal is for one visit; coming back to settings later starts at the top
	useEffect(() => {
		if (view !== "settings") setSettingsReveal(null);
	}, [view]);

	const paletteItems = useMemo((): PaletteItem[] => {
		const icon = (I: typeof Play) => <I size={15} strokeWidth={1.5} />;
		const items: PaletteItem[] = [];

		// What's selected comes first: the things you're most likely here to do
		if (selected.length) {
			const group = selected.length === 1 ? `Selected: ${selected[0]!.name}` : `${selected.length} selected`;
			const one = selected.length === 1 ? selected[0]! : null;
			if (canPause) items.push({ id: "sel-pause", group, label: "Pause", icon: icon(Pause), run: () => actions.pause(hashes(selected.filter(isPausable))) });
			if (canResume) items.push({ id: "sel-resume", group, label: "Resume", icon: icon(Play), run: () => actions.resume(hashes(selected.filter((t) => !isPausable(t)))) });
			if (one?.hasMetadata) {
				items.push({ id: "sel-open", group, label: "Open", icon: icon(FolderOpen), run: () => actions.open(one) });
				items.push({ id: "sel-reveal", group, label: "Show in Finder", icon: icon(FolderOpen), keywords: "reveal folder", run: () => actions.reveal(one) });
			}
			if (one) items.push({ id: "sel-magnet", group, label: "Copy magnet link", icon: icon(Copy), keywords: "share", run: () => actions.copyMagnet(one.hash) });
			items.push({ id: "sel-recheck", group, label: "Check files again", icon: icon(RefreshCw), keywords: "verify recheck hash", run: () => actions.recheck(hashes(selected)) });
			items.push({ id: "sel-remove", group, label: "Remove…", icon: icon(Trash2), keywords: "delete", run: () => setRemoving({ list: selected, withFiles: false }) });
		}

		// Actions
		const A = "Actions";
		items.push(
			{ id: "add-file", group: A, label: "Add torrent file…", hint: "⌘O", icon: icon(FilePlus2), keywords: "open import", run: addFiles },
			{ id: "add-magnet", group: A, label: "Add magnet link…", hint: "⌘U", icon: icon(Magnet), keywords: "paste url link", run: () => setMagnetOpen(true) },
			{ id: "create", group: A, label: "Create torrent…", hint: "⌘N", icon: icon(PackagePlus), keywords: "new share make seed", run: () => setCreateOpen(true) },
			{
				id: "slow-tide",
				group: A,
				label: tide?.on ? "Switch slow tide off" : "Switch slow tide on",
				hint: "⌥⌘T",
				icon: icon(Waves),
				keywords: "speed limit alternative turtle throttle bandwidth",
				run: () => actions.setSlowTide(!tide?.on),
			},
			{ id: "pause-all", group: A, label: "Pause all", hint: "⌥⌘P", icon: icon(Pause), keywords: "stop everything", run: () => actions.pause(hashes(torrents)) },
			{ id: "resume-all", group: A, label: "Resume all", hint: "⌥⌘R", icon: icon(Play), keywords: "start everything", run: () => actions.resume(hashes(torrents.filter((t) => !isPausable(t)))) },
			{ id: "settings", group: A, label: "Settings", hint: "⌘,", icon: icon(SettingsIcon), keywords: "preferences options", run: () => setView("settings") },
			{ id: "vpn", group: A, label: "Lock connections to a VPN…", icon: icon(Lock), keywords: "killswitch interface bind privacy", run: () => openSettings({ id: "bindInterface" }) },
		);

		// Filters
		for (const f of FILTERS) {
			const count = torrents.filter(f.test).length;
			if (f.hideWhenEmpty && !count) continue;
			items.push({ id: `filter-${f.id}`, group: "Show", label: `Show ${f.label.toLowerCase()}`, hint: String(count), icon: icon(ListFilter), keywords: "filter view list", run: () => (setView("list"), setFilter(f.id)) });
		}

		// Every torrent, to jump to
		for (const t of torrents) {
			items.push({ id: `t-${t.hash}`, group: "Torrents", label: t.name, hint: `${STATE_LABELS[t.state]}${t.hasMetadata ? ` · ${formatPercent(t.progress)}` : ""}`, icon: icon(ArrowRight), keywords: t.hash, run: () => showTorrent(t.hash) });
		}

		// Every setting, once something is typed
		for (const e of SETTINGS_INDEX) {
			items.push({ id: `setting-${e.id}`, group: "Settings", label: e.label, hint: `Settings · ${e.section}`, icon: icon(SlidersHorizontal), keywords: `${e.section} ${e.keywords ?? ""}`, searchOnly: true, run: () => openSettings({ id: e.id }) });
		}
		return items;
	}, [selected, canPause, canResume, torrents, tide, addFiles, showTorrent, openSettings]);

	/** What's typed, as a filter for the list. */
	const paletteQueryItems = useCallback(
		(q: string): PaletteItem[] => [
			{ id: "q-filter", group: "Search", label: `Filter the list by “${q}”`, icon: <Search size={15} strokeWidth={1.5} />, run: () => (setView("list"), setQuery(q)) },
		],
		[],
	);

	// ---------- Render ---------- //

	const showDrawer = view === "list" && focused !== null && openHash === focused.hash;
	return (
		<MotionConfig reducedMotion="user">
			<div className="app">
				<Sidebar
					torrents={torrents}
					filter={filter}
					view={view}
					onFilter={(id) => {
						setFilter(id);
						setView("list");
					}}
					onSettings={() => setView("settings")}
				/>
				<main className="main">
					{view === "list" ? (
						<>
							<Toolbar
								query={query}
								onQuery={setQuery}
								onSearch={() => setPaletteOpen(true)}
								onAddFile={addFiles}
								onAddMagnet={() => setMagnetOpen(true)}
								onCreate={() => setCreateOpen(true)}
								canPause={canPause}
								canResume={canResume}
								canRemove={selected.length > 0}
								onPause={() => actions.pause(hashes(selected.filter(isPausable)))}
								onResume={() => actions.resume(hashes(selected.filter((t) => !isPausable(t))))}
								onRemove={() => setRemoving({ list: selected, withFiles: false })}
								canRecheck={selected.some((t) => t.hasMetadata)}
								onRecheck={() => actions.recheck(hashes(selected.filter((t) => t.hasMetadata)))}
								selectedCount={selected.length}
							/>
							<div className="main__content">
								<TorrentList
									torrents={visible}
									filtered={torrents.length > 0}
									filter={filter}
									query={query}
									onShowAll={() => setFilter("all")}
									onClearQuery={() => setQuery("")}
									sort={sort}
									reversed={reversed}
									onSort={(id) => {
										if (id === sort) setReversed(!reversed);
										else {
											setSort(id);
											setReversed(false);
										}
									}}
									selection={selection}
									onSelect={onSelect}
									onClearSelection={() => setSelection(new Set())}
									onOpen={actions.open}
									onMenu={openMenu}
									onChooseFiles={setChoosing}
									onAddFile={addFiles}
									onAddMagnet={() => setMagnetOpen(true)}
									detailHash={showDrawer ? focused.hash : null}
									detail={showDrawer ? <DetailsDrawer key={focused.hash} torrent={focused} onClose={() => setOpenHash(null)} /> : null}
								/>
							</div>
						</>
					) : (
						<>
							<header className={`toolbar ${DRAG}`}>
								<div className={NO_DRAG}>
									<Button variant="ghost" icon={<ArrowLeft size={15} strokeWidth={1.5} />} onClick={() => setView("list")}>
										Torrents
									</Button>
								</div>
								<div className="toolbar__spacer" />
								<SearchTrigger onSearch={() => setPaletteOpen(true)} />
							</header>
							<SettingsView reveal={settingsReveal} />
						</>
					)}
					<StatusBar onShowTorrent={showTorrent} />
				</main>

				<AddDialog queue={addQueue} onDone={doneWithSource} onAdded={onAdded} />
				<MagnetDialog open={magnetOpen} onClose={() => setMagnetOpen(false)} onSources={addMagnets} />
				<CreateDialog open={createOpen} onClose={() => setCreateOpen(false)} />
				<RemoveDialog torrents={removing.list} withFiles={removing.withFiles} onClose={() => setRemoving({ list: [], withFiles: false })} />
				<ChooseFilesDialog torrent={choosing} onClose={() => setChoosing(null)} />
				<Menu at={menu?.at ?? null} items={menu?.items ?? []} onClose={() => setMenu(null)} />
				<CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} items={paletteItems} queryItems={paletteQueryItems} initialQuery={view === "list" ? query : ""} />
				<DropOverlay onSources={enqueue} />
				<ToastHost />
			</div>
		</MotionConfig>
	);
}
