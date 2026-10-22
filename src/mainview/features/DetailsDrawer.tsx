import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowDown, ArrowUp, Check, Copy, FolderOpen, Plus, X } from "lucide-react";
import type { Details, PeerInfo, TorrentSummary } from "../../shared/types";
import { formatBytes, formatDate, formatDuration, formatPercent, formatRate, formatRatio, parseRate } from "../../shared/format";
import { EASE_IN_OUT, EASE_OUT, remaining } from "../lib/constants";
import { useReducedMotion, useTween } from "../lib/hooks";
import { actions, joinPath } from "../lib/actions";
import { call } from "../lib/bridge";
import { Button, IconButton } from "../components/Button";
import { TextField } from "../components/Fields";
import { Tabs } from "../components/Tabs";
import { toastError } from "../components/Toasts";
import { FileTree } from "./FileTree";
import { PieceMap } from "./PieceMap";
import { PieceRibbon } from "./PieceRibbon";
import { SwarmView } from "./SwarmView";

type TabId = "overview" | "files" | "peers" | "swarm" | "trackers" | "pieces";

/** The unfolded panel's height under its row. */
const DRAWER_HEIGHT = 340;

/** How often the open drawer refreshes its details. */
const REFRESH_MS = 1000;

// ---------- Overview ---------- //

/** One labelled figure. */
function Stat({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="stat">
			<dt className="stat__label">{label}</dt>
			<dd className="stat__value">{children}</dd>
		</div>
	);
}

/** A rate limit field that saves on blur or Enter. Empty means unlimited. */
function LimitField({ name, icon, value, onSave }: { name: string; icon: ReactNode; value: number; onSave: (bytesPerSecond: number) => void }) {
	const [text, setText] = useState(value ? formatRate(value).replace("/s", "") : "");
	const [error, setError] = useState<string | null>(null);
	useEffect(() => setText(value ? formatRate(value).replace("/s", "") : ""), [value]);
	const commit = () => {
		const parsed = parseRate(text);
		if (parsed === null) return setError("Try 5 MB or 800 kB.");
		setError(null);
		if (parsed !== value) onSave(parsed);
	};
	return (
		<label className={`limit ${value ? "is-set" : ""} ${error ? "has-error" : ""}`} data-tip={error ?? name}>
			<span className="limit__label">{icon}</span>
			<input className="limit__input" aria-label={name} value={text} onChange={(e) => setText(e.target.value)} placeholder="No limit" spellCheck={false} autoComplete="off" onBlur={commit} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
			<span className="limit__unit">/s</span>
		</label>
	);
}

/** Uploaded over downloaded on a scale to 2, with 1.0 (given back what you took) marked. */
function RatioMeter({ ratio }: { ratio: number }) {
	const fill = Math.min(1, ratio / 2);
	return (
		<div className="ratio" data-tip={ratio >= 1 ? "You've given back at least what you took." : "Seeding to 1.0 gives back what you took."}>
			<span className="ratio__value">{formatRatio(ratio)}</span>
			<span className="ratio__track" aria-hidden="true">
				<motion.span className="ratio__fill" initial={false} animate={{ scaleX: fill }} transition={{ duration: 0.6, ease: EASE_OUT }} />
				<span className="ratio__even" />
			</span>
		</div>
	);
}

/** A button that copies, and says so in place for a moment. */
function CopyButton({ label, onCopy }: { label: string; onCopy: () => Promise<unknown> | void }) {
	const [done, setDone] = useState(false);
	useEffect(() => {
		if (!done) return;
		const timer = setTimeout(() => setDone(false), 1600);
		return () => clearTimeout(timer);
	}, [done]);
	return (
		<button className={`copy-chip ${done ? "is-done" : ""}`} onClick={() => Promise.resolve(onCopy()).then(() => setDone(true))}>
			<AnimatePresence mode="popLayout" initial={false}>
				<motion.span key={done ? "done" : "copy"} className="copy-chip__icon" initial={{ y: 10, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -10, opacity: 0 }} transition={{ duration: 0.2, ease: EASE_OUT }}>
					{done ? <Check size={13} strokeWidth={2} /> : <Copy size={13} strokeWidth={1.5} />}
				</motion.span>
			</AnimatePresence>
			{done ? "Copied" : label}
		</button>
	);
}

