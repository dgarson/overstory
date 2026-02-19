// src/codex/daemon/lifecycle.ts
// Lifecycle utilities for the daemon sidecar process.
// Provides state read/parse/check and bearer token generation.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
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
