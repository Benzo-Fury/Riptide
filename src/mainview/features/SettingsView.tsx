import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { FolderOpen, RefreshCw } from "lucide-react";
import type { DefaultApp, EncryptionMode, NetworkInterface, Settings } from "../../shared/types";
import { formatBytes, formatWhen, parseRate } from "../../shared/format";
import { EASE_OUT } from "../lib/constants";
import { call } from "../lib/bridge";
import { getState, loadSettings, setSettings, useAppInfo, useEngine, useEngineStatus, useLock, useSettings, useSlowTide } from "../lib/store";
import { Button } from "../components/Button";
import { Loader } from "../components/Loader";
import { Select, TextField, Toggle } from "../components/Fields";
import { toast, toastError } from "../components/Toasts";
import { WeekGrid } from "../components/WeekGrid";
import { TideLines } from "./TideLines";

/** Settings whose change rebuilds the engine (mirrors undercurrentd's `needs_restart`). */
const RESTART_KEYS: (keyof Settings)[] = ["port", "acceptIncoming", "encryption", "dht", "pex", "portMapping", "uploadSlots", "maxPeers", "maxHalfOpen", "maxBufferBytes", "webSeeds", "seedEnabled", "seedRatio", "seedMinutes", "threads", "bindInterface"];

/** Slow tide's switch by hand: set from the status bar and tray, never by this form's draft. */
const TIDE_SWITCH_KEYS = ["slowTide", "slowOverride", "slowOverrideUntil"] as const;

/** The hour of the week now, Monday 00:00 = 0, as the schedule counts. */
const hourOfWeek = (d = new Date()) => ((d.getDay() + 6) % 7) * 24 + d.getHours();

const ENCRYPTION_OPTIONS: { value: EncryptionMode; label: string }[] = [
	{ value: "prefer", label: "Prefer encryption" },
	{ value: "plaintext", label: "Prefer plaintext (fastest; use inside a VPN)" },
	{ value: "require", label: "Require encryption" },
	{ value: "off", label: "Never encrypt" },
];

const MB = 1024 * 1024;

/** One setting, found by the palette through its id (see `settingsIndex`). */
function Setting({ id, children }: { id: string; children: ReactNode }) {
	return (
		<div className="setting" data-setting={id}>
			{children}
		</div>
	);
}

/** A titled group of settings. */
function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="settings__section">
			<h2 className="settings__heading">{title}</h2>
			<div className="settings__fields">{children}</div>
		</section>
	);
}

/** A whole-number field. */
function NumberField({ label, value, onChange, hint, min = 0, max }: { label: string; value: number; onChange: (n: number) => void; hint?: string; min?: number; max?: number }) {
	const [text, setText] = useState(String(value));
	useEffect(() => setText(String(value)), [value]);
	const n = Number(text);
	const bad = text.trim() === "" || !Number.isFinite(n) || n < min || (max !== undefined && n > max);
	return (
		<TextField
			label={label}
			value={text}
			inputMode="decimal"
			onChange={(t) => {
				setText(t);
				const v = Number(t);
				if (t.trim() !== "" && Number.isFinite(v) && v >= min && (max === undefined || v <= max)) onChange(v);
			}}
			hint={hint}
			error={bad ? `Enter a number${max !== undefined ? ` from ${min} to ${max}` : ` of ${min} or more`}.` : null}
		/>
	);
}

