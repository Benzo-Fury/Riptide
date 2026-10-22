/**
 * End-to-end UI tests: the real UI in headless Chrome, talking to the real backend and undercurrentd
 * through the web harness, downloading from a real seeder over loopback.
 *
 * Needs a built UI (`vite build`) and undercurrentd (`bun run engine`); `bun run test:ui` does both.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import type { CreateResult } from "../../src/shared/types";
import { ROOT, TestEngine, tempDir, until, writePayload } from "../bun/harness";

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 5300 + Math.floor(Math.random() * 500);
const BASE = `http://localhost:${PORT}`;

let harness: ReturnType<typeof Bun.spawn>;
let harnessState: string;
let seeder: TestEngine;
let content: string;
let browser: Browser;
let page: Page;
const errors: string[] = [];
const torrents: Record<string, CreateResult & { file: string }> = {};

// ---------- Helpers ---------- //

async function post(path: string, body: unknown): Promise<void> {
	await fetch(`${BASE}${path}`, { method: "POST", body: JSON.stringify(body) });
}

async function nativeLog(): Promise<{ kind: string; detail: unknown }[]> {
	return (await fetch(`${BASE}/__test/log`)).json() as Promise<{ kind: string; detail: unknown }[]>;
}

const row = (name: string) => page.locator(".row", { hasText: name });

/** Opens a torrent's details, unless an earlier step left them open (clicking an open row closes it). */
async function openDetails(name: string) {
	if ((await row(name).getAttribute("aria-expanded")) !== "true") await row(name).click();
	await page.locator(".drawer", { has: page.getByRole("tablist") }).and(page.getByLabel(`Details of ${name}`)).waitFor();
}

/** Shares `name` from the seeder; returns its .torrent path and hash. */
async function share(name: string, files: Record<string, number>): Promise<CreateResult & { file: string }> {
	writePayload(content, files);
	const file = join(content, `${name}.torrent`);
	const c = await seeder.request<CreateResult>("create", { path: join(content, name), out: file, trackers: [], private: false, pieceKb: 32, seed: true }, 0);
	await seeder.waitFor(c.hash, "seeding", (t) => t.state === "seeding");
	return (torrents[name] = { ...c, file });
}

/** Points the harness engine's torrent at the seeder (no DHT or trackers in tests). */
async function connect(hash: string): Promise<void> {
	await page.evaluate(
		async ([h, addr]) => {
			const ws = new WebSocket(`ws://${location.host}/rpc`);
			await new Promise((r) => ws.addEventListener("open", r));
			ws.send(JSON.stringify({ id: 1, method: "addPeer", params: { hash: h, address: addr } }));
			await new Promise((r) => ws.addEventListener("message", r));
			ws.close();
		},
		[hash, `127.0.0.1:${seeder.port}`],
	);
}

// ---------- Setup ---------- //

beforeAll(async () => {
	// The seeder and its content
	content = tempDir("ui-content");
	seeder = await new TestEngine("ui-seeder").start();

	// The harness, with loopback-only settings
	harnessState = tempDir("ui-harness");
	mkdirSync(join(harnessState, "downloads"));
	writeFileSync(join(harnessState, "settings.json"), JSON.stringify({ port: 31000 + Math.floor(Math.random() * 9000), dht: false, pex: false, portMapping: false, downloadDir: join(harnessState, "downloads") }));
	harness = Bun.spawn(["bun", join(ROOT, "scripts/dev-web.ts"), "--port", String(PORT), "--state-dir", harnessState], { stdout: "pipe", stderr: "pipe" });
	for (
		let i = 0;
		i < 200 &&
		!(await fetch(`${BASE}/__test/state`).then(
			(r) => r.ok,
			() => false,
		));
		i++
	)
		await Bun.sleep(100);

	// The browser
	browser = await chromium.launch({ executablePath: CHROME, headless: true });
	page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
	page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
	page.on("console", (m) => m.type() === "error" && !m.text().includes("404") && errors.push(`console: ${m.text()}`));
	await page.goto(BASE);
	await page.waitForSelector(".sidebar");
});

