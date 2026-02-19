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
		// Build a validated object instead of double-casting
		const state: CodexServerState = {
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

/** Check if the server process is still alive */
export function isServerAlive(state: CodexServerState): boolean {
	// pid <= 0 is a sentinel meaning "external server, not started by us"
	if (state.pid <= 0) return false;
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

	// Race: either the process exits early (error) or we wait for it to bind.
	// If proc.exited resolves first, the server crashed on startup.
	const exited = await Promise.race([
		proc.exited.then((code) => code),
		Bun.sleep(2000).then(() => null),
	]);

	if (exited !== null) {
		const stderr = await new Response(proc.stderr).text();
		// Port already in use: an existing server we didn't start is running.
		// Return its URL without writing codex-server.json — stopServer will
		// never find a state file for it and will leave it alone.
		if (stderr.includes("Address already in use")) {
			return { pid: 0, port, startedAt: new Date().toISOString(), url };
		}
		throw new Error(`Codex App Server exited immediately (code ${exited}): ${stderr.trim()}`);
	}

	// Verify process is alive after the startup window
	try {
		process.kill(proc.pid, 0);
	} catch {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`Codex App Server died during startup: ${stderr.trim()}`);
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
