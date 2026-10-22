/**
 * Formatting for sizes, rates, durations and ratios, shared by the UI and the tray. Decimal
 * units (1 MB = 1,000,000 bytes), like Finder.
 */

const UNITS = ["B", "kB", "MB", "GB", "TB", "PB"];

/** 1234567 → "1.2 MB". Three significant figures at most. */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	const exp = Math.min(Math.floor(Math.log10(bytes) / 3), UNITS.length - 1);
	const value = bytes / 1000 ** exp;
	const digits = exp === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
	return `${value.toFixed(digits)} ${UNITS[exp]}`;
}

/** Bytes per second → "4.2 MB/s"; zero is "0 B/s". */
export function formatRate(bytesPerSecond: number): string {
	return `${formatBytes(bytesPerSecond)}/s`;
}

/** A rate split into figure and unit, for setting the unit smaller: [ "84.2", "MB/s" ]. */
export function splitRate(bytesPerSecond: number): [string, string] {
	const [n, u] = formatBytes(bytesPerSecond).split(" ");
	return [n ?? "0", `${u ?? "B"}/s`];
}

/** Seconds → "2h 14m", "3m 05s", "45s"; Infinity or negative → "∞". */
export function formatDuration(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) return "∞";
	const s = Math.round(seconds);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
	const h = Math.floor(m / 60);
	if (h < 48) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
	return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Seconds left at the current rate, or Infinity when nothing is arriving. */
export function eta(remainingBytes: number, bytesPerSecond: number): number {
	if (remainingBytes <= 0) return 0;
	return bytesPerSecond > 0 ? remainingBytes / bytesPerSecond : Infinity;
}

/** 1.234 → "1.23"; anything 100 or more without decimals. */
export function formatRatio(ratio: number): string {
	if (!Number.isFinite(ratio)) return "∞";
	return ratio >= 100 ? ratio.toFixed(0) : ratio.toFixed(2);
}

/** 0.4567 → "45.7%"; exact 0 and 1 without decimals. */
export function formatPercent(fraction: number): string {
	if (fraction <= 0) return "0%";
	if (fraction >= 1) return "100%";
	return `${(Math.floor(fraction * 1000) / 10).toFixed(1)}%`;
}

/** Unix ms → "16 Oct 2026, 15:40" in the user's locale. */
export function formatDate(ms: number | null | undefined): string {
	if (!ms) return "—";
	return new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Unix ms → "18:00" today, "Tue 09:00" within the week, else the full date. */
export function formatWhen(ms: number, now = Date.now()): string {
	const d = new Date(ms);
	const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
	if (d.toDateString() === new Date(now).toDateString()) return time;
	if (ms - now < 6 * 86_400_000) return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
	return formatDate(ms);
}

/**
 * Parses "5", "5 MB", "1.5mb/s", "800k", "500 B" into bytes per second (decimal units). A bare
 * number means MB/s, the unit people think in. Empty is 0 (unlimited); nonsense is null.
 */
export function parseRate(text: string): number | null {
	const t = text.trim().toLowerCase();
	if (t === "") return 0;
	const m = t.replace(/\/s$/, "").match(/^(\d+(?:\.\d+)?)\s*([kmgt]?)(b?)$/);
	if (!m) return null;
	const [, n, prefix, b] = m;
	const mult = prefix ? { k: 1e3, m: 1e6, g: 1e9, t: 1e12 }[prefix as "k" | "m" | "g" | "t"] : b ? 1 : 1e6;
	return Math.round(Number(n) * mult);
}
