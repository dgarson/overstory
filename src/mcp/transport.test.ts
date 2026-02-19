import { describe, expect, test } from "bun:test";
import { buildFetchHandler, createTransportState, handlePost, handleSse } from "./transport.ts";
import type { McpSession } from "./types.ts";

function makeHandlers() {
	const handlers = new Map<
		string,
		(params: Record<string, unknown>, session: McpSession) => Promise<unknown>
	>();

	handlers.set("tools/call", async (_params, session) => {
		return { result: "ok", agentName: session.agentName };
	});

	handlers.set("echo", async (params) => {
		return { echoed: params };
	});

	return handlers;
}

function makePostRequest(body: unknown, headers: Record<string, string> = {}): Request {
	return new Request("http://localhost/mcp", {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
}

describe("handlePost", () => {
	test("returns 400 for invalid JSON body", async () => {
		const state = createTransportState();
		const handlers = makeHandlers();
		const req = new Request("http://localhost/mcp", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "not valid json {",
		});
		const res = await handlePost(req, state, handlers, "test-project");
		expect(res.status).toBe(400);
		const json = (await res.json()) as Record<string, unknown>;
		expect((json.error as Record<string, unknown>)?.code).toBe(-32700);
	});

	test("returns 400 for missing method field", async () => {
		const state = createTransportState();
		const handlers = makeHandlers();
		const req = makePostRequest({ jsonrpc: "2.0", id: 1 });
		const res = await handlePost(req, state, handlers, "test-project");
		expect(res.status).toBe(400);
		const json = (await res.json()) as Record<string, unknown>;
		expect((json.error as Record<string, unknown>)?.code).toBe(-32600);
	});

	test("returns 400 for wrong jsonrpc version", async () => {
		const state = createTransportState();
		const handlers = makeHandlers();
		const req = makePostRequest({ jsonrpc: "1.0", id: 1, method: "echo" });
		const res = await handlePost(req, state, handlers, "test-project");
		expect(res.status).toBe(400);
	});

	test("returns 404 for unknown method", async () => {
		const state = createTransportState();
		const handlers = makeHandlers();
		const req = makePostRequest({ jsonrpc: "2.0", id: 1, method: "unknown/method" });
		const res = await handlePost(req, state, handlers, "test-project");
		expect(res.status).toBe(404);
		const json = (await res.json()) as Record<string, unknown>;
		expect((json.error as Record<string, unknown>)?.code).toBe(-32601);
	});

	test("dispatches to handler and returns 200 for known method", async () => {
		const state = createTransportState();
		const handlers = makeHandlers();
		const req = makePostRequest({
			jsonrpc: "2.0",
			id: 1,
			method: "echo",
			params: { hello: "world" },
		});
		const res = await handlePost(req, state, handlers, "test-project");
		expect(res.status).toBe(200);
		const json = (await res.json()) as Record<string, unknown>;
		expect(json.result).toBeDefined();
	});

	test("creates a new session on first request", async () => {
		const state = createTransportState();
		const handlers = makeHandlers();
		expect(state.sessions.size).toBe(0);

		const req = makePostRequest({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { agentName: "agent-alpha", name: "echo", arguments: {} },
		});
		await handlePost(req, state, handlers, "test-project");
		expect(state.sessions.size).toBe(1);
	});

	test("reuses existing session via x-session-id header", async () => {
		const state = createTransportState();
		const handlers = makeHandlers();

		const req1 = makePostRequest(
			{ jsonrpc: "2.0", id: 1, method: "echo", params: { agentName: "agent-beta" } },
			{ "x-session-id": "fixed-session-id" },
		);
		await handlePost(req1, state, handlers, "test-project");
		expect(state.sessions.size).toBe(1);

		const req2 = makePostRequest(
			{ jsonrpc: "2.0", id: 2, method: "echo", params: {} },
			{ "x-session-id": "fixed-session-id" },
		);
		await handlePost(req2, state, handlers, "test-project");
		expect(state.sessions.size).toBe(1);
	});

	test("includes x-session-id in response headers", async () => {
		const state = createTransportState();
		const handlers = makeHandlers();
		const req = makePostRequest(
			{ jsonrpc: "2.0", id: 1, method: "echo", params: {} },
			{ "x-session-id": "my-session" },
		);
		const res = await handlePost(req, state, handlers, "test-project");
		expect(res.headers.get("x-session-id")).toBe("my-session");
	});

	test("updates agent name from params if different from unknown", async () => {
		const state = createTransportState();
		const handlers = makeHandlers();

		// First request sets up session with "unknown" agent
		const req1 = makePostRequest(
			{ jsonrpc: "2.0", id: 1, method: "echo", params: {} },
			{ "x-session-id": "sess-update" },
		);
		await handlePost(req1, state, handlers, "test-project");

		const session1 = state.sessions.get("sess-update");
		expect(session1?.agentName).toBe("unknown");

		// Second request provides actual agent name
		const req2 = makePostRequest(
			{ jsonrpc: "2.0", id: 2, method: "echo", params: { agentName: "real-agent" } },
			{ "x-session-id": "sess-update" },
		);
		await handlePost(req2, state, handlers, "test-project");

		const session2 = state.sessions.get("sess-update");
		expect(session2?.agentName).toBe("real-agent");
	});

	test("returns 500 when handler throws", async () => {
		const state = createTransportState();
		const handlers = new Map<
			string,
			(params: Record<string, unknown>, session: McpSession) => Promise<unknown>
		>();
		handlers.set("boom", async () => {
			throw new Error("Kaboom");
		});

		const req = makePostRequest({ jsonrpc: "2.0", id: 1, method: "boom" });
		const res = await handlePost(req, state, handlers, "test-project");
		expect(res.status).toBe(500);
		const json = (await res.json()) as Record<string, unknown>;
		expect((json.error as Record<string, unknown>)?.code).toBe(-32603);
	});
});

describe("handleSse", () => {
	test("returns a text/event-stream response", () => {
		const state = createTransportState();
		const req = new Request("http://localhost/mcp", { method: "GET" });
		const res = handleSse(req, state, "test-project");
		expect(res.headers.get("content-type")).toBe("text/event-stream");
	});

	test("includes x-session-id in response headers", () => {
		const state = createTransportState();
		const req = new Request("http://localhost/mcp", {
			method: "GET",
			headers: { "x-session-id": "sse-session-1" },
		});
		const res = handleSse(req, state, "test-project");
		expect(res.headers.get("x-session-id")).toBe("sse-session-1");
	});

	test("registers session in transport state", () => {
		const state = createTransportState();
		const req = new Request("http://localhost/mcp", {
			method: "GET",
			headers: { "x-session-id": "sse-session-2" },
		});
		handleSse(req, state, "test-project");
		expect(state.sessions.has("sse-session-2")).toBe(true);
	});

	test("creates session with agent name from x-agent-name header", () => {
		const state = createTransportState();
		const req = new Request("http://localhost/mcp", {
			method: "GET",
			headers: {
				"x-session-id": "sse-session-3",
				"x-agent-name": "my-agent",
			},
		});
		handleSse(req, state, "test-project");
		const session = state.sessions.get("sse-session-3");
		expect(session?.agentName).toBe("my-agent");
	});

	test("sets sseController on the session", () => {
		const state = createTransportState();
		const req = new Request("http://localhost/mcp", {
			method: "GET",
			headers: { "x-session-id": "sse-session-4" },
		});
		handleSse(req, state, "test-project");
		const session = state.sessions.get("sse-session-4");
		expect(session?.sseController).not.toBeNull();
	});
});

describe("buildFetchHandler", () => {
	test("routes POST /mcp to handlePost", async () => {
		const state = createTransportState();
		const handlers = makeHandlers();
		const fetchHandler = buildFetchHandler(state, handlers, "test-project");

		const req = new Request("http://localhost/mcp", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "echo", params: {} }),
		});
		const res = await fetchHandler(req);
		expect(res.status).toBe(200);
	});

	test("routes GET /mcp to handleSse", async () => {
		const state = createTransportState();
		const handlers = makeHandlers();
		const fetchHandler = buildFetchHandler(state, handlers, "test-project");

		const req = new Request("http://localhost/mcp", { method: "GET" });
		const res = await fetchHandler(req);
		expect(res.headers.get("content-type")).toBe("text/event-stream");
	});

	test("returns 404 for non-/mcp path", async () => {
		const state = createTransportState();
		const handlers = makeHandlers();
		const fetchHandler = buildFetchHandler(state, handlers, "test-project");

		const req = new Request("http://localhost/other", { method: "GET" });
		const res = await fetchHandler(req);
		expect(res.status).toBe(404);
	});

	test("returns 405 for unsupported HTTP methods on /mcp", async () => {
		const state = createTransportState();
		const handlers = makeHandlers();
		const fetchHandler = buildFetchHandler(state, handlers, "test-project");

		const req = new Request("http://localhost/mcp", { method: "DELETE" });
		const res = await fetchHandler(req);
		expect(res.status).toBe(405);
	});
});
