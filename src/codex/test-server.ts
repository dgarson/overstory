// src/codex/test-server.ts
// Reusable mock Codex App Server for integration tests.
// Speaks JSON-RPC 2.0 over WebSocket using Bun.serve().
//
// WHY a real WebSocket server (not mocked): The bridge's core value is
// its JSON-RPC 2.0 protocol handling over WebSocket. Mocking the transport
// would skip the very thing we need to test.

import type { ServerWebSocket } from "bun";

interface JsonRpcMessage {
	jsonrpc: "2.0";
	id?: number | string;
	method?: string;
	params?: Record<string, unknown>;
	result?: unknown;
	error?: { code: number; message: string };
}

interface ReceivedRequest {
	id: number | string;
	method: string;
	params?: Record<string, unknown>;
}

interface PendingServerRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface RequestWaiter {
	method: string;
	resolve: (req: ReceivedRequest) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export interface MockCodexServer {
	/** The WebSocket URL to connect to (ws://127.0.0.1:{port}) */
	url: string;
	/** The port the server is listening on */
	port: number;
	/** Send a JSON-RPC notification to all connected clients */
	notify(method: string, params: Record<string, unknown>): void;
	/**
	 * Schedule a JSON-RPC notification to all connected clients via setTimeout.
	 * This is necessary because Bun's ServerWebSocket.send() from within
	 * an async continuation (e.g., after await) may not be delivered to the
	 * client-side WebSocket message handler. Using setTimeout(fn, delay)
	 * ensures the send happens in a macrotask that Bun dispatches correctly.
	 */
	notifyLater(method: string, params: Record<string, unknown>, delayMs?: number): Promise<void>;
	/** Send a JSON-RPC request (with id) to a connected client and wait for response */
	request(method: string, params: Record<string, unknown>): Promise<unknown>;
	/** Get all RPC requests received from the bridge (method + params) */
	getReceivedRequests(): Array<{ method: string; params?: Record<string, unknown> }>;
	/** Wait until a specific RPC method is received from the bridge */
	waitForRequest(
		method: string,
		timeoutMs?: number,
	): Promise<{ id: number | string; params?: Record<string, unknown> }>;
	/** Number of connected WebSocket clients */
	clientCount: number;
	/** Shut down the server and close all connections */
	close(): Promise<void>;
}

/**
 * Create a mock Codex App Server for testing.
 *
 * Uses Bun.serve() with WebSocket support. Picks a random port.
 * Auto-responds to thread/start, turn/start, and turn/steer requests
 * from clients.
 */
export async function createMockCodexServer(): Promise<MockCodexServer> {
	const clients = new Set<ServerWebSocket<unknown>>();
	const receivedRequests: ReceivedRequest[] = [];
	const pendingServerRequests = new Map<number, PendingServerRequest>();
	const requestWaiters: RequestWaiter[] = [];
	let serverNextId = 100_000; // High base to avoid collisions with client IDs

	const server = Bun.serve({
		port: 0, // Random available port
		fetch(req, server) {
			if (server.upgrade(req)) {
				return undefined;
			}
			return new Response("Not found", { status: 404 });
		},
		websocket: {
			open(ws) {
				clients.add(ws);
			},
			close(ws) {
				clients.delete(ws);
			},
			message(ws, message) {
				const text = typeof message === "string" ? message : new TextDecoder().decode(message);
				let data: JsonRpcMessage;
				try {
					data = JSON.parse(text) as JsonRpcMessage;
				} catch {
					return;
				}

				const hasId = data.id != null;
				const hasMethod = typeof data.method === "string";

				// Client response to a server-initiated request (has id, has result/error, no method)
				if (hasId && !hasMethod) {
					const pending = pendingServerRequests.get(data.id as number);
					if (pending) {
						pendingServerRequests.delete(data.id as number);
						clearTimeout(pending.timer);
						if (data.error) {
							pending.reject(new Error(data.error.message));
						} else {
							pending.resolve(data.result);
						}
					}
					return;
				}

				// Client request (has id and method)
				if (hasId && hasMethod) {
					const req: ReceivedRequest = {
						id: data.id as number | string,
						method: data.method as string,
						params: data.params,
					};
					receivedRequests.push(req);

					// Notify waiters
					for (let i = requestWaiters.length - 1; i >= 0; i--) {
						const waiter = requestWaiters[i];
						if (waiter && waiter.method === req.method) {
							clearTimeout(waiter.timer);
							waiter.resolve(req);
							requestWaiters.splice(i, 1);
						}
					}

					// Auto-respond based on method
					handleClientRequest(ws, req);
				}
			},
		},
	});

	function handleClientRequest(ws: ServerWebSocket<unknown>, req: ReceivedRequest): void {
		const method = req.method;

		if (method === "initialize") {
			sendResponse(ws, req.id, { ok: true });
			return;
		}

		if (method === "thread/start") {
			const threadId = `test-thread-${Math.random().toString(36).slice(2, 8)}`;
			sendResponse(ws, req.id, { threadId });
			return;
		}

		if (method === "turn/start") {
			const turnId = `test-turn-${Math.random().toString(36).slice(2, 8)}`;
			sendResponse(ws, req.id, { turnId });

			// After a short delay, emit turn/started notification.
			// Uses setTimeout to ensure delivery via macrotask.
			const threadId = (req.params?.threadId as string | undefined) ?? "unknown-thread";
			setTimeout(() => {
				sendNotificationToAll("turn/started", { threadId, turnId });
			}, 30);
			return;
		}

		if (method === "turn/steer") {
			sendResponse(ws, req.id, { ok: true });
			return;
		}

		if (method === "approval/respond") {
			sendResponse(ws, req.id, { ok: true });
			return;
		}

		// Default: respond with null result
		sendResponse(ws, req.id, null);
	}

	function sendResponse(ws: ServerWebSocket<unknown>, id: number | string, result: unknown): void {
		ws.send(
			JSON.stringify({
				jsonrpc: "2.0",
				id,
				result,
			}),
		);
	}

	function sendNotificationToAll(method: string, params: Record<string, unknown>): void {
		const msg = JSON.stringify({
			jsonrpc: "2.0",
			method,
			params,
		});
		for (const ws of clients) {
			ws.send(msg);
		}
	}

	const port = server.port ?? 0;
	if (port === 0) {
		throw new Error("Mock server failed to bind to a port");
	}

	return {
		url: `ws://127.0.0.1:${port}`,
		port,

		notify(method: string, params: Record<string, unknown>): void {
			sendNotificationToAll(method, params);
		},

		notifyLater(method: string, params: Record<string, unknown>, delayMs = 10): Promise<void> {
			return new Promise((resolve) => {
				setTimeout(() => {
					sendNotificationToAll(method, params);
					resolve();
				}, delayMs);
			});
		},

		request(method: string, params: Record<string, unknown>): Promise<unknown> {
			return new Promise((resolve, reject) => {
				const id = serverNextId++;
				const timer = setTimeout(() => {
					pendingServerRequests.delete(id);
					reject(new Error(`Server request timeout: ${method}`));
				}, 10_000);

				pendingServerRequests.set(id, { resolve, reject, timer });

				const msg = JSON.stringify({
					jsonrpc: "2.0",
					id,
					method,
					params,
				});
				for (const ws of clients) {
					ws.send(msg);
					break; // Send to first connected client only
				}
			});
		},

		getReceivedRequests(): Array<{ method: string; params?: Record<string, unknown> }> {
			return receivedRequests.map((r) => ({ method: r.method, params: r.params }));
		},

		waitForRequest(
			method: string,
			timeoutMs = 5000,
		): Promise<{ id: number | string; params?: Record<string, unknown> }> {
			// Check if already received
			const existing = receivedRequests.find((r) => r.method === method);
			if (existing) {
				return Promise.resolve({ id: existing.id, params: existing.params });
			}

			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					const idx = requestWaiters.findIndex((w) => w.resolve === resolve);
					if (idx !== -1) {
						requestWaiters.splice(idx, 1);
					}
					reject(new Error(`Timeout waiting for request: ${method} (waited ${timeoutMs}ms)`));
				}, timeoutMs);

				requestWaiters.push({ method, resolve, reject, timer });
			});
		},

		get clientCount(): number {
			return clients.size;
		},

		async close(): Promise<void> {
			// Clean up pending requests
			for (const [, pending] of pendingServerRequests) {
				clearTimeout(pending.timer);
				pending.reject(new Error("Server closing"));
			}
			pendingServerRequests.clear();

			// Clean up waiters
			for (const waiter of requestWaiters) {
				clearTimeout(waiter.timer);
				waiter.reject(new Error("Server closing"));
			}
			requestWaiters.length = 0;

			// Close all client connections
			for (const ws of clients) {
				ws.close();
			}
			clients.clear();

			server.stop(true);

			// Small delay to let the WebSocket close frames propagate
			await Bun.sleep(50);
		},
	};
}
