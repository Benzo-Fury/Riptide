import { useCallback, useEffect, useMemo, useState } from "react";
import { FolderOpen } from "lucide-react";
import type { InspectResult, TorrentSource, TorrentSummary } from "../../shared/types";
import { formatBytes } from "../../shared/format";
import { call } from "../lib/bridge";
import { useSettings } from "../lib/store";
import { Button } from "../components/Button";
import { Dialog } from "../components/Dialog";
import { TextField, Toggle } from "../components/Fields";
import { toast, toastError } from "../components/Toasts";
import { FileTree, selectedSize } from "./FileTree";

// ---------- Magnet prompt ---------- //

/** Pulls every magnet link out of pasted text (one per line, or run together). */
export function magnetsIn(text: string): string[] {
	return [...text.matchAll(/magnet:\?[^\s"'<>]+/gi)].map((m) => m[0]);
}

interface MagnetDialogProps {
	open: boolean;
	onClose: () => void;
	/** One link goes to the add dialog; several are added straight away. */
	onSources: (sources: TorrentSource[]) => void;
}

/** Asks for magnet links, prefilled from the clipboard when it holds one. */
export function MagnetDialog({ open, onClose, onSources }: MagnetDialogProps) {
	const [text, setText] = useState("");
	const links = magnetsIn(text);

	// Offer what's on the clipboard
	useEffect(() => {
		if (!open) return;
		setText("");
		call("readClipboard")
			.then((clip) => clip && magnetsIn(clip).length > 0 && setText(magnetsIn(clip).join("\n")))
			.catch(() => {});
	}, [open]);

	const submit = () => {
		if (links.length === 0) return;
		onSources(links.map((uri) => ({ kind: "magnet", uri })));
		onClose();
	};

	return (
		<Dialog
			open={open}
			title="Add magnet link"
			onClose={onClose}
			width={560}
			footer={
				<>
					<Button onClick={onClose}>Cancel</Button>
					<Button variant="primary" onClick={submit} disabled={links.length === 0}>
						{links.length > 1 ? `Add ${links.length} links` : "Continue"}
					</Button>
				</>
			}
		>
			<TextField
				label="Magnet links, one per line"
				multiline
				rows={4}
				value={text}
				onChange={setText}
				placeholder="magnet:?xt=urn:btih:…"
				data-autofocus
				error={text.trim() && links.length === 0 ? "That doesn't look like a magnet link. They start with magnet:?" : null}
				onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && submit()}
			/>
		</Dialog>
	);
}

// ---------- Add dialog ---------- //

interface AddDialogProps {
	/** Sources waiting to be added, shown one at a time. */
	queue: TorrentSource[];
	onDone: (source: TorrentSource) => void;
	onAdded: (hash: string) => void;
}

/** A source's display name before it's inspected. */
function sourceLabel(s: TorrentSource): string {
	if (s.kind === "file") return s.path.split("/").pop() ?? s.path;
	if (s.kind === "bytes") return s.fileName ?? "Dropped torrent";
	return "Magnet link";
}

/**
 * Shows one torrent before it's added: its files to choose from, where to save it, and whether
 * to start paused. For a magnet, whose files aren't known yet, it offers to wait for them.
 */
export function AddDialog({ queue, onDone, onAdded }: AddDialogProps) {
	const settings = useSettings();
	const source = queue[0] ?? null;
	const [info, setInfo] = useState<InspectResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [selected, setSelected] = useState<Set<number>>(new Set());
	const [dir, setDir] = useState("");
	const [paused, setPaused] = useState(false);
	const [chooseLater, setChooseLater] = useState(false);
	const [busy, setBusy] = useState(false);

	// Read each source as it reaches the front of the queue
	useEffect(() => {
		if (!source) return;
		let alive = true;
		setInfo(null);
		setError(null);
		setBusy(false);
		// Each torrent starts from the defaults; only the save folder carries over
		setPaused(false);
		setChooseLater(false);
		call("inspect", { source })
			.then((r) => {
				if (!alive) return;
				setInfo(r);
				setSelected(new Set(r.files.map((f) => f.index)));
			})
			.catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
		return () => {
			alive = false;
		};
	}, [source]);

	// The save folder starts at the default from settings
	useEffect(() => {
		if (source && settings) setDir((d) => d || settings.downloadDir);
	}, [source, settings]);

	const close = useCallback(() => source && onDone(source), [source, onDone]);

	const add = async () => {
		if (!source || !info) return;
		setBusy(true);
		try {
			const all = selected.size === info.files.length;
			const r = await call("add", { source, dir, paused, files: info.isMagnet || all ? undefined : [...selected].sort((a, b) => a - b), metadataOnly: info.isMagnet && chooseLater });
			if (r.existing) toast(`${r.name} is already in your list.`);
			else onAdded(r.hash);
			if (r.queued) toast(`${r.name} is queued: other downloads are using every slot.`);
			onDone(source);
		} catch (e) {
			setBusy(false);
			toastError(e);
		}
	};

	const chooseDir = async () => {
		const picked = await call("pickFolder", { start: dir }).catch(() => null);
		if (picked) setDir(picked);
	};

	const size = useMemo(() => (info ? selectedSize(info.files, selected) : 0), [info, selected]);
	const remaining = queue.length - 1;
	const title = info?.name ?? (source ? sourceLabel(source) : "");

	return (
		<Dialog
			open={source !== null}
			title={remaining > 0 ? `Add torrent · ${remaining} more after this` : "Add torrent"}
			onClose={close}
			width={640}
			footerNote={info?.alreadyAdded ? "Already in your list." : info && !info.isMagnet ? `${formatBytes(size)} of ${formatBytes(info.size ?? 0)} selected` : null}
			footer={
				<>
					<Button onClick={close}>{remaining > 0 ? "Skip" : "Cancel"}</Button>
					<Button variant="primary" onClick={add} disabled={!info || busy || info.alreadyAdded || (!info.isMagnet && selected.size === 0) || !dir.trim()}>
						{busy ? "Adding…" : paused ? "Add paused" : "Add and start"}
					</Button>
				</>
			}
		>
			<div className="add">
				<h3 className="add__name selectable">{title}</h3>
				{error && <p className="add__error">{error}</p>}
				{!error && !info && <p className="muted">Reading…</p>}
				{info && (
					<>
						<p className="add__meta muted">
							{info.isMagnet
								? `Magnet link · ${info.trackers.length} ${info.trackers.length === 1 ? "tracker" : "trackers"}`
								: `${formatBytes(info.size ?? 0)} · ${info.files.length} ${info.files.length === 1 ? "file" : "files"}${info.private ? " · private" : ""}`}
						</p>
						{info.isMagnet ? (
							<Toggle label="Choose files when the list arrives" description="Nothing downloads until you pick. Otherwise every file starts." checked={chooseLater} onChange={setChooseLater} />
						) : (
							info.files.length > 1 && (
								<div className="add__files">
									<div className="add__files-head">
										<span>Files</span>
										<span className="add__bulk">
											<button className="link" onClick={() => setSelected(new Set(info.files.map((f) => f.index)))}>
												All
											</button>
											<button className="link" onClick={() => setSelected(new Set())}>
												None
											</button>
										</span>
									</div>
									<FileTree files={info.files} selected={selected} onChange={setSelected} />
								</div>
							)
						)}
						<TextField
							label="Save to"
							value={dir}
							onChange={setDir}
							suffix={
								<Button variant="ghost" icon={<FolderOpen size={14} strokeWidth={1.5} />} onClick={chooseDir}>
									Choose
								</Button>
							}
						/>
						<Toggle label="Start paused" checked={paused} onChange={setPaused} />
					</>
				)}
			</div>
		</Dialog>
	);
}

// ---------- Choose files later ---------- //

interface ChooseFilesDialogProps {
	torrent: TorrentSummary | null;
	onClose: () => void;
}

/** Picks the files of a torrent that waited for its list (`waiting`), then starts it. */
export function ChooseFilesDialog({ torrent, onClose }: ChooseFilesDialogProps) {
	const [files, setFiles] = useState<{ index: number; path: string; length: number }[]>([]);
	const [selected, setSelected] = useState<Set<number>>(new Set());

	useEffect(() => {
		if (!torrent) return;
		call("details", { hash: torrent.hash })
			.then((d) => {
				setFiles(d.files);
				setSelected(new Set(d.files.map((f) => f.index)));
			})
			.catch(toastError);
	}, [torrent]);

	const start = () => {
		if (!torrent) return;
		call("select", { hash: torrent.hash, files: [...selected].sort((a, b) => a - b) })
			.then(onClose)
			.catch(toastError);
	};

	return (
		<Dialog
			open={torrent !== null}
			title="Choose files"
			onClose={onClose}
			width={640}
			footerNote={`${formatBytes(selectedSize(files, selected))} selected`}
			footer={
				<>
					<Button onClick={onClose}>Later</Button>
					<Button variant="primary" onClick={start} disabled={selected.size === 0}>
						Start download
					</Button>
				</>
			}
		>
			<div className="add">
				<h3 className="add__name">{torrent?.name}</h3>
				<div className="add__files">
					<FileTree files={files} selected={selected} onChange={setSelected} />
				</div>
			</div>
		</Dialog>
	);
}
