/**
 * Reading magnet links: finding one in a piece of text, and its info hash and name.
 */

/** The first magnet link in some text (a clipboard, a page's selection). */
export function findMagnet(text: string): string | null {
	return text.match(/magnet:\?[^\s"'<>]+/i)?.[0] ?? null;
}

/** A magnet link's info hash as lowercase hex (from hex or base32 `btih`), or null. */
export function magnetHash(uri: string): string | null {
	const m = uri.match(/[?&]xt=urn:btih:([^&]+)/i);
	if (!m) return null;
	const v = m[1]!;
	if (/^[0-9a-f]{40}$/i.test(v)) return v.toLowerCase();
	if (/^[a-z2-7]{32}$/i.test(v)) return base32ToHex(v);
	return null;
}

/** A magnet link's display name (`dn`), if it has one. */
export function magnetName(uri: string): string | null {
	const m = uri.match(/[?&]dn=([^&]+)/i);
	if (!m) return null;
	try {
		return decodeURIComponent(m[1]!.replace(/\+/g, " "));
	} catch {
		return m[1]!;
	}
}

/** RFC 4648 base32 (as in old-style magnets) to hex. */
function base32ToHex(b32: string): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
	let bits = "";
	for (const ch of b32.toLowerCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
	let hex = "";
	for (let i = 0; i + 4 <= bits.length; i += 4) hex += Number.parseInt(bits.slice(i, i + 4), 2).toString(16);
	return hex;
}
