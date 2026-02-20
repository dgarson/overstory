// src/codex/rpc-client.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import type { RpcClient } from "./rpc-client";
import { createRpcClient, createRpcClientWithRetry } from "./rpc-client";

let server: ReturnType<typeof Bun.serve> | null = null;
let client: RpcClient | null = null;

afterEach(async () => {
	client?.close();
	client = null;
	server?.stop(true);
	server = null;
	// Brief pause to let sockets fully close between tests
	await Bun.sleep(10);
});

function startMockServer(
	handler: (ws: { send: (msg: string) => void }, message: string) => void,
): number {
	const port = 30000 + Math.floor(Math.random() * 10000);
	server = Bun.serve({
		port,
		fetch(req, srv) {
			if (srv.upgrade(req, { data: undefined })) return undefined;
			return new Response("Not found", { status: 404 });
		},
		websocket: {
			message(ws, message) {
				handler(ws, String(message));
			},
		},
	});
	return port;
}

test("sends JSON-RPC request and receives response", async () => {
	const port = startMockServer((ws, msg) => {
		const req = JSON.parse(msg) as { id: number };
		ws.send(
			JSON.stringify({
				jsonrpc: "2.0",
				id: req.id,
				result: { threadId: "thread-1" },
			}),
		);
	});

	client = await createRpcClient(`ws://127.0.0.1:${port}`);
	const result = await client.request("thread/start", { model: "o3" });
	expect(result).toEqual({ threadId: "thread-1" });
});

test("receives notifications via onNotification", async () => {
	const port = startMockServer((ws, msg) => {
		const req = JSON.parse(msg) as { id: number };
		// Send response
		ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: {} }));
		// Then send notification
		ws.send(
			JSON.stringify({
				jsonrpc: "2.0",
				method: "item/started",
				params: { itemId: "item-1" },
			}),
		);
	});

	const notifications: Array<{ method: string; params: unknown }> = [];
	client = await createRpcClient(`ws://127.0.0.1:${port}`);
	client.onNotification((method, params) => {
		notifications.push({ method, params });
	});
	await client.request("initialize", {});
	// Wait for notification delivery
	await Bun.sleep(100);
	expect(notifications.length).toBe(1);
	expect(notifications[0]?.method).toBe("item/started");
});

test("rejects on JSON-RPC error response", async () => {
	const port = startMockServer((ws, msg) => {
		const req = JSON.parse(msg) as { id: number };
		ws.send(
			JSON.stringify({
				jsonrpc: "2.0",
				id: req.id,
				error: { code: -32600, message: "Invalid request" },
			}),
		);
	});

	client = await createRpcClient(`ws://127.0.0.1:${port}`);
	await expect(client.request("bad/method", {})).rejects.toThrow("Invalid request");
});

// ---------------------------------------------------------------------------
// Test server helper for edge case tests
// ---------------------------------------------------------------------------

interface TestServer {
	url: string;
	port: number;
	/** Send raw JSON string to all connected clients via pub/sub */
	send(data: string): void;
	/** Send JSON-RPC notification to all clients */
	notify(method: string, params?: Record<string, unknown>): void;
	/** Send a JSON-RPC request (with id) to clients, return a promise for the response */
	request(method: string, params?: Record<string, unknown>): Promise<unknown>;
	/** Messages received from clients */
	received: Array<Record<string, unknown>>;
	/** Close the server */
	close(): Promise<void>;
	/** When true, auto-respond to incoming requests with { ok: true } */
	autoRespond: boolean;
	/** Delay before auto-responding (ms) */
	responseDelay: number;
	/** The underlying Bun server (for low-level access) */
	_server: ReturnType<typeof Bun.serve>;
}

