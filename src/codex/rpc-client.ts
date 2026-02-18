// src/codex/rpc-client.ts
import type { JsonRpcRequest } from "./types";

export interface RpcClient {
	request(method: string, params?: Record<string, unknown>): Promise<unknown>;
	onNotification(handler: (method: string, params: unknown) => void): void;
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

	ws.addEventListener("message", (event) => {
		const data = JSON.parse(String(event.data)) as Record<string, unknown>;

		// Response (has id)
		if ("id" in data && data.id != null) {
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
		if ("method" in data) {
			for (const handler of notificationHandlers) {
				handler(data.method as string, data.params);
			}
		}
	});

	return {
		request(method, params) {
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

		close() {
			for (const [_id, req] of pending) {
				clearTimeout(req.timer);
				req.reject(new Error("Client closed"));
			}
			pending.clear();
			ws.close();
		},
	};
}
