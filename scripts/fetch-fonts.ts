/**
 * Downloads Satoshi and Clash Grotesk from Fontshare into src/mainview/assets/fonts, where the
 * interface's CSS loads them. Their license (ITF Free Font License) lets apps embed them but not
 * repositories redistribute them, so they aren't checked in. Skips fonts already in place.
 *
 *   bun scripts/fetch-fonts.ts
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const dest = join(root, "src/mainview/assets/fonts");

// Each family's Fontshare id, folder in the download, and the files the CSS uses (official name → ours)
const families = [
	{ id: "satoshi", folder: "Satoshi_Complete", files: { "Satoshi-Regular": "Satoshi-400", "Satoshi-Medium": "Satoshi-500", "Satoshi-Bold": "Satoshi-700" } },
	{ id: "clash-grotesk", folder: "ClashGrotesk_Complete", files: { "ClashGrotesk-Regular": "ClashGrotesk-400", "ClashGrotesk-Medium": "ClashGrotesk-500", "ClashGrotesk-Semibold": "ClashGrotesk-600" } },
];

mkdirSync(dest, { recursive: true });
for (const family of families) {
	const wanted = Object.entries(family.files).filter(([, ours]) => !existsSync(join(dest, `${ours}.woff2`)));
	if (wanted.length === 0) continue;

	// Download and unpack the family's zip
	const work = mkdtempSync(join(tmpdir(), "riptide-fonts-"));
	try {
		const res = await fetch(`https://api.fontshare.com/v2/fonts/download/${family.id}`);
		if (!res.ok) throw new Error(`Fontshare answered ${res.status} for ${family.id}`);
		const zip = join(work, "font.zip");
		await Bun.write(zip, res);
		// unzip on macOS and Linux; Windows 10 and later ship a tar that reads zips
		const unpack = process.platform === "win32" ? ["tar", "-xf", zip, "-C", work] : ["unzip", "-q", zip, "-d", work];
		if (Bun.spawnSync(unpack, { stderr: "inherit" }).exitCode !== 0) throw new Error(`couldn't unpack ${family.id}`);

		// Copy the weights the CSS uses
		for (const [official, ours] of wanted) {
			copyFileSync(join(work, family.folder, "Fonts/WEB/fonts", `${official}.woff2`), join(dest, `${ours}.woff2`));
			console.log(`fonts: ${ours}.woff2`);
		}
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}
