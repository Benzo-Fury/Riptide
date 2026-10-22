import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { electrobunViteAliases } from "./.hutch/devkit/api/config/electrobun-vite.ts";

// The UI is a plain Vite + React build. Electrobun copies dist/ into the app bundle, and
// scripts/dev-web.ts serves the same build in a browser for testing.
export default defineConfig({
	plugins: [react()],
	resolve: {
		alias: electrobunViteAliases(resolve(import.meta.dirname,".hutch/devkit")),
	},
	root: "src/mainview",
	base: "./",
	build: {
		outDir: "../../dist",
		emptyOutDir: true,
		// The webview is WebKit on macOS 13+
		target: "safari16",
		// Libraries (React, motion, icons) in a chunk of their own, so the size warning still
		// speaks up if the app's own code grows past it
		rolldownOptions: {
			output: {
				codeSplitting: { groups: [{ name: "vendor", test: /node_modules/ }] },
			},
		},
	},
	server: { port: 5183, strictPort: true },
});
