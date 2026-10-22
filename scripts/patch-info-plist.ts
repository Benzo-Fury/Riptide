/**
 * Electrobun build hook (postBuild and postWrap) that fixes the app's .torrent claim in Info.plist.
 *
 * Electrobun's fileAssociations exports a type of its own (dev.riptide.desktop.torrent) and
 * binds the document type to it. macOS already types .torrent files as org.bittorrent.torrent,
 * so that claim never matches: Riptide doesn't show in Open With and can't be made the default.
 * This rebinds the document type to org.bittorrent.torrent, imports that type (in case no other
 * app on the Mac declares it), and ranks Riptide as the owner of .torrent files and magnet links.
 *
 *   bun scripts/patch-info-plist.ts [path/to/App.app ...]   # by hand, for an existing bundle
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const TORRENT_UTI = "org.bittorrent.torrent";

type Plist = Record<string, unknown> & {
	CFBundleIdentifier?: string;
	CFBundleDocumentTypes?: Record<string, unknown>[];
	CFBundleURLTypes?: Record<string, unknown>[];
	UTExportedTypeDeclarations?: Record<string, unknown>[];
	UTImportedTypeDeclarations?: Record<string, unknown>[];
};

// ---------- Bundles ---------- //

/** The bundles to patch: arguments, else the wrapper (postWrap), else the apps in the build dir (postBuild). */
function bundles(): string[] {
	const args = process.argv.slice(2);
	if (args.length > 0) return args;
	const wrapper = process.env.ELECTROBUN_WRAPPER_BUNDLE_PATH;
	if (wrapper) return [wrapper];
	const dir = process.env.ELECTROBUN_BUILD_DIR;
	if (!dir || !existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".app"))
		.map((name) => join(dir, name));
}

// ---------- Plist ---------- //

/** Reads a plist as JSON through plutil. */
function read(path: string): Plist {
	const out = Bun.spawnSync(["plutil", "-convert", "json", "-o", "-", path]);
	if (out.exitCode !== 0) throw new Error(`plutil couldn't read ${path}: ${out.stderr.toString()}`);
	return JSON.parse(out.stdout.toString());
}

/** Writes a plist back as XML through plutil. */
function write(path: string, plist: Plist): void {
	const out = Bun.spawnSync(["plutil", "-convert", "xml1", "-o", path, "-"], { stdin: Buffer.from(JSON.stringify(plist)) });
	if (out.exitCode !== 0) throw new Error(`plutil couldn't write ${path}: ${out.stderr.toString()}`);
}

/** Claims .torrent files by their standard type, and ranks Riptide as their owner and magnet's. */
function patch(plist: Plist): Plist {
	// The type Electrobun made up for .torrent; dropped in favour of the standard one
	const own = `${plist.CFBundleIdentifier}.torrent`;
	const exported = (plist.UTExportedTypeDeclarations ?? []).filter((t) => t.UTTypeIdentifier !== own);
	if (exported.length > 0) plist.UTExportedTypeDeclarations = exported;
	else delete plist.UTExportedTypeDeclarations;

	// Import the standard type, so it exists even with no other torrent app installed
	const imported = (plist.UTImportedTypeDeclarations ?? []).filter((t) => t.UTTypeIdentifier !== TORRENT_UTI);
	imported.push({
		UTTypeIdentifier: TORRENT_UTI,
		UTTypeDescription: "BitTorrent Document",
		UTTypeConformsTo: ["public.data"],
		UTTypeTagSpecification: { "public.filename-extension": ["torrent"], "public.mime-type": ["application/x-bittorrent"] },
	});
	plist.UTImportedTypeDeclarations = imported;

	// Bind the document type to it
	for (const doc of plist.CFBundleDocumentTypes ?? []) {
		const exts = (doc.CFBundleTypeExtensions as string[] | undefined) ?? [];
		if (!exts.includes("torrent")) continue;
		doc.LSItemContentTypes = [TORRENT_UTI];
		doc.LSHandlerRank = "Owner";
	}

	// Magnet links
	for (const url of plist.CFBundleURLTypes ?? []) {
		if (((url.CFBundleURLSchemes as string[] | undefined) ?? []).includes("magnet")) url.LSHandlerRank = "Owner";
	}
	return plist;
}

// ---------- Run ---------- //

if (process.platform !== "darwin") process.exit(0);

for (const bundle of bundles()) {
	const path = join(bundle, "Contents/Info.plist");
	if (!existsSync(path)) continue;
	write(path, patch(read(path)));
	console.log(`Info.plist: .torrent claimed as ${TORRENT_UTI} → ${path}`);
}
