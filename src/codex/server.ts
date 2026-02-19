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

/**
 * Probe for a running `codex app-server` process via pgrep and extract its
 * listen URL from the command line arguments.
 *
 * Returns a CodexServerState with pid=0 (sentinel: external server, do not
 * kill) if found, or null if no external server is detected.
 */
export async function discoverExternalServer(): Promise<CodexServerState | null> {
	// pgrep -fa <pattern>: match against full command line, print pid + args.
	// Works on macOS and Linux. Exits 1 when no match found.
	const proc = Bun.spawn(["pgrep", "-fa", "codex"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) return null;

	const stdout = await new Response(proc.stdout).text();
	for (const line of stdout.trim().split("\n")) {
		if (!line.includes("app-server")) continue;
		const listenMatch = line.match(/--listen\s+(\S+)/);
		const url = listenMatch?.[1];
		if (!url) continue;
		// URL format: ws://127.0.0.1:<port>
		const portMatch = url.match(/:(\d+)$/);
		const portStr = portMatch?.[1];
		if (!portStr) continue;
		return {
			pid: 0, // sentinel: external server, stopServer will leave it alone
			port: Number(portStr),
			startedAt: new Date().toISOString(),
			url,
		};
	}
	return null;
}

/** Start the shared Codex App Server */
export async function startServer(
	overstoryDir: string,
	port: number,
	useAvailableServer = true,
): Promise<CodexServerState> {
	// 1. Check state file from a server we previously started.
	const existing = await readServerState(overstoryDir);
	if (existing && isServerAlive(existing)) {
		return existing;
	}

	// 2. Probe for an externally started server before attempting to bind.
	//    This gives us the actual listening port rather than assuming our
	//    configured default is correct.
	//    Skipped when useAvailableServer=false (caller wants a fresh server on the configured port).
	if (useAvailableServer) {
		const external = await discoverExternalServer();
		if (external) {
			return external;
		}
	}

	// 3. No server found — spawn one on the configured port.
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
		// discoverExternalServer() should have caught this case, but handle it
		// defensively in case there's a race between discovery and bind.
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
