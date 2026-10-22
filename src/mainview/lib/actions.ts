/**
 * Torrent actions shared by the toolbar, rows, context menu and details drawer. Each reports
 * its own failure as a toast, so callers can fire and forget.
 */

import type { TorrentSummary } from "../../shared/types";
import { toast, toastError } from "../components/Toasts";
import { call } from "./bridge";
import { setSettings } from "./store";

/** Joins a folder and a relative path with one slash. */
export function joinPath(dir: string, rel: string): string {
	return `${dir.replace(/\/+$/, "")}/${rel.replace(/^\/+/, "")}`;
}

/** Where a torrent's content is on disk: its folder for multi-file torrents, its file otherwise. */
export function contentPath(t: Pick<TorrentSummary, "dir" | "name">): string {
	return joinPath(t.dir, t.name);
}

async function run(work: () => Promise<unknown>): Promise<void> {
	try {
		await work();
	} catch (e) {
		toastError(e);
	}
}

export const actions = {
	pause: (hashes: string[]) => run(() => call("pause", { hashes })),
	resume: (hashes: string[]) => run(() => call("resume", { hashes })),
	recheck: (hashes: string[]) =>
		run(async () => {
			await call("recheck", { hashes });
			toast(hashes.length === 1 ? "Checking the files on disk." : `Checking ${hashes.length} torrents' files.`);
		}),
	remove: (hashes: string[], deleteFiles: boolean) => run(() => call("remove", { hashes, deleteFiles })),

	/** Opens the content: the file itself, or the folder of a multi-file torrent. */
	open: (t: TorrentSummary) =>
		run(async () => {
			const ok = await call("openPath", { path: contentPath(t) });
			if (!ok) await call("openPath", { path: t.dir });
		}),
	reveal: (t: TorrentSummary) => run(() => call("revealPath", { path: contentPath(t) })),

	copyMagnet: (hash: string) =>
		run(async () => {
			const d = await call("details", { hash });
			if (d.magnet) {
				await call("writeClipboard", { text: d.magnet });
				toast("Magnet link copied.", "success");
			}
		}),

	copyHash: (hash: string) =>
		run(async () => {
			await call("writeClipboard", { text: hash });
			toast("Info hash copied.", "success");
		}),

	/** Switches slow tide by hand; with a schedule, until its next change. */
	setSlowTide: (on: boolean) =>
		run(async () => {
			const r = await call("setSlowTide", { on });
			setSettings(r.settings);
		}),

	exportTorrent: (hash: string) =>
		run(async () => {
			const path = await call("exportTorrent", { hash });
			if (path) toast(`Saved ${path.split("/").pop()}.`, "success");
		}),
};