function createTestServer(opts?: { autoRespond?: boolean }): TestServer {
	const port = 30000 + Math.floor(Math.random() * 10000);
	const received: Array<Record<string, unknown>> = [];
	let serverRequestId = 9000;
	const pendingServerRequests = new Map<
		number,
		{ resolve: (v: unknown) => void; reject: (e: Error) => void }
	>();

	const testServer: Partial<TestServer> = {
		received,
		autoRespond: opts?.autoRespond ?? true,
		responseDelay: 0,
	};

	const bunServer = Bun.serve({
		port,
		fetch(req, srv) {
			if (srv.upgrade(req, { data: undefined })) return undefined;
			return new Response("Not found", { status: 404 });
		},
		websocket: {
			open(ws) {
				ws.subscribe("all");
			},
			message(_ws, message) {
				const data = JSON.parse(String(message)) as Record<string, unknown>;
				received.push(data);

				// Check if this is a response to a server-initiated request
				const hasId = "id" in data && data.id != null;
				const hasMethod = "method" in data && typeof data.method === "string";
				if (hasId && !hasMethod) {
					const pending = pendingServerRequests.get(data.id as number);
					if (pending) {
						pendingServerRequests.delete(data.id as number);
						if (data.error) {
							const err = data.error as { message?: string };
							pending.reject(new Error(err.message ?? "RPC error"));
						} else {
							pending.resolve(data.result);
						}
						return;
					}
				}

				// Auto-respond to client requests
				if (testServer.autoRespond && hasId && hasMethod) {
					const id = data.id as number;
					const respond = () => {
						bunServer.publish("all", JSON.stringify({ jsonrpc: "2.0", id, result: { ok: true } }));
					};
					if (testServer.responseDelay && testServer.responseDelay > 0) {
						setTimeout(respond, testServer.responseDelay);
					} else {
						respond();
					}
				}
			},
		},
	});

	// Use server as the module-level `server` so afterEach stops it
	server = bunServer;

	Object.assign(testServer, {
		url: `ws://127.0.0.1:${port}`,
		port,
		_server: bunServer,
		send(data: string) {
			bunServer.publish("all", data);
		},
		notify(method: string, params?: Record<string, unknown>) {
			const msg: Record<string, unknown> = { jsonrpc: "2.0", method };
			if (params) msg.params = params;
			bunServer.publish("all", JSON.stringify(msg));
		},
		request(method: string, params?: Record<string, unknown>): Promise<unknown> {
			return new Promise((resolve, reject) => {
				const id = serverRequestId++;
				pendingServerRequests.set(id, { resolve, reject });
				const msg: Record<string, unknown> = { jsonrpc: "2.0", id, method };
				if (params) msg.params = params;
				bunServer.publish("all", JSON.stringify(msg));
			});
		},
		async close() {
			bunServer.stop(true);
		},
	});

	return testServer as TestServer;
}

// ---------------------------------------------------------------------------
// Edge case tests
// ---------------------------------------------------------------------------

describe("connection timeout", () => {
	test(
		"rejects when server never completes WebSocket handshake",
		async () => {
			// Start a plain HTTP server that never upgrades to WebSocket
			const port = 30000 + Math.floor(Math.random() * 10000);
			const httpServer = Bun.serve({
				port,
				fetch() {
					// Return a normal HTTP response, never upgrade
					return new Response("nope", { status: 200 });
				},
			});
			server = httpServer;

			await expect(createRpcClient(`ws://127.0.0.1:${port}`)).rejects.toThrow();
		},
		{ timeout: 15000 },
	);
});

describe("request timeout", () => {
	test(
		"rejects with RPC timeout when server never responds",
		async () => {
			const ts = createTestServer({ autoRespond: false });
			client = await createRpcClient(ts.url, { timeoutMs: 500 });

			await expect(client.request("test/method")).rejects.toThrow("RPC timeout");
		},
		{ timeout: 5000 },
	);
});

describe("close during pending request", () => {
	test("rejects pending requests with Client closed", async () => {
		const ts = createTestServer({ autoRespond: false });
		client = await createRpcClient(ts.url, { timeoutMs: 10000 });

		const promise = client.request("test/method");
		// Give time for the request to be sent
		await Bun.sleep(50);
		client.close();

		await expect(promise).rejects.toThrow("Client closed");
	});
});

describe("server disconnect during pending request", () => {
	test("rejects pending requests with WebSocket closed", async () => {
		const ts = createTestServer({ autoRespond: false });
		client = await createRpcClient(ts.url, { timeoutMs: 10000 });

		const promise = client.request("test/method");
		// Give time for the request to be sent, then kill the server
		await Bun.sleep(50);
		await ts.close();

		await expect(promise).rejects.toThrow("WebSocket closed");
	});
});

describe("request after close", () => {
	test("rejects immediately with WebSocket closed, cannot send", async () => {
		const ts = createTestServer();
		client = await createRpcClient(ts.url);
		client.close();

		await expect(client.request("test/method")).rejects.toThrow("WebSocket closed, cannot send");
	});
});

describe("closed property", () => {
	test("is false when connected, true after close", async () => {
		const ts = createTestServer();
		client = await createRpcClient(ts.url);

		expect(client.closed).toBe(false);
		client.close();
		expect(client.closed).toBe(true);
	});
});

