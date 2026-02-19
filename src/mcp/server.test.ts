/**
 * Integration tests for the MCP server entry point (server.ts).
 *
 * These tests spawn the actual server subprocess and verify the observable
 * lifecycle contract: starts → writes state file → serves HTTP → shuts down cleanly.
 *
 * WHY subprocess spawning (not unit testing main()):
 * server.ts is a thin wiring entry point gated by import.meta.main.
 * All component logic has dedicated unit tests (transport, tools, coordinator-loop,
 * state). Here we test only what those unit tests cannot: that wiring together
 * correctly results in a live server process.
 *
 * Uses real SQLite (workflow.db, mail.db) in a temp directory.
 * No mocks required — all operations are local.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readServerState } from "./state.ts";

// ─── config ─────────────────────────────────────────────────────────────────

/** Port used exclusively for server integration tests. */
const TEST_PORT = 21998;

const SERVER_SCRIPT = join(import.meta.dir, "server.ts");

// ─── helpers ────────────────────────────────────────────────────────────────

async function writeConfig(overstoryDir: string, port: number, projectRoot: string): Promise<void> {
	await Bun.write(
		join(overstoryDir, "config.yaml"),
		[
			"project:",
			`  name: test-mcp-server`,
			`  root: ${projectRoot}`,
			"  canonicalBranch: main",
			"mcp:",
			"  enabled: true",
			`  port: ${port}`,
			"  coordinatorIntervalMs: 60000",
			"  idleThresholdMs: 60000",
			"  awaitWorkMaxMs: 300000",
		].join("\n"),
	);
}

/**
 * Poll the state file until it appears or timeout expires.
 * Returns the state on success, null on timeout.
 */
async function waitForReady(
	overstoryDir: string,
	maxWaitMs = 12000,
): Promise<Awaited<ReturnType<typeof readServerState>>> {
	const deadline = Date.now() + maxWaitMs;
	while (Date.now() < deadline) {
		const state = await readServerState(overstoryDir);
		if (state) return state;
		await Bun.sleep(150);
	}
	return null;
}

/**
 * Send a JSON-RPC 2.0 request to the server and return the parsed response.
 */
async function rpcCall(
	port: number,
	method: string,
	params: Record<string, unknown> = {},
): Promise<unknown> {
	const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	});
	return res.json();
}

// ─── fixtures ───────────────────────────────────────────────────────────────

let tempDir: string;
let overstoryDir: string;
let proc: ReturnType<typeof Bun.spawn> | null = null;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "mcp-server-test-"));
	overstoryDir = join(tempDir, ".overstory");
	await mkdir(overstoryDir, { recursive: true });
	await writeConfig(overstoryDir, TEST_PORT, tempDir);
	proc = null;
});

afterEach(async () => {
	if (proc) {
		try {
			proc.kill("SIGTERM");
			await proc.exited;
		} catch {
			// Already exited
		}
		proc = null;
	}
	await rm(tempDir, { recursive: true, force: true });
});

// ─── tests ───────────────────────────────────────────────────────────────────

describe("MCP server — startup", () => {
	test("writes state file with correct pid, port, and url", async () => {
		proc = Bun.spawn(["bun", SERVER_SCRIPT], {
			cwd: tempDir,
			stdout: "ignore",
			stderr: "ignore",
		});

		const state = await waitForReady(overstoryDir);
		expect(state).not.toBeNull();
		expect(state?.pid).toBe(proc.pid);
		expect(state?.port).toBe(TEST_PORT);
		expect(state?.url).toBe(`http://127.0.0.1:${TEST_PORT}/mcp`);
		expect(typeof state?.startedAt).toBe("string");
	}, 15000);

	test("tools/list returns a non-empty array of tool definitions", async () => {
		proc = Bun.spawn(["bun", SERVER_SCRIPT], {
			cwd: tempDir,
			stdout: "ignore",
			stderr: "ignore",
		});

		await waitForReady(overstoryDir);

		const json = (await rpcCall(TEST_PORT, "tools/list")) as {
			result?: { tools: unknown[] };
		};
		expect(Array.isArray(json.result?.tools)).toBe(true);
		expect((json.result?.tools ?? []).length).toBeGreaterThan(0);
	}, 15000);

	test("returns JSON-RPC error for unknown method", async () => {
		proc = Bun.spawn(["bun", SERVER_SCRIPT], {
			cwd: tempDir,
			stdout: "ignore",
			stderr: "ignore",
		});

		await waitForReady(overstoryDir);

		const json = (await rpcCall(TEST_PORT, "no_such_method")) as {
			error?: { code: number };
		};
		expect(json.error?.code).toBe(-32601);
	}, 15000);
});

describe("MCP server — shutdown", () => {
	test("SIGTERM causes clean shutdown and removes state file", async () => {
		proc = Bun.spawn(["bun", SERVER_SCRIPT], {
			cwd: tempDir,
			stdout: "ignore",
			stderr: "ignore",
		});

		const ready = await waitForReady(overstoryDir);
		expect(ready).not.toBeNull();

		// Send SIGTERM and wait for process to exit
		proc.kill("SIGTERM");
		const exitCode = await proc.exited;
		proc = null;

		expect(exitCode).toBe(0);

		// State file must be cleaned up on graceful shutdown
		const stateAfter = await readServerState(overstoryDir);
		expect(stateAfter).toBeNull();
	}, 15000);
});