afterAll(async () => {
	await browser?.close();
	harness?.kill("SIGTERM");
	await harness?.exited;
	await seeder?.stop();
	seeder?.cleanup();
	rmSync(content, { recursive: true, force: true });
	rmSync(harnessState, { recursive: true, force: true });
});

// ---------- Tests ---------- //

describe("first run", () => {
	test("shows the empty library, the engine's status and the current", async () => {
		await page.getByText("Nothing in the current yet.").waitFor();
		await page.locator(".status__health", { hasText: "Port" }).waitFor();
		expect(await page.locator(".status__health").textContent()).toContain("DHT off");
		expect(await page.locator("canvas.current").count()).toBe(1);
	});
});

describe("adding and downloading", () => {
	test("adds a torrent file with one file left out, and downloads the rest", async () => {
		const t = await share("Album", { "Album/one.bin": 400_000, "Album/two.bin": 600_000, "Album/skip.bin": 300_000 });
		await post("/__test/native", { pickTorrentFiles: [t.file] });

		// The add dialog shows the files; untick one
		await page.getByRole("button", { name: "Add torrent", exact: true }).click();
		const dialog = page.getByRole("dialog");
		await dialog.getByText("skip.bin").waitFor();
		expect(await dialog.locator(".add__name").textContent()).toBe("Album");
		await dialog.locator(".tree__row", { hasText: "skip.bin" }).locator(".checkbox").click();
		await dialog.getByText("1.00 MB of 1.30 MB selected").waitFor();
		await dialog.getByRole("button", { name: "Add and start" }).click();
		await dialog.waitFor({ state: "detached" });

		// It appears selected, downloads, and announces the finish
		await row("Album").waitFor();
		await connect(t.hash);
		await page.locator(".toast", { hasText: "Finished: Album" }).waitFor({ timeout: 20_000 });
		await row("Album").locator(".col-status", { hasText: "Seeding" }).waitFor();
		expect(readFileSync(join(harnessState, "downloads/Album/one.bin")).length).toBe(400_000);
		expect(existsSync(join(harnessState, "downloads/Album/skip.bin"))).toBe(false);
		expect((await nativeLog()).some((l) => l.kind === "notify" && JSON.stringify(l.detail).includes("Album"))).toBe(true);
	});

	test("a magnet link waits for its file list, then downloads the chosen files", async () => {
		const t = await share("Tapes", { "Tapes/a.bin": 200_000, "Tapes/b.bin": 250_000 });
		const uri = `${t.magnet}&x.pe=127.0.0.1:${seeder.port}`;

		// The magnet dialog, with the choose-later option
		await page.getByRole("button", { name: "Add magnet link" }).click();
		await page.getByLabel("Magnet links, one per line").fill(uri);
		await page.getByRole("button", { name: "Continue" }).click();
		const dialog = page.getByRole("dialog");
		await dialog.getByText("Magnet link ·").waitFor();
		await dialog.getByText("Choose files when the list arrives").click();
		await dialog.getByRole("button", { name: "Add and start" }).click();
		await dialog.waitFor({ state: "detached" });

		// Once the list arrives the row offers the choice
		await row("Tapes").getByRole("button", { name: "Choose files" }).click({ timeout: 20_000 });
		const choose = page.getByRole("dialog", { name: "Choose files" });
		await choose.locator(".tree__row", { hasText: "a.bin" }).locator(".checkbox").click();
		await choose.getByRole("button", { name: "Start download" }).click();
		await row("Tapes")
			.locator(".col-status", { hasText: /Seeding|Completed/ })
			.waitFor({ timeout: 20_000 });
		expect(existsSync(join(harnessState, "downloads/Tapes/b.bin"))).toBe(true);
		expect(existsSync(join(harnessState, "downloads/Tapes/a.bin"))).toBe(false);
	});

	test("a torrent opened from outside the app (Finder, a browser) opens the add dialog", async () => {
		await post("/__test/openUrl", { url: `magnet:?xt=urn:btih:${"ab".repeat(20)}&dn=From%20Outside` });
		const dialog = page.getByRole("dialog");
		await dialog.getByText("From Outside").waitFor();
		await dialog.getByText("Start paused").click();
		await dialog.getByRole("button", { name: "Add paused" }).click();
		await row("From Outside").locator(".col-status", { hasText: "Paused" }).waitFor();
	});

	test("dropping a .torrent file on the window adds it", async () => {
		const t = await share("Dropped", { "Dropped/x.bin": 50_000 });
		const b64 = readFileSync(t.file).toString("base64");
		await page.evaluate((data) => {
			const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
			const dt = new DataTransfer();
			dt.items.add(new File([bytes], "Dropped.torrent", { type: "application/x-bittorrent" }));
			window.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, clientX: 600, clientY: 400 }));
		}, b64);
		await page.getByText("Let go to add it.").waitFor();
		await page.evaluate((data) => {
			const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
			const dt = new DataTransfer();
			dt.items.add(new File([bytes], "Dropped.torrent", { type: "application/x-bittorrent" }));
			window.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, clientX: 600, clientY: 400 }));
		}, b64);
		const dialog = page.getByRole("dialog");
		await dialog.locator(".add__name", { hasText: "Dropped" }).waitFor();
		await dialog.getByRole("button", { name: "Add and start" }).click();
		await row("Dropped").waitFor();
		await connect(t.hash);
		await row("Dropped").locator(".col-status", { hasText: "Seeding" }).waitFor({ timeout: 20_000 });
	});

	test("adding the same torrent again says it's already there", async () => {
		await post("/__test/native", { pickTorrentFiles: [torrents.Album!.file] });
		await page.getByRole("button", { name: "Add torrent", exact: true }).click();
		const dialog = page.getByRole("dialog");
		await dialog.getByText("Already in your list.").waitFor();
		expect(await dialog.getByRole("button", { name: "Add and start" }).isDisabled()).toBe(true);
		await dialog.getByRole("button", { name: "Cancel" }).click();
		await dialog.waitFor({ state: "detached" });
	});
});

