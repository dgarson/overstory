/**
 * MCP server state file management.
 *
 * Persists server PID, port, and URL to .overstory/mcp-server.json
 * so CLI commands can find and manage the running server.
 */

import { join } from "node:path";
import type { McpServerState } from "./types.ts";

const STATE_FILE = "mcp-server.json";

export function getServerStatePath(overstoryDir: string): string {
	return join(overstoryDir, STATE_FILE);
}

/**
 * Parse a raw JSON string into McpServerState.
 * Returns null if the string is invalid or missing required fields.
 */
export function parseServerState(raw: string): McpServerState | null {
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		if (
			typeof parsed.pid !== "number" ||
			typeof parsed.port !== "number" ||
			typeof parsed.startedAt !== "string" ||
			typeof parsed.url !== "string"
		) {
			return null;
		}
		const state: McpServerState = {
			pid: parsed.pid,
			port: parsed.port,
			startedAt: parsed.startedAt,
			url: parsed.url,
		};
		return state;
	} catch {
		return null;
	}
}

/** Check if the server process is still alive. */
export function isServerAlive(state: McpServerState): boolean {
	if (state.pid <= 0) return false;
	try {
		process.kill(state.pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Read server state from .overstory/mcp-server.json */
export async function readServerState(overstoryDir: string): Promise<McpServerState | null> {
	const path = getServerStatePath(overstoryDir);
	const file = Bun.file(path);
	if (!(await file.exists())) return null;
	const raw = await file.text();
	return parseServerState(raw);
}

/** Write server state to .overstory/mcp-server.json */
export async function writeServerState(overstoryDir: string, state: McpServerState): Promise<void> {
	const path = getServerStatePath(overstoryDir);
	await Bun.write(path, JSON.stringify(state, null, "\t"));
}

/** Delete the server state file. */
export async function deleteServerState(overstoryDir: string): Promise<void> {
	const { unlink } = await import("node:fs/promises");
	try {
		await unlink(getServerStatePath(overstoryDir));
	} catch {
		// File may not exist
	}
}