/** A bytes-per-second field that reads "5 MB", "800 kB" or blank for unlimited. */
function RateField({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
	const [text, setText] = useState(value ? formatBytes(value) : "");
	const parsed = parseRate(text);

	// Follow outside changes (discard, save)
	useEffect(() => {
		setText((t) => (parseRate(t) === value ? t : value ? formatBytes(value) : ""));
	}, [value]);
	return (
		<TextField
			label={label}
			value={text}
			placeholder="Unlimited"
			suffix="/s"
			onChange={(t) => {
				setText(t);
				const v = parseRate(t);
				if (v !== null) onChange(v);
			}}
			error={parsed === null ? "Try 5 MB or 800 kB, or leave it empty." : null}
		/>
	);
}

/** Slow tide's limits and schedule. */
function SlowTideFields({ draft, set }: { draft: Settings; set: <K extends keyof Settings>(key: K, value: Settings[K]) => void }) {
	const tide = useSlowTide();
	const state = !tide
		? null
		: tide.on
			? `On${tide.overridden ? " by hand" : tide.scheduled ? " by schedule" : ""}${tide.nextChange && (tide.scheduled || tide.overridden) ? ` until ${formatWhen(tide.nextChange)}` : ""}.`
			: `Off${tide.overridden ? " by hand" : ""}${tide.nextChange && draft.slowSchedule ? `; the schedule switches it on ${formatWhen(tide.nextChange)}` : ""}.`;
	return (
		<>
			<p className="settings__lede">Gentler limits for calls, games and work, so Riptide stays out of the way. Switch it from the status bar, the menu bar icon or with ⌥⌘T. {state && <span className="muted">Right now: {state}</span>}</p>
			<Setting id="slowDownloadLimit">
				<RateField label="Slow download limit" value={draft.slowDownloadLimit} onChange={(v) => set("slowDownloadLimit", v)} />
			</Setting>
			<Setting id="slowUploadLimit">
				<RateField label="Slow upload limit" value={draft.slowUploadLimit} onChange={(v) => set("slowUploadLimit", v)} />
			</Setting>
			<Setting id="slowSchedule">
				<Toggle label="Follow a schedule" description="Paint the hours it's on. Switching it by hand lasts until the schedule's next change." checked={draft.slowSchedule} onChange={(v) => set("slowSchedule", v)} />
				{draft.slowSchedule && (
					<motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0, transition: { duration: 0.3, ease: EASE_OUT } }}>
						<WeekGrid label="Slow tide hours" value={draft.slowHours} onChange={(v) => set("slowHours", v)} onLabel="slow" offLabel="full speed" now={hourOfWeek()} />
					</motion.div>
				)}
			</Setting>
		</>
	);
}

/** The VPN lock: which interface every socket binds to. */
function LockFields({ draft, set }: { draft: Settings; set: <K extends keyof Settings>(key: K, value: Settings[K]) => void }) {
	const lock = useLock();
	const [interfaces, setInterfaces] = useState<NetworkInterface[] | null>(null);
	const refresh = () =>
		call("interfaces")
			.then(setInterfaces)
			.catch(() => setInterfaces([]));
	useEffect(() => void refresh(), []);

	// Any, then tunnels and the rest; a chosen interface that's down is still listed
	const listed = (interfaces ?? []).filter((i) => !i.loopback || i.name === draft.bindInterface);
	const options = [
		{ value: "", label: "Any interface (no lock)" },
		...listed.map((i) => ({ value: i.name, label: `${i.name} · ${i.addresses[0]}${i.vpn ? " · VPN" : ""}` })),
		...(draft.bindInterface && !listed.some((i) => i.name === draft.bindInterface) ? [{ value: draft.bindInterface, label: `${draft.bindInterface} · down` }] : []),
	];
	const vpns = listed.filter((i) => i.vpn).length;
	const status = lock
		? lock.address
			? `Locked to ${lock.interface} (${lock.address}).`
			: `${lock.interface} is down: nothing is connecting.`
		: vpns
			? `${vpns === 1 ? "A VPN interface is" : `${vpns} VPN interfaces are`} up. Choose one to lock to it.`
			: "No VPN interface is up right now.";
	return (
		<>
			<p className="settings__lede">Every peer connection, tracker request and DHT packet goes through the interface you choose. If it drops, transfers stop at once and nothing leaks out another way; they resume when it's back.</p>
			<Setting id="bindInterface">
				<div className="settings__inline">
					<Select label="Lock connections to" value={draft.bindInterface} options={options} onChange={(v) => set("bindInterface", v)} hint={status} />
					<Button variant="ghost" icon={<RefreshCw size={14} strokeWidth={1.5} />} onClick={refresh}>
						Refresh
					</Button>
				</div>
			</Setting>
		</>
	);
}