describe("managing torrents", () => {
	test("space pauses and resumes the selection", async () => {
		await row("Album").click();
		await page.keyboard.press("Space");
		await row("Album").locator(".col-status", { hasText: "Paused" }).waitFor();
		expect(await page.locator(".nav__item", { hasText: "Paused" }).locator(".nav__count").textContent()).not.toBe("0");
		await page.keyboard.press("Space");
		await row("Album").locator(".col-status", { hasText: "Seeding" }).waitFor();
	});

	test("the details drawer shows every tab with live data", async () => {
		await openDetails("Album");
		const drawer = page.locator(".drawer");
		await drawer.locator(".ov-progress__pct", { hasText: "100%" }).waitFor();
		expect(await drawer.getAttribute("aria-label")).toBe("Details of Album");
		await drawer.getByRole("img", { name: /^3 files; \d+ of \d+ pieces downloaded/ }).waitFor();

		await drawer.getByRole("tab", { name: /^Files/ }).click();
		await drawer.locator(".tree__row", { hasText: "one.bin" }).locator(".tree__pct", { hasText: "100%" }).waitFor();

		await drawer.getByRole("tab", { name: /^Trackers/ }).click();
		await drawer.getByText("No trackers.").waitFor();

		await drawer.getByRole("tab", { name: /^Pieces/ }).click();
		await drawer.locator(".stat", { hasText: "Verified" }).waitFor();
		const verified = await drawer.locator(".stat", { hasText: "Verified" }).locator(".stat__value").textContent();
		const [have, total] = verified!.split(" of ").map(Number);
		expect(have).toBe(total);
		expect(await drawer.locator("canvas.piece-map").count()).toBe(1);

		await drawer.getByRole("tab", { name: /^Peers/ }).click();
		await drawer.getByPlaceholder("Add a peer: 203.0.113.5:6881").waitFor();
	});

	test("a per-torrent limit is saved from the overview", async () => {
		await openDetails("Album");
		const drawer = page.locator(".drawer");
		await drawer.getByRole("tab", { name: "Overview" }).click();
		const field = drawer.getByLabel("Upload limit", { exact: true });
		await field.fill("2 MB");
		await field.press("Enter");
		await page.waitForTimeout(1200);
		const lib = JSON.parse(readFileSync(join(harnessState, "library.json"), "utf8")) as { name: string; uploadLimit: number }[];
		expect(lib.find((e) => e.name === "Album")!.uploadLimit).toBe(2_000_000);
	});

	test("the context menu copies the magnet link", async () => {
		await row("Album").click({ button: "right" });
		await page.getByRole("menuitem", { name: "Copy magnet link" }).click();
		await page.locator(".toast", { hasText: "Magnet link copied." }).waitFor();
		const copied = (await nativeLog()).filter((l) => l.kind === "writeClipboard").pop();
		expect(String(copied?.detail)).toStartWith(`magnet:?xt=urn:btih:${torrents.Album!.hash}`);
	});

	test("search and the sidebar filters narrow the list", async () => {
		await page.getByRole("button", { name: "Search", exact: true }).click();
		const palette = page.getByRole("dialog", { name: "Command palette" });
		await page.keyboard.type("tap");
		await palette.getByRole("option", { name: "Filter the list by “tap”" }).click();
		await palette.waitFor({ state: "detached" });
		await page.waitForTimeout(300);
		expect(await page.locator(".row").count()).toBe(1);
		await page.getByRole("button", { name: "Clear search" }).click();
		await page.locator(".nav__item", { hasText: "Paused" }).click();
		await page.waitForTimeout(500);
		expect(await page.locator(".row__name").allTextContents()).toEqual(["From Outside"]);
		await page.locator(".nav__item", { hasText: "All" }).click();
	});

	test("remove with files deletes the downloaded data", async () => {
		await row("Dropped").click();
		await page.keyboard.press("Delete");
		const dialog = page.getByRole("dialog", { name: "Remove torrent" });
		await dialog.getByText("Also delete the downloaded files").click();
		await dialog.getByRole("button", { name: "Remove and delete files" }).click();
		await row("Dropped").waitFor({ state: "detached" });
		await until("files deleted", () => !existsSync(join(harnessState, "downloads/Dropped")), 10);
	});
});

