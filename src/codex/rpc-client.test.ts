// src/codex/rpc-client.test.ts
import { describe, test, expect, afterEach } from "bun:test";
import { createRpcClient } from "./rpc-client";

let server: ReturnType<typeof Bun.serve> | null = null;

afterEach(() => {
	server?.stop(true);
	server = null;
});

function startMockServer(handler: (ws: { send: (msg: string) => void }, message: string) => void): number {
	const port = 30000 + Math.floor(Math.random() * 10000);
	server = Bun.serve({
		port,
		fetch(req, srv) {
			if (srv.upgrade(req)) return undefined;
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
		ws.send(JSON.stringify({
			jsonrpc: "2.0",
			id: req.id,
			result: { threadId: "thread-1" },
		}));
	});

	const client = await createRpcClient(`ws://127.0.0.1:${port}`);
	const result = await client.request("thread/start", { model: "o3" });
	expect(result).toEqual({ threadId: "thread-1" });
	client.close();
});

test("receives notifications via onNotification", async () => {
	const port = startMockServer((ws, msg) => {
		const req = JSON.parse(msg) as { id: number };
		// Send response
		ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: {} }));
		// Then send notification
		ws.send(JSON.stringify({
			jsonrpc: "2.0",
			method: "item/started",
			params: { itemId: "item-1" },
		}));
	});

	const notifications: Array<{ method: string; params: unknown }> = [];
	const client = await createRpcClient(`ws://127.0.0.1:${port}`);
	client.onNotification((method, params) => {
		notifications.push({ method, params });
	});
	await client.request("initialize", {});
	// Wait for notification delivery
	await Bun.sleep(100);
	expect(notifications.length).toBe(1);
	expect(notifications[0]?.method).toBe("item/started");
	client.close();
});

test("rejects on JSON-RPC error response", async () => {
	const port = startMockServer((ws, msg) => {
		const req = JSON.parse(msg) as { id: number };
		ws.send(JSON.stringify({
			jsonrpc: "2.0",
			id: req.id,
			error: { code: -32600, message: "Invalid request" },
		}));
	});

	const client = await createRpcClient(`ws://127.0.0.1:${port}`);
	await expect(client.request("bad/method", {})).rejects.toThrow("Invalid request");
	client.close();
});