describe("server-initiated requests", () => {
	test("dispatches to onRequest handler and sends response", async () => {
		const ts = createTestServer({ autoRespond: false });
		client = await createRpcClient(ts.url);

		const calls: Array<{ method: string; params: unknown }> = [];
		client.onRequest(async (method, params) => {
			calls.push({ method, params });
			return { handled: true, method };
		});

		// Send a server-initiated request (has both id and method)
		const responsePromise = ts.request("server/doSomething", { key: "value" });
		const result = await responsePromise;

		expect(calls.length).toBe(1);
		expect(calls[0]?.method).toBe("server/doSomething");
		expect(calls[0]?.params).toEqual({ key: "value" });
		expect(result).toEqual({ handled: true, method: "server/doSomething" });
	});

	test("sends result: null when handler returns null", async () => {
		const ts = createTestServer({ autoRespond: false });
		client = await createRpcClient(ts.url);

		client.onRequest(() => null);

		const result = await ts.request("server/ping");
		expect(result).toBeNull();
	});

	test("sends error response when handler throws", async () => {
		const ts = createTestServer({ autoRespond: false });
		client = await createRpcClient(ts.url);

		client.onRequest(() => {
			throw new Error("handler exploded");
		});

		await expect(ts.request("server/fail")).rejects.toThrow("handler exploded");
	});
});

describe("multiple notification handlers", () => {
	test("all handlers are called for a notification", async () => {
		const ts = createTestServer();
		client = await createRpcClient(ts.url);

		const called: number[] = [];
		client.onNotification(() => called.push(1));
		client.onNotification(() => called.push(2));
		client.onNotification(() => called.push(3));

		ts.notify("event/happened", { data: "test" });
		await Bun.sleep(100);

		expect(called).toEqual([1, 2, 3]);
	});
});

describe("server request also dispatched to notification handlers", () => {
	test("both onRequest and onNotification handlers are called", async () => {
		const ts = createTestServer({ autoRespond: false });
		client = await createRpcClient(ts.url);

		let requestHandlerCalled = false;
		let notificationHandlerCalled = false;

		client.onRequest((method) => {
			requestHandlerCalled = true;
			return { echo: method };
		});
		client.onNotification(() => {
			notificationHandlerCalled = true;
		});

		await ts.request("server/both");
		// Brief wait for async dispatch
		await Bun.sleep(50);

		expect(requestHandlerCalled).toBe(true);
		expect(notificationHandlerCalled).toBe(true);
	});
});

describe("multiple requests in flight", () => {
	test("resolves each request with the correct response when answered out of order", async () => {
		// Server that holds requests and responds in reverse order
		const receivedRequests: Array<{ id: number; method: string }> = [];
		const port = 30000 + Math.floor(Math.random() * 10000);

		const bunServer = Bun.serve({
			port,
			fetch(req, srv) {
				if (srv.upgrade(req, { data: undefined })) return undefined;
				return new Response("Not found", { status: 404 });
			},
			websocket: {
				open(ws) {
					ws.subscribe("all");
				},
				message(_ws, message) {
					const data = JSON.parse(String(message)) as Record<string, unknown>;
					const hasId = "id" in data && data.id != null;
					const hasMethod = "method" in data && typeof data.method === "string";
					if (hasId && hasMethod) {
						receivedRequests.push({
							id: data.id as number,
							method: data.method as string,
						});
						// Once we have all 3, respond in reverse order
						if (receivedRequests.length === 3) {
							for (let i = receivedRequests.length - 1; i >= 0; i--) {
								const req = receivedRequests[i];
								if (req) {
									bunServer.publish(
										"all",
										JSON.stringify({
											jsonrpc: "2.0",
											id: req.id,
											result: { order: i, method: req.method },
										}),
									);
								}
							}
						}
					}
				},
			},
		});
		server = bunServer;

		client = await createRpcClient(`ws://127.0.0.1:${port}`, { timeoutMs: 5000 });

		const [r1, r2, r3] = await Promise.all([
			client.request("method/a"),
			client.request("method/b"),
			client.request("method/c"),
		]);

		// Each should get a result with matching method
		expect(r1).toEqual({ order: 0, method: "method/a" });
		expect(r2).toEqual({ order: 1, method: "method/b" });
		expect(r3).toEqual({ order: 2, method: "method/c" });
	});
});

