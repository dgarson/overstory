// src/codex/types.test.ts
// Type-level compilation tests — these just need to compile with `bun run typecheck`.
import type { DeltaBuffer, JsonRpcNotification, JsonRpcRequest, ThreadStartParams } from "./types";

// Type-level tests — these just need to compile
const _req: JsonRpcRequest = {
	jsonrpc: "2.0",
	id: 1,
	method: "thread/start",
	params: {} as ThreadStartParams as Record<string, unknown>,
};

const _notif: JsonRpcNotification = {
	jsonrpc: "2.0",
	method: "item/completed",
	params: { itemId: "test" },
};

const _buf: DeltaBuffer = {
	itemId: "item-1",
	itemType: "commandExecution",
	startedAt: new Date().toISOString(),
	outputChunks: [],
	totalBytes: 0,
};

// Prevent unused variable warnings
void _req;
void _notif;
void _buf;
