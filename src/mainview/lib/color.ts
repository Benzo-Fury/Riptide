/**
 * Colour helpers for canvas drawing, which can't use CSS variables directly.
 */

/** The value of a CSS custom property on the root, e.g. `cssToken("--accent")`. */
export function cssToken(name: string): string {
	return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** "#rrggbb" + alpha → "rgb(r g b / a)". */
export function withAlpha(hex: string, alpha: number): string {
	const n = Number.parseInt(hex.replace("#", ""), 16);
	return `rgb(${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255} / ${alpha})`;
}