describe("creating torrents", () => {
	test("creates a torrent from a folder and seeds it straight away", async () => {
		writePayload(content, { "Made Here/a.txt": 10_000, "Made Here/b/c.txt": 20_000 });
		await post("/__test/native", { pickContent: join(content, "Made Here") });
		await page.getByRole("button", { name: "Create torrent" }).click();
		const dialog = page.getByRole("dialog", { name: "Create torrent" });
		await dialog.getByRole("button", { name: "Choose" }).click();
		await dialog.getByLabel("Comment").fill("made by the UI test");
		await dialog.getByRole("button", { name: "Create", exact: true }).click();
		const done = page.getByRole("dialog", { name: "Torrent created" });
		await done.getByText("Seeding now").waitFor({ timeout: 20_000 });
		expect(existsSync(join(content, "Made Here.torrent"))).toBe(true);
		await done.getByRole("button", { name: "Copy magnet link" }).click();
		await page.keyboard.press("Escape");
		await row("Made Here").locator(".col-status", { hasText: "Seeding" }).waitFor();
	});
});

describe("settings", () => {
	test("saving a rate limit applies it without restarting", async () => {
		await page.getByRole("button", { name: "Settings" }).click();
		await page.getByLabel("Download limit", { exact: true }).fill("20 MB");
		await page.getByText("You have unsaved changes.").waitFor();
		await page.getByRole("button", { name: "Save changes" }).click();
		await page.locator(".toast", { hasText: "Settings saved." }).waitFor();
		expect(JSON.parse(readFileSync(join(harnessState, "settings.json"), "utf8")).downloadLimit).toBe(20_000_000);
	});

	test("changing the port warns, restarts the engine and keeps the torrents", async () => {
		const port = 39000 + Math.floor(Math.random() * 1000);
		await page.getByLabel("Listening port").fill(String(port));
		await page.getByText("These changes restart the engine.").waitFor();
		await page.getByRole("button", { name: "Save changes" }).click();
		await page.locator(".toast", { hasText: "The engine restarted" }).waitFor();
		await page.locator(".status__health", { hasText: `Port ${port}` }).waitFor({ timeout: 10_000 });
		await page.getByRole("button", { name: "Torrents" }).click();
		await row("Album").locator(".col-status", { hasText: "Seeding" }).waitFor({ timeout: 15_000 });
	});

	test("makes Riptide the default app for torrents and magnet links", async () => {
		await page.getByRole("button", { name: "Settings" }).click();
		await page.getByText("Another app opens torrent files and magnet links.").waitFor();
		await page.getByRole("button", { name: "Make Riptide the default" }).click();
		await page.getByText("Riptide opens torrent files and magnet links.", { exact: true }).waitFor();
		expect(await page.getByRole("button", { name: "Make Riptide the default" }).count()).toBe(0);
		expect((await nativeLog()).some((e) => e.kind === "makeDefaultApp")).toBe(true);
		await page.getByRole("button", { name: "Torrents" }).click();
	});

	test("discard puts the saved values back", async () => {
		await page.getByRole("button", { name: "Settings" }).click();
		await page.getByLabel("Peers per torrent").fill("17");
		await page.locator(".savebar", { hasText: "restart the engine" }).waitFor();
		await page.getByRole("button", { name: "Discard" }).click();
		await page.locator(".savebar").waitFor({ state: "detached" });
		// The field follows the restored value after React's effects run
		const peers = await page.getByLabel("Peers per torrent").elementHandle();
		await page.waitForFunction((el) => (el as HTMLInputElement).value === "200", peers);
		await page.getByRole("button", { name: "Torrents" }).click();
	});

	test("startup calls that are lost or fail are asked again, so settings still load", async () => {
		// The app's RPC can lose calls made while it connects; the harness drops these on purpose
		await post("/__test/drop", { method: "getSettings", count: 2 });
		await post("/__test/drop", { method: "appInfo", count: 1, fail: true });
		await page.reload();
		await page.getByRole("button", { name: "Settings" }).click();
		await page.getByRole("status").filter({ hasText: "Reading settings" }).waitFor();
		await page.getByLabel("Download limit", { exact: true }).waitFor({ timeout: 15_000 });
		await page.getByText(/^Version 0\.1\.0/).waitFor();
		expect((await nativeLog()).filter((e) => e.kind === "dropped").length).toBe(3);
		await page.getByRole("button", { name: "Torrents" }).click();
	});
});

