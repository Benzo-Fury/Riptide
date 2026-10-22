/**
 * The UI's line to the main process. Inside Electrobun it uses the webview RPC; in a browser
 * (the test harness) a WebSocket carrying the same call/push messages. Everything else in the
 * UI goes through `call` and `onPush` and never knows which.
 */

import type { ApiMethod, ApiParams, ApiResult, Push, PushName, WirePush } from "../../shared/types";

type PushListener = (data: unknown) => void;
type Transport = (method: ApiMethod, params: unknown) => Promise<unknown>;

const listeners = new Map<PushName, Set<PushListener>>();

/** Hands a push to its listeners. */
function dispatch({ name, data }: WirePush): void {
	for (const fn of listeners.get(name) ?? []) fn(data);
}

/** Whether the UI runs inside the Electrobun app (rather than the browser harness). */
export const inApp = typeof window !== "undefined" && (window as { __electrobunWebviewId?: number }).__electrobunWebviewId !== undefined;

/** Connects to Electrobun's RPC. */
async function electrobunTransport(): Promise<Transport> {
	const { default: Electrobun, Electroview } = await import("electrobun/view");
	const rpc = Electroview.defineRPC<{
		bun: { requests: { api: { params: { method: ApiMethod; params: unknown }; response: unknown } }; messages: {} };
		webview: { requests: {}; messages: { push: WirePush } };
	}>({
		maxRequestTime: 60 * 60 * 1000,
		handlers: { requests: {}, messages: { push: dispatch } },
	});
	const view = new Electrobun.Electroview({ rpc });
	// Not `request.call`, which is Function.prototype.call on Electrobun's proxy (see bun/index.ts)
	return (method, params) => view.rpc!.request.api({ method, params });
}

/** Connects to the harness's WebSocket, reconnecting if it drops. */
function socketTransport(): Transport {
	const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	let nextId = 1;
	let socket: WebSocket;
	let open: Promise<void>;

	// (Re)open the socket and route its messages
	const connect = () => {
		socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/rpc`);
		open = new Promise((resolve) => socket.addEventListener("open", () => resolve(), { once: true }));
		socket.addEventListener("message", (e) => {
			const msg = JSON.parse(String(e.data));
			if (msg.type === "push") dispatch(msg);
			else if (msg.type === "response") {
				const p = pending.get(msg.id);
				pending.delete(msg.id);
				if (msg.ok) p?.resolve(msg.result);
				else p?.reject(new Error(msg.error));
			}
		});
		socket.addEventListener("close", () => {
			for (const p of pending.values()) p.reject(new Error("Lost the connection to Riptide."));
			pending.clear();
			setTimeout(connect, 500);
		});
	};
	connect();

	return async (method, params) => {
		await open;
		const id = nextId++;
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject });
			socket.send(JSON.stringify({ id, method, params }));
		});
	};
}

const transport: Promise<Transport> = inApp ? electrobunTransport() : Promise.resolve(socketTransport());

/** Calls the main process. Rejects with an Error whose message is fit to show the user. */
export async function call<M extends ApiMethod>(method: M, ...params: ApiParams<M> extends void ? [] : [ApiParams<M>]): Promise<ApiResult<M>> {
	const send = await transport;
	try {
		return (await send(method, params[0] ?? null)) as ApiResult<M>;
	} catch (e) {
		throw e instanceof Error ? e : new Error(String(e));
	}
}

/** Listens for a push from the main process. Returns the unsubscribe function. */
export function onPush<N extends PushName>(name: N, fn: (data: Push[N]) => void): () => void {
	const set = listeners.get(name) ?? new Set();
	set.add(fn as PushListener);
	listeners.set(name, set);
	return () => set.delete(fn as PushListener);
}
