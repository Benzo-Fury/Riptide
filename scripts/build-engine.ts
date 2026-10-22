/**
 * Builds undercurrentd (the Undercurrent engine process) and places it at vendor/bin/undercurrentd, where
 * electrobun.config.ts copies it into the app bundle. Run before every app build.
 *
 *   bun scripts/build-engine.ts           # release build (what ships)
 *   bun scripts/build-engine.ts --debug   # faster to compile, for tests
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const debug = process.argv.includes("--debug");

// The engine library is a path dependency on the sibling Undercurrent checkout
const undercurrent = resolve(root, "../Undercurrent/Cargo.toml");
if (!existsSync(undercurrent)) {
	console.error(`Undercurrent isn't at ${undercurrent}. Clone it beside this project (engine/Cargo.toml points there).`);
	process.exit(1);
}

// Build
const args = ["cargo", "build", "--manifest-path", join(root, "engine/Cargo.toml"), ...(debug ? [] : ["--release"])];
console.log(`$ ${args.join(" ")}`);
const build = Bun.spawnSync(args, { stdout: "inherit", stderr: "inherit" });
if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);

// Place the binary where the app bundle picks it up
const built = join(root, "engine/target", debug ? "debug" : "release", "undercurrentd");
const dest = join(root, "vendor/bin/undercurrentd");
mkdirSync(join(root, "vendor/bin"), { recursive: true });
copyFileSync(built, dest);
chmodSync(dest, 0o755);
console.log(`undercurrentd → ${dest}`);