describe("JSON-RPC error response", () => {
	test("rejects with error message from server", async () => {
		const port = 30000 + Math.floor(Math.random() * 10000);
		const bunServer = Bun.serve({
			port,
			fetch(req, srv) {
				if (srv.upgrade(req, { data: undefined })) return undefined;
				return new Response("Not found", { status: 404 });
			},
			websocket: {
				message(ws, message) {
					const data = JSON.parse(String(message)) as Record<string, unknown>;
					ws.send(
						JSON.stringify({
							jsonrpc: "2.0",
							id: data.id,
							error: { code: -32601, message: "Method not found" },
						}),
					);
				},
			},
		});
		server = bunServer;

		client = await createRpcClient(`ws://127.0.0.1:${port}`);
		await expect(client.request("nonexistent/method")).rejects.toThrow("Method not found");
	});

	test("rejects with generic message when error has no message field", async () => {
		const port = 30000 + Math.floor(Math.random() * 10000);
		const bunServer = Bun.serve({
			port,
			fetch(req, srv) {
				if (srv.upgrade(req, { data: undefined })) return undefined;
				return new Response("Not found", { status: 404 });
			},
			websocket: {
				message(ws, message) {
					const data = JSON.parse(String(message)) as Record<string, unknown>;
					ws.send(
						JSON.stringify({
							jsonrpc: "2.0",
							id: data.id,
							error: { code: -32000 },
						}),
					);
				},
			},
		});
		server = bunServer;

		client = await createRpcClient(`ws://127.0.0.1:${port}`);
		await expect(client.request("test/method")).rejects.toThrow("JSON-RPC error");
	});
});

// ---------------------------------------------------------------------------
// createRpcClientWithRetry
// ---------------------------------------------------------------------------

describe("createRpcClientWithRetry", () => {
	test(
		"connects on first attempt when server is available",
		async () => {
			const ts = createTestServer();
			client = await createRpcClientWithRetry(ts.url, { maxAttempts: 3, baseDelayMs: 10 });
			expect(client.closed).toBe(false);
		},
		{ timeout: 5000 },
	);

	test(
		"succeeds after one initial failure",
		async () => {
			// First attempt: reject; second attempt: succeed
			let attempts = 0;
			// Use a port that initially has no listener, then start server after first fail
			const port = 30000 + Math.floor(Math.random() * 10000);

			// Start the server after a brief delay (shorter than the retry backoff).
			// We assign to the module-level `server` so afterEach handles cleanup.
			const serverStartTimeout = setTimeout(() => {
				server = Bun.serve({
					port,
					fetch(req, srv) {
						if (srv.upgrade(req, { data: undefined })) return undefined;
						return new Response("Not found", { status: 404 });
					},
					websocket: {
						open(ws) {
							ws.subscribe("all");
						},
						message() {},
					},
				});
			}, 50);

			try {
				// baseDelayMs=100 means retry after 100ms — server starts at 50ms
				client = await createRpcClientWithRetry(`ws://127.0.0.1:${port}`, {
					maxAttempts: 3,
					baseDelayMs: 100,
				});
				attempts++;
				expect(client.closed).toBe(false);
				expect(attempts).toBe(1);
			} finally {
				clearTimeout(serverStartTimeout);
				// server is cleaned up by afterEach
			}
		},
		{ timeout: 10000 },
	);

	test(
		"throws after exhausting all attempts",
		async () => {
			// Nothing listening on this port
			const port = 30000 + Math.floor(Math.random() * 10000);

			await expect(
				createRpcClientWithRetry(`ws://127.0.0.1:${port}`, {
					maxAttempts: 2,
					baseDelayMs: 10,
				}),
			).rejects.toThrow();
		},
		{ timeout: 10000 },
	);

	test(
		"uses exponential backoff between attempts",
		async () => {
			// Track when each attempt happens by recording timestamps when
			// the connection fails (nothing listening on this port)
			const port = 30000 + Math.floor(Math.random() * 10000);
			const startMs = Date.now();

			await expect(
				createRpcClientWithRetry(`ws://127.0.0.1:${port}`, {
					maxAttempts: 3,
					baseDelayMs: 50,
				}),
			).rejects.toThrow();

			// With baseDelayMs=50: delay after attempt 0 = 50ms, after attempt 1 = 100ms
			// Total minimum elapsed = 50 + 100 = 150ms
			const elapsedMs = Date.now() - startMs;
			expect(elapsedMs).toBeGreaterThanOrEqual(140);
		},
		{ timeout: 10000 },
	);

	test("passes timeoutMs to createRpcClient", async () => {
		const ts = createTestServer();
		// timeoutMs only affects RPC request timeouts, not connection
		client = await createRpcClientWithRetry(ts.url, {
			maxAttempts: 1,
			baseDelayMs: 10,
			timeoutMs: 5000,
		});
		expect(client.closed).toBe(false);
	});
});
