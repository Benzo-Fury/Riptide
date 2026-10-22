import { useMemo, useRef, type PointerEvent } from "react";

interface WeekGridProps {
	/** 168 hours, Monday 00:00 first; true is painted. */
	value: boolean[];
	onChange: (value: boolean[]) => void;
	/** Read out with each hour: "Monday 09:00, slow". */
	onLabel: string;
	offLabel: string;
	/** The hour of the week to mark as now, if any. */
	now?: number;
	label: string;
}

const HOURS = 24;
const DAYS = 7;

/** Monday-first weekday names in the user's locale. */
function dayNames(): string[] {
	// 5 Jan 2026 is a Monday
	return Array.from({ length: DAYS }, (_, i) => new Date(2026, 0, 5 + i).toLocaleDateString(undefined, { weekday: "short" }));
}

/**
 * A week of hours to paint: press on an hour and drag across others to paint them all the
 * opposite of where the stroke started. Each hour is also a button for the keyboard.
 */
export function WeekGrid({ value, onChange, onLabel, offLabel, now, label }: WeekGridProps) {
	const days = useMemo(dayNames, []);
	const stroke = useRef<{ paint: boolean; draft: boolean[] } | null>(null);

	// The hour under the pointer, from its data attribute
	const hourAt = (x: number, y: number): number | null => {
		const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-hour]");
		return el ? Number(el.dataset.hour) : null;
	};

	const paint = (hour: number) => {
		const s = stroke.current;
		if (!s || s.draft[hour] === s.paint) return;
		s.draft = s.draft.slice();
		s.draft[hour] = s.paint;
		onChange(s.draft);
	};

	const onDown = (e: PointerEvent<HTMLDivElement>) => {
		const hour = hourAt(e.clientX, e.clientY);
		if (hour === null || e.button !== 0) return;
		e.preventDefault();
		e.currentTarget.setPointerCapture(e.pointerId);
		stroke.current = { paint: !value[hour], draft: value };
		paint(hour);
	};
	const onMove = (e: PointerEvent<HTMLDivElement>) => {
		if (!stroke.current) return;
		const hour = hourAt(e.clientX, e.clientY);
		if (hour !== null) paint(hour);
	};
	const onUp = () => {
		stroke.current = null;
	};

	const toggle = (hour: number) => {
		const next = value.slice();
		next[hour] = !next[hour];
		onChange(next);
	};

	return (
		<div className="week" role="group" aria-label={label}>
			<div className="week__hours" aria-hidden>
				{[0, 6, 12, 18].map((h) => (
					<span key={h} style={{ gridColumn: h + 2 }}>
						{String(h).padStart(2, "0")}
					</span>
				))}
			</div>
			<div className="week__grid" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
				{days.map((day, d) => (
					<div key={day} className="week__day">
						<span className="week__name">{day}</span>
						{Array.from({ length: HOURS }, (_, h) => {
							const hour = d * HOURS + h;
							const on = !!value[hour];
							return (
								<button
									key={h}
									type="button"
									data-hour={hour}
									className={`week__cell ${on ? "is-on" : ""} ${hour === now ? "is-now" : ""}`}
									aria-pressed={on}
									aria-label={`${day} ${String(h).padStart(2, "0")}:00, ${on ? onLabel : offLabel}`}
									onClick={(e) => e.detail === 0 && toggle(hour)}
								/>
							);
						})}
					</div>
				))}
			</div>
		</div>
	);
}