/** Whether Riptide opens .torrent files and magnet links, with a button to make it so. */
function DefaultAppFields() {
	const [state, setState] = useState<DefaultApp | null>(null);
	const [busy, setBusy] = useState(false);

	// Read on arrival and whenever the window comes back, in case it changed in Finder
	useEffect(() => {
		const refresh = () =>
			call("defaultApp")
				.then(setState)
				.catch(() => setState(null));
		void refresh();
		window.addEventListener("focus", refresh);
		return () => window.removeEventListener("focus", refresh);
	}, []);

	const makeDefault = async () => {
		setBusy(true);
		try {
			const next = await call("makeDefaultApp");
			setState(next);
			if (next.torrents && next.magnets) toast("Riptide now opens torrent files and magnet links.", "success");
		} catch (e) {
			toastError(e);
		} finally {
			setBusy(false);
		}
	};

	if (!state) return null;
	if (!state.supported) return <p className="settings__lede muted">Choose Riptide in Finder: Get Info on a .torrent file, pick it under Open with, then Change All.</p>;
	const status =
		state.torrents && state.magnets
			? "Riptide opens torrent files and magnet links."
			: state.torrents
				? "Riptide opens torrent files. Another app opens magnet links."
				: state.magnets
					? "Riptide opens magnet links. Another app opens torrent files."
					: "Another app opens torrent files and magnet links.";
	return (
		<>
			<p className="settings__lede">{status}</p>
			{!(state.torrents && state.magnets) && (
				<div>
					<Button variant="primary" onClick={makeDefault} disabled={busy}>
						Make Riptide the default
					</Button>
				</div>
			)}
		</>
	);
}

/**
 * Stands in for the form until settings arrive. They're fetched again on arrival here, in case
 * the startup load gave up, with a way to try once more if this attempt fails too.
 */
function SettingsWait() {
	const status = useEngineStatus();
	const [failed, setFailed] = useState(false);

	// Ask once on arrival and on each retry; a stopped engine is asked again when it restarts
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		if (!status.running) return;
		let alive = true;
		setFailed(false);
		loadSettings().then(() => alive && setFailed(getState().settings === null));
		return () => {
			alive = false;
		};
	}, [attempt, status.running]);

	return (
		<div className="settings">
			{!status.running ? (
				<Loader label="The engine is stopped" detail={status.error ?? "Settings come back as soon as it restarts."} />
			) : failed ? (
				<Loader
					label="Settings didn't load"
					detail="The engine is running but didn't answer."
					action={
						<Button variant="primary" onClick={() => setAttempt((n) => n + 1)}>
							Try again
						</Button>
					}
				/>
			) : (
				<Loader label="Reading settings" detail="Asking the engine for your preferences." />
			)}
		</div>
	);
}

/** A request from outside (the palette) to show one setting. */
export interface SettingsReveal {
	id: string;
	/** When it was asked, so asking again for the same thing still acts. */
	at: number;
}

