import { useEffect, useState } from "react";
import { usePrevious } from "../lib/hooks";

export type ProgressTone = "ink" | "sea" | "muted" | "danger" | "accent";

interface ProgressBarProps {
	/** 0 to 1. */
	value: number;
	tone?: ProgressTone;
	/**
	 * Speed of the flow texture along the filled part, in pixels per second; 0 for none. Callers
	 * derive it from the transfer rate, so the bar visibly moves as fast as the data.
	 */
	flow?: number;
	/** Unknown progress (fetching metadata): a segment travels along the track instead. */
	indeterminate?: boolean;
	/** Runs the one-time completion wave when this turns true. */
	complete?: boolean;
	label?: string;
}

/**
 * A 4px progress bar. The fill is clipped rather than scaled so its texture stays undistorted;
 * the clip eases to each new value. Under reduced motion the texture and wave are not drawn.
 */
export function ProgressBar({ value, tone = "ink", flow = 0, indeterminate, complete, label }: ProgressBarProps) {
	const wasComplete = usePrevious(complete);
	const [wave, setWave] = useState(0);

	// The completion wave plays once, when completion happens while watching
	useEffect(() => {
		if (complete && wasComplete === false) setWave((w) => w + 1);
	}, [complete, wasComplete]);

	const pct = Math.max(0, Math.min(1, value));
	return (
		<div className={`progress progress--${tone}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={indeterminate ? undefined : Math.round(pct * 100)}>
			{indeterminate ? (
				<div className="progress__seek" />
			) : (
				<div className="progress__fill" style={{ clipPath: `inset(0 ${(1 - pct) * 100}% 0 0)` }}>
					{flow > 0 && <div className="progress__flow" style={{ animationDuration: `${24 / flow}s` }} />}
				</div>
			)}
			{wave > 0 && <div key={wave} className="progress__wave" />}
		</div>
	);
}

/** Flow speed (px/s) for a transfer rate: logarithmic, so slow transfers still visibly move. */
export function flowFor(bytesPerSecond: number): number {
	if (bytesPerSecond <= 0) return 0;
	return Math.min(120, 6 + 22 * Math.log10(1 + bytesPerSecond / 20_000));
}