/** "16:59" today, "12 Oct, 09:30" this year, the full date before that. */
function formatMoment(ms: number): string {
	const d = new Date(ms);
	const now = new Date();
	if (d.toDateString() === now.toDateString()) return `Today, ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
	return d.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(d.getFullYear() === now.getFullYear() ? { hour: "2-digit", minute: "2-digit" } : { year: "numeric" }) });
}

/** Milestones in the torrent's life, reached ones filled. */
function Timeline({ t }: { t: TorrentSummary }) {
	const steps: { label: string; value: string; reached: boolean }[] = [
		{ label: "Added", value: formatMoment(t.addedAt), reached: true },
		{ label: "Completed", value: t.completedAt ? formatMoment(t.completedAt) : t.state === "downloading" ? `In ${formatDuration(remaining(t))}` : "Not yet", reached: !!t.completedAt },
		{ label: "Seeding for", value: t.seedSeconds ? formatDuration(t.seedSeconds) : "Not yet", reached: t.seedSeconds > 0 },
	];
	return (
		<ol className="timeline">
			{steps.map((s) => (
				<li key={s.label} className={`timeline__step ${s.reached ? "is-reached" : ""}`} data-tip={s.label === "Added" ? formatDate(t.addedAt) : s.label === "Completed" && t.completedAt ? formatDate(t.completedAt) : undefined}>
					<span className="timeline__dot" aria-hidden="true" />
					<span className="timeline__label">{s.label}</span>
					<span className="timeline__value">{s.value}</span>
				</li>
			))}
		</ol>
	);
}

/** The folder a torrent is saved in: its own name large, the way there small. */
function Location({ t }: { t: TorrentSummary }) {
	const parts = t.dir.split("/").filter(Boolean);
	const leaf = parts.pop() ?? t.dir;
	return (
		<button className="location" onClick={() => actions.reveal(t)} data-tip={`Show in Finder: ${t.dir}`}>
			<FolderOpen size={16} strokeWidth={1.5} className="location__icon" />
			<span className="location__text">
				<span className="location__leaf ellipsis">{leaf}</span>
				<span className="location__trail" dir="rtl">
					<bdi>/{parts.join("/")}</bdi>
				</span>
			</span>
		</button>
	);
}

function Overview({ t, d, onTab }: { t: TorrentSummary; d: Details | null; onTab: (tab: TabId) => void }) {
	const left = t.size - t.done;
	const setLimit = (download: number, upload: number) => call("setLimits", { hash: t.hash, download, upload }).catch(toastError);
	const progress = useTween(t.hasMetadata ? t.progress : 0, 600);
	const wasted = d ? (d.wasted ?? 0) : 0;
	return (
		<div className="overview">
			<section className={`ov-progress tone--${t.state}`}>
				<div className="ov-progress__figure">
					<span className="ov-progress__pct">{t.hasMetadata ? formatPercent(progress) : "—"}</span>
					<span className="ov-progress__of">
						{t.hasMetadata ? (
							<>
								{formatBytes(t.done)} of {formatBytes(t.size)}
								<span className="muted">{left > 0 ? ` · ${formatBytes(left)} to go` : " · complete"}</span>
								{t.size !== t.totalSize && <span className="muted"> · {formatBytes(t.totalSize - t.size)} left out</span>}
							</>
						) : (
							<span className="muted">Waiting for the file list from peers</span>
						)}
					</span>
				</div>
				{t.hasMetadata && d?.pieceCount ? <PieceRibbon bits={d.pieces} count={d.pieceCount} files={d.files} onOpenFiles={() => onTab("files")} /> : <div className="ribbon ribbon--empty" />}
			</section>

			<section className="ov-facts">
				<dl className="ov-transfer">
					<Stat label="Received">{formatBytes(t.downloaded)}</Stat>
					<Stat label="Sent">{formatBytes(t.uploaded)}</Stat>
					<Stat label="Ratio">
						<RatioMeter ratio={t.ratio} />
					</Stat>
				</dl>
				<Timeline t={t} />
				{wasted > 0 && (
					<button className="ov-wasted" onClick={() => onTab("pieces")} data-tip="Pieces that failed their check were thrown away and fetched again.">
						{formatBytes(wasted)} discarded · {d?.hashFailures ?? 0} failed {d?.hashFailures === 1 ? "piece" : "pieces"}
					</button>
				)}
			</section>

			<aside className="ov-side">
				<Location t={t} />
				<div className="ov-limits">
					<LimitField name="Download limit" icon={<ArrowDown size={13} strokeWidth={2} />} value={t.downloadLimit ?? 0} onSave={(v) => setLimit(v, t.uploadLimit ?? 0)} />
					<LimitField name="Upload limit" icon={<ArrowUp size={13} strokeWidth={2} />} value={t.uploadLimit ?? 0} onSave={(v) => setLimit(t.downloadLimit ?? 0, v)} />
				</div>
				<div className="ov-copy">
					<CopyButton label="Magnet link" onCopy={() => actions.copyMagnet(t.hash)} />
					<CopyButton label="Info hash" onCopy={() => actions.copyHash(t.hash)} />
				</div>
			</aside>

			{d && d.warnings.length > 0 && (
				<div className="overview__log">
					<h3 className="drawer__subhead">Recent warnings</h3>
					{d.warnings
						.slice(-4)
						.reverse()
						.map((w) => (
							<p key={w.at + w.message} className="overview__warning">
								<span className="muted">{new Date(w.at).toLocaleTimeString()}</span> {w.message}
							</p>
						))}
				</div>
			)}
		</div>
	);
}

// ---------- Files ---------- //

function Files({ t, d }: { t: TorrentSummary; d: Details | null }) {
	const files = d?.files ?? [];
	const selected = useMemo(() => new Set(files.filter((f) => f.selected).map((f) => f.index)), [files]);
	if (!t.hasMetadata) return <p className="drawer__empty">The file list arrives from peers. It will appear here.</p>;
	if (!d) return null;
	return (
		<FileTree
			files={files}
			selected={selected}
			showProgress
			onChange={(next) => {
				if (next.size === 0) return toastError(new Error("Keep at least one file selected. To stop this torrent, pause it."));
				call("select", { hash: t.hash, files: [...next].sort((a, b) => a - b) }).catch(toastError);
			}}
			onOpenFile={(f) => call("openPath", { path: joinPath(t.dir, f.path) })}
		/>
	);
}

// ---------- Peers ---------- //

/** Short flags in the style of other clients, spelled out in the tooltip. */
function peerFlags(p: PeerInfo): { short: string; long: string } {
	const f: [boolean, string, string][] = [
		[p.seed, "S", "seed"],
		[p.encrypted, "E", "encrypted"],
		[!p.outgoing, "I", "incoming"],
		[!p.peerChoking, "D", "sending to us"],
		[!p.amChoking, "U", "we're sending"],
		[p.interested, "i", "wants our pieces"],
	];
	const on = f.filter(([b]) => b);
	return { short: on.map(([, s]) => s).join(""), long: on.map(([, , l]) => l).join(", ") };
}

function Peers({ t, d }: { t: TorrentSummary; d: Details | null }) {
	const [address, setAddress] = useState("");
	const peers = [...(d?.peers ?? [])].sort((a, b) => b.downRate + b.upRate - (a.downRate + a.upRate));
	const add = () => {
		if (!address.trim()) return;
		call("addPeer", { hash: t.hash, address: address.trim() })
			.then(() => setAddress(""))
			.catch(toastError);
	};
	return (
		<div className="peers">
			<table className="table" data-ui>
				<thead>
					<tr>
						<th>Address</th>
						<th>Client</th>
						<th className="num">Down</th>
						<th className="num">Up</th>
						<th className="num">Received</th>
						<th className="num">Sent</th>
						<th className="num">Round trip</th>
						<th>Flags</th>
						<th>From</th>
					</tr>
				</thead>
				<tbody>
					{peers.map((p) => {
						const flags = peerFlags(p);
						return (
							<tr key={p.address}>
								<td className="selectable">{p.address}</td>
								<td className="ellipsis">{p.client || "Unknown"}</td>
								<td className="num">{p.downRate ? formatRate(p.downRate) : ""}</td>
								<td className="num">{p.upRate ? formatRate(p.upRate) : ""}</td>
								<td className="num">{formatBytes(p.downloaded)}</td>
								<td className="num">{formatBytes(p.uploaded)}</td>
								<td className="num">{p.rttMs ? `${p.rttMs} ms` : ""}</td>
								<td data-tip={flags.long}>{flags.short}</td>
								<td>{p.source === "dht" ? "DHT" : p.source === "pex" ? "PEX" : p.source[0]!.toUpperCase() + p.source.slice(1)}</td>
							</tr>
						);
					})}
				</tbody>
			</table>
			{peers.length === 0 && <p className="drawer__empty">{t.state === "paused" ? "Paused: no connections." : `No peers connected yet${d?.candidates ? `; ${d.candidates} known` : ""}.`}</p>}
			<div className="peers__add">
				<TextField value={address} onChange={setAddress} placeholder="Add a peer: 203.0.113.5:6881" onKeyDown={(e) => e.key === "Enter" && add()} />
				<Button icon={<Plus size={14} strokeWidth={1.5} />} onClick={add} disabled={!address.trim()}>
					Add peer
				</Button>
			</div>
		</div>
	);
}

// ---------- Swarm ---------- //

function Swarm({ t, d }: { t: TorrentSummary; d: Details | null }) {
	if (t.state === "paused" || t.state === "queued" || t.state === "offline") return <p className="drawer__empty">{t.state === "offline" ? "Waiting for the VPN: no connections." : "Not running: no connections."} The swarm appears when it starts.</p>;
	return <SwarmView peers={d?.peers ?? []} caption={`↓ ${formatRate(t.downRate)} · ↑ ${formatRate(t.upRate)}`} />;
}

// ---------- Trackers ---------- //

function Trackers({ d }: { d: Details | null }) {
	const trackers = d?.trackers ?? [];
	const webSeeds = d?.webSeeds ?? [];
	return (
		<>
			{trackers.length === 0 ? <p className="drawer__empty">No trackers. Peers come from the DHT and peer exchange.</p> : <TrackerTable d={d} />}
			{webSeeds.length > 0 && (
				<>
					<h3 className="drawer__subhead">Web seeds</h3>
					<table className="table" data-ui>
						<thead>
							<tr>
								<th>Mirror</th>
								<th>Status</th>
								<th className="num">Speed</th>
								<th className="num">Downloaded</th>
							</tr>
						</thead>
						<tbody>
							{webSeeds.map((w) => (
								<tr key={w.url}>
									<td className="ellipsis selectable" data-tip={w.url}>
										{w.url}
									</td>
									<td className={w.error ? "is-error ellipsis" : "ellipsis"} data-tip={w.error ?? undefined}>
										{w.error ? w.error : w.active ? "Downloading" : "Standing by"}
									</td>
									<td className="num">{w.active ? formatRate(w.downRate) : "—"}</td>
									<td className="num">{formatBytes(w.downloaded)}</td>
								</tr>
							))}
						</tbody>
					</table>
				</>
			)}
		</>
	);
}

function TrackerTable({ d }: { d: Details | null }) {
	const trackers = d?.trackers ?? [];
	return (
		<table className="table" data-ui>
			<thead>
				<tr>
					<th>Tracker</th>
					<th>Status</th>
					<th className="num">Peers</th>
					<th className="num">Seeders</th>
					<th className="num">Leechers</th>
					<th className="num">Every</th>
				</tr>
			</thead>
			<tbody>
				{trackers.map((tr) => (
					<tr key={tr.url}>
						<td className="ellipsis selectable" data-tip={tr.url}>
							{tr.url}
						</td>
						<td className={tr.error ? "is-error ellipsis" : "ellipsis"} data-tip={tr.error ?? undefined}>
							{tr.error ? tr.error : tr.interval ? "Working" : tr.failures ? `Retrying (${tr.failures})` : "Contacting"}
						</td>
						<td className="num">{tr.peers}</td>
						<td className="num">{tr.seeders ?? "—"}</td>
						<td className="num">{tr.leechers ?? "—"}</td>
						<td className="num">{tr.interval ? formatDuration(tr.interval) : "—"}</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

// ---------- Pieces ---------- //

function Pieces({ t, d }: { t: TorrentSummary; d: Details | null }) {
	if (!t.hasMetadata || !d?.pieceCount) return <p className="drawer__empty">Pieces appear once the file list is known.</p>;
	return (
		<div className="pieces">
			<PieceMap bits={d.pieces} count={d.pieceCount} />
			<dl className="pieces__stats">
				<Stat label="Verified">{`${d.piecesHave ?? 0} of ${d.pieceCount}`}</Stat>
				<Stat label="Piece size">{formatBytes(d.pieceLength ?? 0)}</Stat>
				<Stat label="In progress">{d.activePieces ?? 0}</Stat>
				<Stat label="Endgame">{d.endgame ? "Yes: the last blocks are asked of several peers" : "No"}</Stat>
			</dl>
		</div>
	);
}

// ---------- Drawer ---------- //

interface DetailsDrawerProps {
	torrent: TorrentSummary;
	onClose: () => void;
}

/** The details of one torrent, unfolded beneath its row in the list. */
export function DetailsDrawer({ torrent, onClose }: DetailsDrawerProps) {
	const [tab, setTab] = useState<TabId>("overview");
	const [details, setDetails] = useState<Details | null>(null);

	// Refresh while open; a new torrent starts blank
	useEffect(() => {
		let alive = true;
		setDetails(null);
		const load = () =>
			call("details", { hash: torrent.hash })
				.then((d) => alive && setDetails(d))
				.catch(() => {});
		load();
		const timer = setInterval(load, REFRESH_MS);
		return () => {
			alive = false;
			clearInterval(timer);
		};
	}, [torrent.hash]);

	// Tabs are listed left to right; the body slides the way you moved
	const tabs: { id: TabId; label: string; count?: number }[] = [
		{ id: "overview", label: "Overview" },
		{ id: "files", label: "Files", count: torrent.fileCount || undefined },
		{ id: "peers", label: "Peers" },
		{ id: "swarm", label: "Swarm" },
		{ id: "trackers", label: "Trackers", count: (details?.trackers.length ?? 0) + (details?.webSeeds?.length ?? 0) || undefined },
		{ id: "pieces", label: "Pieces" },
	];
	const reduced = useReducedMotion();
	const order = (id: TabId) => tabs.findIndex((x) => x.id === id);
	const direction = useRef(0);
	const go = (next: TabId) => {
		direction.current = Math.sign(order(next) - order(tab));
		setTab(next);
	};
	const slide = reduced ? 0 : direction.current * 24;

	return (
		<motion.section
			className="drawer"
			aria-label={`Details of ${torrent.name}`}
			initial={{ height: 0 }}
			animate={{ height: DRAWER_HEIGHT, transition: { duration: 0.45, ease: EASE_OUT } }}
			exit={{ height: 0, transition: { duration: 0.32, ease: EASE_IN_OUT } }}
		>
			<motion.header className="drawer__head" initial={reduced ? false : { opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0, transition: { duration: 0.35, ease: EASE_OUT, delay: 0.12 } }}>
				<Tabs tabs={tabs} value={tab} onChange={go} layoutId="drawer-tab" />
				<IconButton label="Close details" onClick={onClose}>
					<X size={16} strokeWidth={1.5} />
				</IconButton>
			</motion.header>
			<div className="drawer__viewport">
				<motion.div key={tab} className="drawer__body" initial={{ opacity: 0, x: slide }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.28, ease: EASE_OUT }}>
					{tab === "overview" && <Overview t={torrent} d={details} onTab={go} />}
					{tab === "files" && <Files t={torrent} d={details} />}
					{tab === "peers" && <Peers t={torrent} d={details} />}
					{tab === "swarm" && <Swarm t={torrent} d={details} />}
					{tab === "trackers" && <Trackers d={details} />}
					{tab === "pieces" && <Pieces t={torrent} d={details} />}
				</motion.div>
			</div>
		</motion.section>
	);
}
