import { useRef, useState } from "react";
import { ArrowDown, ArrowUp, Lock, Waves } from "lucide-react";
import type { SlowTideState } from "../../shared/types";
import { formatBytes, formatRate, formatWhen } from "../../shared/format";
import { actions } from "../lib/actions";
import { HISTORY_LENGTH, useEngine, useEngineStatus, useHistory, useLock, useSettings, useSlowTide, useSnapshot } from "../lib/store";
import { AnimatedNumber, Sparkline } from "../components/Figures";
import { TrafficPanel } from "./TrafficPanel";

/** What the slow tide switch says when hovered: its state, its limits and the schedule. */
function tideTitle(tide: SlowTideState | null, limits: string): string {
	if (!tide) return "Slow tide";
	const until = tide.nextChange ? ` until ${formatWhen(tide.nextChange)}` : "";
	if (tide.overridden) return `Slow tide ${tide.on ? "on" : "off"} by hand${until}, then the schedule takes over. Click to switch.`;
	if (tide.scheduled) return `Slow tide on by schedule${until} (${limits}). Click to switch off.`;
	return tide.on ? `Slow tide on (${limits}). Click to switch off.` : `Slow tide: limit to ${limits}. Click to switch on.`;
}

interface StatusBarProps {
	/** From the traffic panel's list: select a torrent and unfold its details. */
	onShowTorrent: (hash: string) => void;
}

/**
 * Network health on the left; slow tide, totals and the last minute of throughput on the right.
 * The throughput sparkline opens the traffic panel.
 */
export function StatusBar({ onShowTorrent }: StatusBarProps) {
	const engine = useEngine();
	const status = useEngineStatus();
	const snapshot = useSnapshot();
	const recent = useHistory().slice(-HISTORY_LENGTH);
	const settings = useSettings();
	const tide = useSlowTide();
	const lock = useLock();
	const [trafficOpen, setTrafficOpen] = useState(false);
	const sparkRef = useRef<HTMLButtonElement>(null);
	const slowLimits = settings ? `↓ ${settings.slowDownloadLimit ? formatRate(settings.slowDownloadLimit) : "unlimited"} ↑ ${settings.slowUploadLimit ? formatRate(settings.slowUploadLimit) : "unlimited"}` : "the slow limits";

	// The engine's own words when it isn't healthy
	let health: string;
	let bad = false;
	if (!status.running) {
		health = status.error ?? "The engine has stopped.";
		bad = true;
	} else if (snapshot?.engineError) {
		health = snapshot.engineError;
		bad = true;
	} else if (lock && !lock.address) {
		health = `${lock.interface} is down. Nothing connects until it's back.`;
		bad = true;
	} else if (engine) {
		const parts = [`Port ${engine.announcePort || engine.port}`, settings?.dht === false ? "DHT off" : engine.dhtNodes > 0 ? `DHT ${engine.dhtNodes} nodes` : "DHT starting", `${engine.peers} ${engine.peers === 1 ? "peer" : "peers"}`];
		health = parts.join(" · ");
	} else {
		health = "Starting the engine…";
	}

	return (
		<footer className="status">
			<p className={`status__health ${bad ? "is-error" : ""}`} data-tip={bad ? health : undefined}>
				{lock && (
					<span className={`status__lock ${lock.address ? "" : "is-down"}`} data-tip={lock.address ? `Every connection goes through ${lock.interface} (${lock.address}).` : undefined}>
						<Lock size={11} strokeWidth={2} />
						{lock.address ? `${lock.interface} · ${lock.address}` : "Locked"}
					</span>
				)}
				<span className="ellipsis">{health}</span>
			</p>
			<div className="status__totals">
				<button className={`tide-switch ${tide?.on ? "is-on" : ""}`} aria-pressed={tide?.on ?? false} data-tip={tideTitle(tide, slowLimits)} onClick={() => actions.setSlowTide(!tide?.on)}>
					<Waves size={13} strokeWidth={1.75} />
					<span>Slow tide</span>
					{tide?.on && tide.nextChange && (tide.scheduled || tide.overridden) && <span className="tide-switch__until">until {formatWhen(tide.nextChange)}</span>}
				</button>
				<button ref={sparkRef} className={`status__spark ${trafficOpen ? "is-open" : ""}`} aria-expanded={trafficOpen} aria-haspopup="dialog" data-tip="Show traffic" onClick={() => setTrafficOpen((o) => !o)}>
					<Sparkline
						width={96}
						height={16}
						length={HISTORY_LENGTH}
						label="Throughput over the last minute"
						series={[
							{ values: recent.map((h) => h.up), color: "var(--sea)" },
							{ values: recent.map((h) => h.down), color: "var(--accent)" },
						]}
					/>
				</button>
				<span className="status__rate" data-tip={`Downloaded this session: ${formatBytes(engine?.sessionDownloaded ?? 0)}`}>
					<ArrowDown size={12} strokeWidth={2} className="status__in" />
					<AnimatedNumber value={engine?.downRate ?? 0} format={formatRate} />
				</span>
				<span className="status__rate" data-tip={`Uploaded this session: ${formatBytes(engine?.sessionUploaded ?? 0)}`}>
					<ArrowUp size={12} strokeWidth={2} className="status__out" />
					<AnimatedNumber value={engine?.upRate ?? 0} format={formatRate} />
				</span>
			</div>
			<TrafficPanel
				open={trafficOpen}
				origin={sparkRef}
				onClose={() => setTrafficOpen(false)}
				onShowTorrent={(hash) => {
					setTrafficOpen(false);
					onShowTorrent(hash);
				}}
			/>
		</footer>
	);
}
