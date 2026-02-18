// src/codex/rpc-client.ts
import type { JsonRpcRequest } from "./types";

/** Handler for server-initiated requests. Returns the result to send back. */
export type RequestHandler = (method: string, params: unknown) => Promise<unknown> | unknown;

export interface RpcClient {
	request(method: string, params?: Record<string, unknown>): Promise<unknown>;
	onNotification(handler: (method: string, params: unknown) => void): void;
	/** Register a handler for server-initiated requests (has id + method) */
	onRequest(handler: RequestHandler): void;
	/** Whether the WebSocket connection has been closed */
	readonly closed: boolean;
	close(): void;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export async function createRpcClient(
	url: string,
	opts?: { timeoutMs?: number },
): Promise<RpcClient> {
	const timeoutMs = opts?.timeoutMs ?? 30_000;
	let nextId = 1;
	const pending = new Map<number | string, PendingRequest>();
	const notificationHandlers: Array<(method: string, params: unknown) => void> = [];
	const requestHandlers: RequestHandler[] = [];

	let isClosed = false;
	const ws = new WebSocket(url);

	// Wait for connection
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("WebSocket connection timeout")), 10_000);
		ws.addEventListener("open", () => {
			clearTimeout(timeout);
			resolve();
		});
		ws.addEventListener("error", (e) => {
			clearTimeout(timeout);
			reject(new Error(`WebSocket connection failed: ${String(e)}`));
		});
	});

	// Handle unexpected connection loss after initial connect
	ws.addEventListener("close", () => {
		isClosed = true;
		for (const [, req] of pending) {
			clearTimeout(req.timer);
			req.reject(new Error("WebSocket closed"));
		}
		pending.clear();
	});

	ws.addEventListener("error", () => {
		// Error events after connection are often followed by close events.
		// The close handler above handles cleanup; this prevents unhandled errors.
	});

	ws.addEventListener("message", (event) => {
		const data = JSON.parse(String(event.data)) as Record<string, unknown>;

		const hasId = "id" in data && data.id != null;
		const hasMethod = "method" in data && typeof data.method === "string";

		// Server-initiated request (has BOTH id and method).
		// Must be checked BEFORE responses since both have an id field.
		if (hasId && hasMethod) {
			const incomingId = data.id as number | string;
			const method = data.method as string;

			// Dispatch to request handlers and send response.
			// Break on first handler that returns a non-nullish result.
			(async () => {
				try {
					let result: unknown;
					for (const handler of requestHandlers) {
						const handlerResult = await handler(method, data.params);
						if (handlerResult !== null && handlerResult !== undefined) {
							result = handlerResult;
							break;
						}
					}
					ws.send(
						JSON.stringify({
							jsonrpc: "2.0",
							id: incomingId,
							result: result ?? null,
						}),
					);
				} catch (err) {
					ws.send(
						JSON.stringify({
							jsonrpc: "2.0",
							id: incomingId,
							error: {
								code: -32603,
								message: err instanceof Error ? err.message : "Internal error",
							},
						}),
					);
				}
			})().catch((err: unknown) => {
				console.error("[rpc-client] request handler error:", err);
			});

			// Also dispatch to notification handlers for observability
			// (the bridge's notification handler can still see these events)
			for (const handler of notificationHandlers) {
				handler(method, data.params);
			}
			return;
		}

		// Response to our outgoing request (has id, no method)
		if (hasId && !hasMethod) {
			const req = pending.get(data.id as number | string);
			if (!req) return;
			pending.delete(data.id as number | string);
			clearTimeout(req.timer);
			if (data.error) {
				const err = data.error as { message?: string };
				req.reject(new Error(err.message ?? "JSON-RPC error"));
			} else {
				req.resolve(data.result);
			}
			return;
		}

		// Notification (no id, has method)
		if (hasMethod) {
			for (const handler of notificationHandlers) {
				handler(data.method as string, data.params);
			}
		}
	});

	return {
		request(method, params) {
			if (isClosed) {
				return Promise.reject(new Error(`WebSocket closed, cannot send: ${method}`));
			}
			return new Promise((resolve, reject) => {
				const id = nextId++;
				const timer = setTimeout(() => {
					pending.delete(id);
					reject(new Error(`RPC timeout: ${method}`));
				}, timeoutMs);

				pending.set(id, { resolve, reject, timer });

				const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method };
				if (params) msg.params = params;
				ws.send(JSON.stringify(msg));
			});
		},

		onNotification(handler) {
			notificationHandlers.push(handler);
		},

		onRequest(handler) {
			requestHandlers.push(handler);
		},

		get closed() {
			return isClosed;
		},

		close() {
			isClosed = true;
			for (const [, req] of pending) {
				clearTimeout(req.timer);
				req.reject(new Error("Client closed"));
			}
			pending.clear();
			ws.close();
		},
	};
}
