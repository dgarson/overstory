// src/codex/daemon/lifecycle.ts
// Lifecycle utilities for the daemon sidecar process.
// Provides state read/parse/check, bearer token generation, and daemon start/stop.

import { randomBytes } from "node:crypto";
import { closeSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OverstoryError } from "../../errors.ts";
import { isProcessRunning } from "../../watchdog/health.ts";

export interface DaemonState {
	pid: number;
	port: number;
	startedAt: string;
	url: string;
	token: string;
}

/** Generate a random 32-byte hex token for daemon auth */
export function generateToken(): string {
	const bytes = randomBytes(32);
	return bytes.toString("hex");
}

/** Parse daemon state from JSON string. Returns null on any parse error. */
export function parseDaemonState(json: string): DaemonState | null {
	try {
		const parsed = JSON.parse(json) as unknown;
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			typeof (parsed as Record<string, unknown>).pid !== "number" ||
			typeof (parsed as Record<string, unknown>).port !== "number" ||
			typeof (parsed as Record<string, unknown>).startedAt !== "string" ||
			typeof (parsed as Record<string, unknown>).url !== "string" ||
			typeof (parsed as Record<string, unknown>).token !== "string"
		) {
			return null;
		}
		return parsed as DaemonState;
	} catch {
		return null;
	}
}

/** Check if the daemon process is still alive */
export function isDaemonAlive(state: DaemonState): boolean {
	return isProcessRunning(state.pid);
}

/** Read daemon state from the state file. Returns null if file missing or invalid. */
export async function readDaemonState(statePath: string): Promise<DaemonState | null> {
	const file = Bun.file(statePath);
	if (!(await file.exists())) return null;
	const text = await file.text();
	return parseDaemonState(text);
}

/** Read daemon state synchronously. Returns null if file missing or invalid. */
export function readDaemonStateSync(overstoryDir: string): DaemonState | null {
	const statePath = `${overstoryDir}/daemon.json`;
	try {
		const text = readFileSync(statePath, "utf-8");
		return parseDaemonState(text);
	} catch {
		return null;
	}
}

/** Options for starting the daemon sidecar process. */
export interface DaemonStartOpts {
	/** Port to listen on. 0 = dynamic OS-assigned. */
	port: number;
	/** Codex App Server WebSocket URL (e.g. ws://127.0.0.1:21816) */
	codexServerUrl: string;
	/** Project root directory (used as daemon process cwd) */
	projectRoot: string;
}

/**
 * Race-safe daemon startup using a file lock.
 *
 * Pattern: acquire lock → check daemon.json → start if needed → wait for ready → release lock.
 *
 * If the daemon is already running (daemon.json present and PID alive), returns the existing state.
 * If not running, spawns main.ts as a sidecar, waits up to 5s for it to write daemon.json,
 * then sets permissions to 0600 and returns the new state.
 *
 * @param overstoryDir - Path to .overstory/ directory
 * @param opts - Daemon startup options (port, codexServerUrl, projectRoot)
 */
export async function ensureDaemonRunning(
	overstoryDir: string,
	opts: DaemonStartOpts,
): Promise<DaemonState> {
	const lockPath = join(overstoryDir, "daemon.lock");
	const statePath = join(overstoryDir, "daemon.json");

	// Acquire exclusive file lock (spin up to 10s)
	let lockFd: number | null = null;
	const lockDeadline = Date.now() + 10_000;
	while (lockFd === null) {
		try {
			lockFd = openSync(lockPath, "wx");
		} catch {
			if (Date.now() > lockDeadline) {
				throw new OverstoryError(
					"Timeout waiting for daemon.lock — another process may be starting the daemon",
					"DAEMON_LOCK_TIMEOUT",
				);
			}
			await new Promise((r) => setTimeout(r, 100));
		}
	}

	try {
		// Check if daemon already running
		const existing = readDaemonStateSync(overstoryDir);
		if (existing && isDaemonAlive(existing)) {
			return existing;
		}

		// Remove stale state file if present
		try {
			unlinkSync(statePath);
		} catch {
			// Not present or already gone — fine
		}

		// Generate token and spawn daemon sidecar
		const token = generateToken();
		const daemonMain = fileURLToPath(new URL("./main.ts", import.meta.url));

		const proc = Bun.spawn(["bun", "run", daemonMain], {
			cwd: opts.projectRoot,
			env: {
				...process.env,
				OVERSTORY_DIR: overstoryDir,
				OVERSTORY_DAEMON_PORT: String(opts.port),
				OVERSTORY_DAEMON_TOKEN: token,
				OVERSTORY_CODEX_SERVER_URL: opts.codexServerUrl,
			},
			stdout: "ignore",
			stderr: "ignore",
			stdin: "ignore",
		});
		proc.unref();

		// Wait for daemon to write state file (up to 5s)
		const startDeadline = Date.now() + 5_000;
		let state: DaemonState | null = null;
		while (state === null) {
			if (Date.now() > startDeadline) {
				throw new OverstoryError("Daemon failed to start within 5 seconds", "DAEMON_START_TIMEOUT");
			}
			await new Promise((r) => setTimeout(r, 100));
			const file = Bun.file(statePath);
			if (await file.exists()) {
				const text = await file.text();
				const parsed = parseDaemonState(text);
				if (parsed && isDaemonAlive(parsed)) {
					state = parsed;
				}
			}
		}

		// Restrict daemon.json to owner read/write only (bearer token is sensitive)
		await chmod(statePath, 0o600);

		return state;
	} finally {
		// Release lock — always
		if (lockFd !== null) {
			closeSync(lockFd);
			try {
				unlinkSync(lockPath);
			} catch {
				// Best-effort cleanup
			}
		}
	}
}

/**
 * Stop the daemon sidecar.
 *
 * Sends POST /shutdown to the daemon with bearer auth. If the HTTP call fails
 * (daemon already dead or unreachable), falls back to SIGTERM on the PID.
 * Always removes daemon.json on return.
 *
 * @param overstoryDir - Path to .overstory/ directory
 * @returns true if the daemon was running and was stopped, false if it wasn't running
 */
export async function stopDaemon(overstoryDir: string): Promise<boolean> {
	const state = readDaemonStateSync(overstoryDir);
	if (!state) return false;

	// Try graceful HTTP shutdown first
	let stopped = false;
	if (isDaemonAlive(state)) {
		try {
			const res = await fetch(`${state.url}/shutdown`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${state.token}`,
					"Content-Type": "application/json",
				},
			});
			stopped = res.ok;
		} catch {
			// Daemon unreachable — fall back to SIGTERM
		}

		if (!stopped) {
			try {
				process.kill(state.pid, "SIGTERM");
				stopped = true;
			} catch {
				// PID already dead
			}
		}
	}

	// Clean up state file
	const statePath = join(overstoryDir, "daemon.json");
	try {
		unlinkSync(statePath);
	} catch {
		// Already gone — fine
	}

	return stopped;
}
