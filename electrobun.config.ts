import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "Riptide",
		identifier: "dev.riptide.desktop",
		version: "0.1.0",
		description: "A BitTorrent client on the Undercurrent engine.",
		// Magnet links open the app
		urlSchemes: ["magnet"],
		// .torrent files open the app (Finder, Open With, drag to Dock)
		fileAssociations: [{ ext: ["torrent"], name: "BitTorrent Document", role: "Viewer" }],
	},
	build: {
		// The main process runs on Bun
		mainProcess: "bun",
		bun: {
			entrypoint: "src/bun/index.ts",
		},
		copy: {
			// The UI, built by Vite into dist/
			"dist/index.html": "views/mainview/index.html",
			"dist/assets": "views/mainview/assets",
			// The Undercurrent engine process, built by scripts/build-engine.ts
			"vendor/bin/undercurrentd": "bin/undercurrentd",
		},
		watchIgnore: ["dist/**", "engine/target/**"],
		mac: {
			bundleCEF: false,
			icons: "assets/icon.iconset",
		},
		linux: {
			bundleCEF: false,
		},
		win: {
			bundleCEF: false,
		},
	},
	scripts: {
		// Claim .torrent files by their standard type, so Riptide can be their default app.
		// postBuild patches the app itself, postWrap the self-extracting wrapper around it.
		postBuild: "scripts/patch-info-plist.ts",
		postWrap: "scripts/patch-info-plist.ts",
	},
	runtime: {
		// Closing the window keeps transfers running from the tray; Quit ends them
		exitOnLastWindowClosed: false,
	},
} satisfies ElectrobunConfig;
