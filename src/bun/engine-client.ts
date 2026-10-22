/**
 * Runs the undercurrentd engine process and talks to it over its JSON-lines protocol.
 *
 * undercurrentd reads requests on stdin and writes responses and events on stdout. It exits when its
 * stdin closes, so it can never outlive this process. If it crashes, EngineClient restarts it
 * with a backoff; undercurrentd's library and resume state bring every torrent back as it was.
 */

import type { Subprocess } from "bun";
import type { EngineStatus } from "../shared/types";

// ---------- Types ---------- //

/** An undercurrentd event: `ready`, `snapshot`, `torrent` or `warning`. */
export type EngineEventHandler = (name: string, data: unknown) => void;

export interface EngineClientOptions {
	/** Path to the undercurrentd binary. */
	binary: string;
	/** undercurrentd's state directory: settings, library, saved torrents, resume files. */
	stateDir: string;
	onEvent: EngineEventHandler;
	onStatus?: (status: EngineStatus) => void;
	/** Where undercurrentd's stderr and lifecycle messages go. */
	log?: (line: string) => void;
}

/** A request waiting for its response line. */
interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout> | null;
}

/** Thrown for requests that fail; `message` is undercurrentd's sentence, fit to show the user. */
export class EngineError extends Error {}

/** Default time a request may take before it's abandoned. `create` hashes and is exempt. */
const REQUEST_TIMEOUT_MS = 30_000;

/** How long undercurrentd gets to send `ready` after starting. */
const READY_TIMEOUT_MS = 20_000;

/** Restarts allowed within `RESTART_WINDOW_MS` before giving up. */
const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 60_000;

// ---------- Client ---------- //

/** One undercurrentd process and the requests in flight to it. */
export class EngineClient {
	private proc: Subprocess<"pipe", "pipe", "pipe"> | null = null;
	private pending = new Map<number, Pending>();
	private nextId = 1;
	private stopping = false;
	private restartTimes: number[] = [];
	private restarts = 0;
	private lastError: string | null = null;
	/** Resolves when the current process has sent `ready`. */
	private ready: Promise<void> = Promise.resolve();
	/** The version undercurrentd reported in its `ready` event. */
	version: string | null = null;

	constructor(private readonly options: EngineClientOptions) {}

	/** Starts undercurrentd and waits for it to be ready. */
	async start(): Promise<void> {
		this.stopping = false;
		this.spawn();
		await this.ready;
	}

	/** Whether an undercurrentd process is running. */
	get running(): boolean {
		return this.proc !== null && this.proc.exitCode === null;
	}

	status(): EngineStatus {
		return { running: this.running, error: this.lastError, restarts: this.restarts };
	}

