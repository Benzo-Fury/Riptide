import { useEffect, useRef } from "react";
import type { TorrentSource, TorrentSummary } from "../../shared/types";
import { call } from "../lib/bridge";
import { findMagnet, magnetHash, magnetName } from "../lib/magnet";
import { toast } from "../components/Toasts";

/** Hashes already offered, kept for the session so a link is offered once. */
const OFFERED_KEY = "riptide.offeredMagnets";

function loadOffered(): Set<string> {
	try {
		return new Set(JSON.parse(sessionStorage.getItem(OFFERED_KEY) ?? "[]") as string[]);
	} catch {
		return new Set();
	}
}

function saveOffered(offered: Set<string>): void {
	try {
		sessionStorage.setItem(OFFERED_KEY, JSON.stringify([...offered].slice(-50)));
	} catch {
		// Storage is a convenience; without it a link may be offered again
	}
}

/**
 * Offers a magnet link found on the clipboard when the window comes back into focus, unless
 * that torrent is already in the list or the link was offered before. One toast, with "Add".
 */
export function useClipboardMagnets(enabled: boolean, torrents: TorrentSummary[], onAdd: (sources: TorrentSource[]) => void): void {
	const offered = useRef(loadOffered());
	// Read through refs so focus listeners stay put while the list changes
	const state = useRef({ torrents, onAdd });
	state.current = { torrents, onAdd };

	useEffect(() => {
		if (!enabled) return;
		let checking = false;

		// Look at the clipboard and offer what's new
		const check = async () => {
			if (checking || document.hidden) return;
			checking = true;
			try {
				const text = await call("readClipboard").catch(() => null);
				const uri = text ? findMagnet(text) : null;
				const hash = uri ? magnetHash(uri) : null;
				if (!uri || !hash || offered.current.has(hash)) return;
				offered.current.add(hash);
				saveOffered(offered.current);
				if (state.current.torrents.some((t) => t.hash === hash)) return;
				const name = magnetName(uri) ?? `${hash.slice(0, 12)}…`;
				toast(`Magnet link on the clipboard: ${name}`, "info", { label: "Add", onSelect: () => state.current.onAdd([{ kind: "magnet", uri }]) });
			} finally {
				checking = false;
			}
		};

		// On arrival, and whenever the window comes back
		const t = setTimeout(check, 800);
		window.addEventListener("focus", check);
		document.addEventListener("visibilitychange", check);
		return () => {
			clearTimeout(t);
			window.removeEventListener("focus", check);
			document.removeEventListener("visibilitychange", check);
		};
	}, [enabled]);
}