describe("palette, swarm, slow tide and the clipboard", () => {
	/** Calls the harness directly, as another program would (the clipboard, for one). */
	const rpc = (method: string, params: unknown) =>
		page.evaluate(
			async ([m, p]) => {
				const ws = new WebSocket(`ws://${location.host}/rpc`);
				await new Promise((r) => ws.addEventListener("open", r));
				ws.send(JSON.stringify({ id: 1, method: m, params: p }));
				await new Promise((r) => ws.addEventListener("message", r));
				ws.close();
			},
			[method, params] as const,
		);

	test("the palette finds a torrent by a fuzzy name and jumps to it", async () => {
		await page
			.locator(".list")
			.click({ position: { x: 5, y: 400 } })
			.catch(() => {});
		await page.keyboard.press("Escape");
		await page.keyboard.press("Meta+k");
		const palette = page.getByRole("dialog", { name: "Command palette" });
		await palette.waitFor();
		await page.keyboard.type("albm");
		await palette.getByRole("option", { selected: true }).filter({ hasText: "Album" }).waitFor();
		await page.keyboard.press("Enter");
		await palette.waitFor({ state: "detached" });
		await row("Album").and(page.locator(".is-selected")).waitFor();
		expect(await page.locator(".drawer").getAttribute("aria-label")).toBe("Details of Album");
	});

	test("the palette finds a setting and shows it in settings", async () => {
		await page.keyboard.press("Meta+k");
		const palette = page.getByRole("dialog", { name: "Command palette" });
		await palette.waitFor();
		await page.keyboard.type("half open");
		await palette.getByRole("option", { selected: true }).filter({ hasText: "Connection attempts at once" }).waitFor();
		await page.keyboard.press("Enter");
		await palette.waitFor({ state: "detached" });
		await page.locator('[data-setting="maxHalfOpen"].is-found').waitFor();
		await page.getByRole("button", { name: "Torrents" }).click();
	});

	test("the palette switches slow tide on; the status bar switches it off", async () => {
		await page.keyboard.press("Meta+k");
		await page.keyboard.type("slow tide");
		await page.getByRole("option", { selected: true }).filter({ hasText: "Switch slow tide on" }).waitFor();
		await page.keyboard.press("Enter");
		const sw = page.locator(".tide-switch");
		await page.locator(".tide-switch.is-on").waitFor();
		expect(JSON.parse(readFileSync(join(harnessState, "settings.json"), "utf8")).slowTide).toBe(true);
		await sw.click();
		await page.locator(".tide-switch:not(.is-on)").waitFor();
		expect(JSON.parse(readFileSync(join(harnessState, "settings.json"), "utf8")).slowTide).toBe(false);
	});

	test("the swarm tab draws the live peer map", async () => {
		await openDetails("Album");
		const drawer = page.locator(".drawer");
		await drawer.getByRole("tab", { name: "Swarm" }).click();
		await drawer.locator("canvas.swarm__field").waitFor();
		expect(await drawer.locator("canvas.swarm__field").getAttribute("aria-label")).toMatch(/^The swarm: \d+ peers/);
		await drawer.getByText("Distance is round trip").waitFor();
	});

	test("a slow tide schedule is painted hour by hour and saved", async () => {
		await page.getByRole("button", { name: "Settings" }).click();
		await page.getByText("Follow a schedule").click();
		const grid = page.getByRole("group", { name: "Slow tide hours" });
		await grid.waitFor();
		expect(await grid.locator(".week__cell.is-on").count()).toBe(45);
		await grid.locator('[data-hour="130"]').click();
		expect(await grid.locator(".week__cell.is-on").count()).toBe(46);
		await page.getByRole("button", { name: "Save changes" }).click();
		await page.locator(".toast", { hasText: "Settings saved." }).waitFor();
		const saved = JSON.parse(readFileSync(join(harnessState, "settings.json"), "utf8"));
		expect(saved.slowSchedule).toBe(true);
		expect(saved.slowHours.filter(Boolean).length).toBe(46);
		expect(saved.slowHours[130]).toBe(true);
	});

	test("the VPN lock lists interfaces, without loopback", async () => {
		const select = page.getByLabel("Lock connections to");
		await select.waitFor();
		const options = await select.locator("option").allTextContents();
		expect(options[0]).toBe("Any interface (no lock)");
		expect(options.some((o) => o.startsWith("lo"))).toBe(false);
		await page.getByRole("button", { name: "Torrents" }).click();
	});

	test("a magnet link copied elsewhere is offered when the window comes back", async () => {
		const uri = `magnet:?xt=urn:btih:${"5d".repeat(20)}&dn=Copied%20Elsewhere`;
		await rpc("writeClipboard", { text: `see ${uri} for it` });
		await page.evaluate(() => window.dispatchEvent(new Event("focus")));
		const offer = page.locator(".toast", { hasText: "Magnet link on the clipboard: Copied Elsewhere" });
		await offer.waitFor();
		await offer.getByRole("button", { name: "Add" }).click();
		await page.getByRole("dialog", { name: "Add torrent" }).waitFor();
		await page.keyboard.press("Escape");

		// Offered once only
		await page.evaluate(() => window.dispatchEvent(new Event("focus")));
		await page.waitForTimeout(800);
		expect(await page.locator(".toast", { hasText: "Magnet link on the clipboard" }).count()).toBe(0);
	});
});

describe("resilience", () => {
	test("the UI reports an engine crash and recovers when it restarts", async () => {
		const procs = Bun.spawnSync(["pgrep", "-f", "--", `undercurrentd --state-dir ${harnessState}`])
			.stdout.toString()
			.trim()
			.split("\n")
			.filter(Boolean)
			.map(Number);
		expect(procs.length).toBe(1);
		process.kill(procs[0]!, "SIGKILL");
		await page.locator(".status__health.is-error").waitFor({ timeout: 5000 });
		await page.locator(".status__health:not(.is-error)", { hasText: "Port" }).waitFor({ timeout: 15_000 });
		await row("Album").waitFor();
	});

	test("no errors reached the page's console", () => {
		expect(errors).toEqual([]);
	});
});