/** Every preference, saved together. Changes that restart the engine say so first. */
export function SettingsView({ reveal }: { reveal?: SettingsReveal | null }) {
	const saved = useSettings();
	const info = useAppInfo();
	const engine = useEngine();
	const [draft, setDraft] = useState<Settings | null>(saved);
	const [saving, setSaving] = useState(false);
	const scroll = useRef<HTMLDivElement>(null);

	// Adopt saved settings when nothing is being edited; slow tide's switch always follows them
	const previous = useRef(saved);
	useEffect(() => {
		const before = previous.current;
		previous.current = saved;
		setDraft((d) => {
			if (d === null || !saved || JSON.stringify(d) === JSON.stringify(before)) return saved;
			const next = { ...d };
			for (const k of TIDE_SWITCH_KEYS) (next as Record<string, unknown>)[k] = saved[k];
			return next;
		});
	}, [saved]);

	// Show the setting the palette asked for: scrolled to, flashed and focused
	useEffect(() => {
		if (!reveal) return;
		const timer = setTimeout(() => {
			const el = scroll.current?.querySelector<HTMLElement>(`[data-setting="${reveal.id}"]`);
			if (!el) return;
			el.scrollIntoView({ block: "center", behavior: "smooth" });
			el.classList.remove("is-found");
			void el.offsetWidth;
			el.classList.add("is-found");
			el.querySelector<HTMLElement>("input, select, textarea, button")?.focus({ preventScroll: true });
		}, 50);
		return () => clearTimeout(timer);
	}, [reveal, draft === null]);

	if (!draft || !saved) return <SettingsWait />;

	const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setDraft({ ...draft, [key]: value });
	const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
	const restarts = RESTART_KEYS.some((k) => draft[k] !== saved[k]);

	const save = async () => {
		setSaving(true);
		try {
			const r = await call("setSettings", draft);
			setSettings(r.settings);
			setDraft(getState().settings);
			toast(r.restarted ? "Saved. The engine restarted with the new settings." : "Settings saved.", "success");
		} catch (e) {
			toastError(e);
		} finally {
			setSaving(false);
		}
	};

	const chooseDir = async () => {
		const picked = await call("pickFolder", { start: draft.downloadDir }).catch(() => null);
		if (picked) set("downloadDir", picked);
	};

	return (
		<div className="settings">
			<div className="settings__scroll" ref={scroll}>
				<h1 className="display settings__title">Settings</h1>

				<Section title="Downloads">
					<Setting id="downloadDir">
						<TextField
							label="Save new torrents to"
							value={draft.downloadDir}
							onChange={(v) => set("downloadDir", v)}
							suffix={
								<Button variant="ghost" icon={<FolderOpen size={14} strokeWidth={1.5} />} onClick={chooseDir}>
									Choose
								</Button>
							}
						/>
					</Setting>
					<Setting id="maxActiveDownloads">
						<NumberField label="Downloads at once" value={draft.maxActiveDownloads} onChange={(v) => set("maxActiveDownloads", Math.round(v))} hint="The rest wait in the queue. 0 runs everything." />
					</Setting>
					<Setting id="notifyOnComplete">
						<Toggle label="Notify when a download finishes" checked={draft.notifyOnComplete} onChange={(v) => set("notifyOnComplete", v)} />
					</Setting>
					<Setting id="preventSleep">
						<Toggle label="Keep the Mac awake while downloading" description="Until five minutes after the last data arrives. The display still sleeps, and closing the lid still sleeps the Mac." checked={draft.preventSleep} onChange={(v) => set("preventSleep", v)} />
					</Setting>
					<Setting id="clipboardMagnets">
						<Toggle label="Offer magnet links I copy" description="When you come back to Riptide with a magnet link on the clipboard, it offers to add it." checked={draft.clipboardMagnets} onChange={(v) => set("clipboardMagnets", v)} />
					</Setting>
				</Section>

				<Section title="Default app">
					<Setting id="defaultApp">
						<DefaultAppFields />
					</Setting>
				</Section>

				<Section title="Speed">
					<Setting id="downloadLimit">
						<RateField label="Download limit" value={draft.downloadLimit} onChange={(v) => set("downloadLimit", v)} />
					</Setting>
					<Setting id="uploadLimit">
						<RateField label="Upload limit" value={draft.uploadLimit} onChange={(v) => set("uploadLimit", v)} />
					</Setting>
				</Section>

				<Section title="Slow tide">
					<SlowTideFields draft={draft} set={set} />
				</Section>

				<Section title="Seeding">
					<Setting id="seedEnabled">
						<Toggle label="Keep sharing after a download finishes" description="Other people downloaded it from someone. Seeding returns the favour." checked={draft.seedEnabled} onChange={(v) => set("seedEnabled", v)} />
					</Setting>
					<Setting id="seedRatio">
						<NumberField label="Stop at ratio" value={draft.seedRatio} onChange={(v) => set("seedRatio", v)} hint="Uploaded ÷ downloaded. 0 never stops." />
					</Setting>
					<Setting id="seedMinutes">
						<NumberField label="Stop after minutes" value={draft.seedMinutes} onChange={(v) => set("seedMinutes", Math.round(v))} hint="0 never stops." />
					</Setting>
				</Section>

				<Section title="Connection">
					<Setting id="port">
						<NumberField label="Listening port" value={draft.port} onChange={(v) => set("port", Math.round(v))} min={1} max={65535} hint={engine ? `Peers reach you on ${engine.announcePort || engine.port}.` : undefined} />
					</Setting>
					<Setting id="acceptIncoming">
						<Toggle label="Accept incoming connections" description="Off, Riptide only connects out. Fewer peers find you, and seeding slows." checked={draft.acceptIncoming} onChange={(v) => set("acceptIncoming", v)} />
					</Setting>
					<Setting id="encryption">
						<Select label="Encryption" value={draft.encryption} options={ENCRYPTION_OPTIONS} onChange={(v) => set("encryption", v)} />
					</Setting>
					<Setting id="portMapping">
						<Toggle label="Map the port on your router" description="NAT-PMP, then UPnP, so peers can connect to you." checked={draft.portMapping} onChange={(v) => set("portMapping", v)} />
					</Setting>
					<Setting id="dht">
						<Toggle label="Find peers through the DHT" checked={draft.dht} onChange={(v) => set("dht", v)} />
					</Setting>
					<Setting id="pex">
						<Toggle label="Swap peers with peers (PEX)" checked={draft.pex} onChange={(v) => set("pex", v)} />
					</Setting>
					<Setting id="maxPeers">
						<NumberField label="Peers per torrent" value={draft.maxPeers} onChange={(v) => set("maxPeers", Math.round(v))} min={1} />
					</Setting>
					<Setting id="maxHalfOpen">
						<NumberField label="Connection attempts at once" value={draft.maxHalfOpen} onChange={(v) => set("maxHalfOpen", Math.round(v))} min={1} hint="Peers being dialled across every torrent. Lower it if your router struggles." />
					</Setting>
					<Setting id="webSeeds">
						<NumberField label="Web seeds per torrent" value={draft.webSeeds} onChange={(v) => set("webSeeds", Math.round(v))} min={0} hint="HTTP mirrors a torrent lists, downloaded from beside peers. 0 never uses them." />
					</Setting>
					<Setting id="uploadSlots">
						<NumberField label="Upload slots per torrent" value={draft.uploadSlots} onChange={(v) => set("uploadSlots", Math.round(v))} hint="0 never uploads." />
					</Setting>
				</Section>

				<Section title="Performance">
					<Setting id="maxBufferBytes">
						<NumberField label="Memory per torrent" value={Math.round(draft.maxBufferBytes / MB)} onChange={(v) => set("maxBufferBytes", Math.round(v) * MB)} min={16} hint="MB held for pieces in progress. More keeps fast swarms busy." />
					</Setting>
					<Setting id="threads">
						<NumberField label="Engine threads" value={draft.threads} onChange={(v) => set("threads", Math.round(v))} hint="0 uses one per performance core on Apple silicon, one per core elsewhere." />
					</Setting>
				</Section>

				<Section title="VPN lock">
					<LockFields draft={draft} set={set} />
				</Section>
				<section className="settings__section about">
					<div className="about__current" aria-hidden>
						<TideLines down={engine?.downRate ?? 0} up={engine?.upRate ?? 0} />
					</div>
					<div className="about__text">
						<h2 className="display about__name">Riptide</h2>
						<p>
							Version {info?.version ?? "—"} · engine {info?.engineVersion ?? "—"}
						</p>
						<p className="muted">Built on the Undercurrent BitTorrent engine (MIT) and Electrobun. Set in Clash Grotesk and Satoshi, typefaces by the Indian Type Foundry, used under the ITF Free Font Licence.</p>
						<p className="muted selectable">Data: {info?.dataDir ?? "—"}</p>
					</div>
				</section>
			</div>

			<AnimatePresence>
				{dirty && (
					<motion.div className="savebar" initial={{ y: "100%" }} animate={{ y: 0, transition: { duration: 0.35, ease: EASE_OUT } }} exit={{ y: "100%", transition: { duration: 0.2 } }}>
						<p>{restarts ? "These changes restart the engine. Transfers pick up where they were." : "You have unsaved changes."}</p>
						<div className="savebar__actions">
							<Button onClick={() => setDraft(saved)} disabled={saving}>
								Discard
							</Button>
							<Button variant="primary" onClick={save} disabled={saving}>
								{saving ? "Saving…" : "Save changes"}
							</Button>
						</div>
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
}