	/**
	 * Sends one request and resolves with its result. Rejects with an `EngineError` carrying
	 * undercurrentd's message, or when the process dies or the timeout passes (`timeoutMs: 0` waits
	 * forever).
	 */
	async request<T = unknown>(method: string, params?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
		// Wait for a starting process before writing to it
		await this.ready;
		const proc = this.proc;
		if (!proc || proc.exitCode !== null) {
			throw new EngineError(this.lastError ?? "The engine isn't running.");
		}

		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			// Register before writing so a fast reply finds its entry
			const timer =
				timeoutMs > 0
					? setTimeout(() => {
							this.pending.delete(id);
							reject(new EngineError(`The engine didn't answer "${method}" in time.`));
						}, timeoutMs)
					: null;
			this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });

			// Write the request line
			try {
				proc.stdin.write(`${JSON.stringify({ id, method, params: params ?? null })}\n`);
				proc.stdin.flush();
			} catch (e) {
				this.settle(id, new EngineError(`Couldn't reach the engine: ${String(e)}`));
			}
		});
	}

	/**
	 * Asks undercurrentd to save everything and exit, then waits for it (killing it after
	 * `graceMs`). Torrents are paused by the shutdown, which writes their resume state.
	 */
	async stop(graceMs = 8_000): Promise<void> {
		this.stopping = true;
		const proc = this.proc;
		if (!proc || proc.exitCode !== null) return;

		// Ask nicely, then insist
		await this.request("shutdown", null, graceMs).catch(() => {});
		try {
			proc.stdin.end();
		} catch {
			// Already closed
		}
		const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(graceMs).then(() => false)]);
		if (!exited) proc.kill("SIGKILL");
	}

	// ---------- Process ---------- //

	/** Spawns undercurrentd and wires up its output. `ready` resolves on its ready event. */
	private spawn(): void {
		const { binary, stateDir } = this.options;
		this.log(`starting ${binary}`);

		// Promise settled by the ready event or a startup failure
		let markReady!: () => void;
		let failReady!: (e: Error) => void;
		this.ready = new Promise<void>((resolve, reject) => {
			markReady = resolve;
			failReady = reject;
		});
		const readyTimer = setTimeout(() => failReady(new EngineError("The engine took too long to start.")), READY_TIMEOUT_MS);
		this.ready.catch(() => {}).finally(() => clearTimeout(readyTimer));

		// Start the process
		let proc: Subprocess<"pipe", "pipe", "pipe">;
		try {
			proc = Bun.spawn([binary, "--state-dir", stateDir], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
		} catch (e) {
			this.lastError = `The engine couldn't start: ${String(e)}`;
			failReady(new EngineError(this.lastError));
			this.emitStatus();
			return;
		}
		this.proc = proc;

		// Route stdout lines; the ready event releases waiting requests
		this.readLines(proc.stdout, (line) =>
			this.onLine(line, () => {
				this.lastError = null;
				markReady();
				this.emitStatus();
			}),
		);
		this.readLines(proc.stderr, (line) => this.log(`undercurrentd: ${line}`));

		// React to the process ending
		proc.exited.then((code) => {
			if (this.proc !== proc) return;
			this.proc = null;
			failReady(new EngineError(`The engine stopped while starting (exit ${code}).`));
			this.failAll(new EngineError("The engine stopped."));
			if (!this.stopping) this.onCrash(code);
		});
	}

	/** Restarts after an unexpected exit, unless it keeps happening. */
	private onCrash(code: number | null): void {
		this.lastError = `The engine stopped unexpectedly (exit ${code}).`;
		this.log(this.lastError);

		// Give up after too many crashes in a short time
		const now = Date.now();
		this.restartTimes = this.restartTimes.filter((t) => now - t < RESTART_WINDOW_MS);
		if (this.restartTimes.length >= MAX_RESTARTS) {
			this.lastError = "The engine keeps stopping. Quit and reopen Riptide; if it continues, check the logs.";
			this.emitStatus();
			return;
		}
		this.restartTimes.push(now);
		this.restarts++;
		this.emitStatus();

		// Back off a little more each time
		const delay = 250 * 2 ** (this.restartTimes.length - 1);
		setTimeout(() => {
			if (!this.stopping) this.spawn();
		}, delay);
	}

	/** Handles one stdout line: a response settles its request; an event goes to the handler. */
	private onLine(line: string, onReady: () => void): void {
		let msg: { type: string; id?: number; ok?: boolean; result?: unknown; error?: string; name?: string; data?: unknown };
		try {
			msg = JSON.parse(line);
		} catch {
			this.log(`undercurrentd: unreadable output: ${line.slice(0, 200)}`);
			return;
		}

		// Responses
		if (msg.type === "response" && typeof msg.id === "number") {
			this.settle(msg.id, msg.ok ? undefined : new EngineError(msg.error ?? "The engine reported an error."), msg.result);
			return;
		}

		// Events
		if (msg.type === "event" && msg.name) {
			if (msg.name === "ready") {
				this.version = (msg.data as { version?: string })?.version ?? null;
				onReady();
			}
			this.options.onEvent(msg.name, msg.data);
		}
	}

	/** Resolves or rejects a pending request. */
	private settle(id: number, error?: Error, result?: unknown): void {
		const p = this.pending.get(id);
		if (!p) return;
		this.pending.delete(id);
		if (p.timer) clearTimeout(p.timer);
		if (error) p.reject(error);
		else p.resolve(result ?? null);
	}

	private failAll(error: Error): void {
		for (const id of [...this.pending.keys()]) this.settle(id, error);
	}

	/** Splits a byte stream into lines. */
	private async readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
		const decoder = new TextDecoder();
		let buffered = "";
		const reader = stream.getReader();
		try {
			for (;;) {
				const { value: chunk, done } = await reader.read();
				if (done) break;
				buffered += decoder.decode(chunk, { stream: true });
				let nl = buffered.indexOf("\n");
				while (nl >= 0) {
					const line = buffered.slice(0, nl).trim();
					buffered = buffered.slice(nl + 1);
					if (line) onLine(line);
					nl = buffered.indexOf("\n");
				}
			}
		} catch {
			// The process ended; exited handles it
		}
	}

	private emitStatus(): void {
		this.options.onStatus?.(this.status());
	}

	private log(line: string): void {
		this.options.log?.(line);
	}
}
