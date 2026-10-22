import { useMemo } from "react";
import { useTween } from "../lib/hooks";

interface AnimatedNumberProps {
	value: number;
	format: (n: number) => string;
	className?: string;
	/** Tween length in milliseconds. */
	ms?: number;
}

/** A live figure that eases between values instead of jumping. */
export function AnimatedNumber({ value, format, className, ms }: AnimatedNumberProps) {
	const shown = useTween(value, ms);
	return <span className={className}>{format(shown)}</span>;
}

export interface SparkSeries {
	values: number[];
	/** A CSS colour, normally a token like var(--accent). */
	color: string;
}

interface SparklineProps {
	series: SparkSeries[];
	width: number;
	height: number;
	/** Slots on the x axis; series shorter than this are right-aligned (newest at the right). */
	length: number;
	label: string;
}

/** Line charts of recent values sharing one y scale, newest at the right edge. */
export function Sparkline({ series, width, height, length, label }: SparklineProps) {
	const paths = useMemo(() => {
		const max = Math.max(1, ...series.flatMap((s) => s.values));
		const step = width / Math.max(1, length - 1);
		return series.map((s) => {
			const offset = length - s.values.length;
			const d = s.values.map((v, i) => `${i === 0 ? "M" : "L"}${((offset + i) * step).toFixed(1)},${(height - 1 - (v / max) * (height - 3)).toFixed(1)}`).join("");
			return { d, color: s.color };
		});
	}, [series, width, height, length]);
	return (
		<svg className="sparkline" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
			{paths.map((p, i) => (
				<path key={i} d={p.d} fill="none" stroke={p.color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
			))}
		</svg>
	);
}
