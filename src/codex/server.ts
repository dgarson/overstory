// src/codex/server.ts
import { join } from "node:path";
import type { CodexServerState } from "./types";

const STATE_FILE = "codex-server.json";

export function getServerStatePath(overstoryDir: string): string {
	return join(overstoryDir, STATE_FILE);
}

export function parseServerState(raw: string): CodexServerState | null {
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
		return parsed as unknown as CodexServerState;
	} catch {
		return null;
	}
}

/** Check if the server process is still alive */
export function isServerAlive(state: CodexServerState): boolean {
	try {
		process.kill(state.pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Read server state from .overstory/codex-server.json */
export async function readServerState(overstoryDir: string): Promise<CodexServerState | null> {
	const path = getServerStatePath(overstoryDir);
	const file = Bun.file(path);
	if (!(await file.exists())) return null;
	const raw = await file.text();
	return parseServerState(raw);
}

/** Start the shared Codex App Server */
export async function startServer(overstoryDir: string, port: number): Promise<CodexServerState> {
	// Check if already running
	const existing = await readServerState(overstoryDir);
	if (existing && isServerAlive(existing)) {
		return existing;
	}

	// Spawn: codex app-server --listen ws://127.0.0.1:<port>
	const url = `ws://127.0.0.1:${port}`;
	const proc = Bun.spawn(["codex", "app-server", "--listen", url], {
		stdout: "pipe",
		stderr: "pipe",
		cwd: overstoryDir,
	});

	// Give server time to bind
	await Bun.sleep(2000);

	// Verify it's alive
	if (!proc.pid) {
		throw new Error("Failed to start Codex App Server: no PID");
	}

	const state: CodexServerState = {
		pid: proc.pid,
		port,
		startedAt: new Date().toISOString(),
		url,
	};

	await Bun.write(getServerStatePath(overstoryDir), JSON.stringify(state, null, "\t"));
	return state;
}

/** Stop the shared Codex App Server */
export async function stopServer(overstoryDir: string): Promise<boolean> {
	const state = await readServerState(overstoryDir);
	if (!state) return false;

	if (isServerAlive(state)) {
		try {
			process.kill(state.pid, "SIGTERM");
		} catch {
			// Already dead
		}
	}

	const { unlink } = await import("node:fs/promises");
	try {
		await unlink(getServerStatePath(overstoryDir));
	} catch {
		// File may not exist
	}
	return true;
}
