/**
 * Tests for overstory mcp start|stop|status command.
 *
 * The start/stop paths involve real process spawning and filesystem state,
 * so we focus on the observable branches: already-running, not-running, status output.
 * Tests use temp .overstory directories with real McpServerState files.
 *
 * NOTE: Tests chdir into the temp directory so loadConfig() can locate the
 * .overstory/config.yaml we write during setup (same pattern as coordinator.test.ts).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeServerState } from "../mcp/state.ts";
import type { McpServerState } from "../mcp/types.ts";
import { mcpCommand } from "./mcp.ts";

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Build a minimal McpServerState pointing at a guaranteed-live PID
 * (we use the current test process's PID).
 */
function liveState(port = 21817): McpServerState {
	return {
		pid: process.pid,
		port,
		startedAt: new Date().toISOString(),
		url: `http://127.0.0.1:${port}/mcp`,
	};
}

/**
 * Build a state with PID 999999999 — almost certainly dead on any machine.
 */
function deadState(port = 21817): McpServerState {
	return {
		pid: 999999999,
		port,
		startedAt: new Date().toISOString(),
		url: `http://127.0.0.1:${port}/mcp`,
	};
}

/**
 * Capture stdout/stderr to strings while calling fn().
 */
async function captureOutput(fn: () => Promise<void>): Promise<{ stdout: string; stderr: string }> {
	const origWrite = process.stdout.write.bind(process.stdout);
	const origErr = process.stderr.write.bind(process.stderr);
	let stdout = "";
	let stderr = "";

	process.stdout.write = (chunk: unknown) => {
		stdout += String(chunk);
		return true;
	};
	process.stderr.write = (chunk: unknown) => {
		stderr += String(chunk);
		return true;
	};

	try {
		await fn();
	} finally {
		process.stdout.write = origWrite;
		process.stderr.write = origErr;
	}

	return { stdout, stderr };
}

// ─── fixtures ───────────────────────────────────────────────────────────────

let tempDir: string;
let overstoryDir: string;
const originalCwd = process.cwd();

beforeEach(async () => {
	process.chdir(originalCwd);

	tempDir = await mkdtemp(join(tmpdir(), "overstory-mcp-test-"));
	overstoryDir = join(tempDir, ".overstory");
	await mkdir(overstoryDir, { recursive: true });

	// Write a minimal config.yaml so loadConfig succeeds
	await Bun.write(
		join(overstoryDir, "config.yaml"),
		["project:", `  name: test-project`, `  root: ${tempDir}`, "  canonicalBranch: main"].join(
			"\n",
		),
	);

	// chdir into tempDir so loadConfig finds our config.yaml
	process.chdir(tempDir);
});

afterEach(async () => {
	process.chdir(originalCwd);
	await rm(tempDir, { recursive: true, force: true });
});

// ─── status ─────────────────────────────────────────────────────────────────

describe("mcp status — no state file", () => {
	test("prints 'not running' text", async () => {
		const { stdout } = await captureOutput(async () => {
			await mcpCommand(["status"]);
		});
		expect(stdout).toContain("not running");
	});

	test("prints JSON {running: false} with --json", async () => {
		const { stdout } = await captureOutput(async () => {
			await mcpCommand(["status", "--json"]);
		});
		const parsed = JSON.parse(stdout.trim()) as { running: boolean };
		expect(parsed.running).toBe(false);
	});
});

describe("mcp status — live state", () => {
	test("prints running info text", async () => {
		await writeServerState(overstoryDir, liveState());
		const { stdout } = await captureOutput(async () => {
			await mcpCommand(["status"]);
		});
		expect(stdout).toContain("running");
		expect(stdout).toContain("21817");
	});

	test("returns JSON with running:true", async () => {
		await writeServerState(overstoryDir, liveState(21818));
		const { stdout } = await captureOutput(async () => {
			await mcpCommand(["status", "--json"]);
		});
		const parsed = JSON.parse(stdout.trim()) as { running: boolean; port: number };
		expect(parsed.running).toBe(true);
		expect(parsed.port).toBe(21818);
	});
});

describe("mcp status — stale state (dead PID)", () => {
	test("prints stale/not-running text", async () => {
		await writeServerState(overstoryDir, deadState());
		const { stdout } = await captureOutput(async () => {
			await mcpCommand(["status"]);
		});
		// Should indicate not running (stale)
		expect(stdout).toContain("not running");
	});

	test("returns JSON with running:false, stale:true", async () => {
		await writeServerState(overstoryDir, deadState());
		const { stdout } = await captureOutput(async () => {
			await mcpCommand(["status", "--json"]);
		});
		const parsed = JSON.parse(stdout.trim()) as { running: boolean; stale?: boolean };
		expect(parsed.running).toBe(false);
		expect(parsed.stale).toBe(true);
	});
});

// ─── stop ───────────────────────────────────────────────────────────────────

describe("mcp stop — not running", () => {
	test("prints 'not running' when no state file exists", async () => {
		const { stdout } = await captureOutput(async () => {
			await mcpCommand(["stop"]);
		});
		expect(stdout).toContain("not running");
	});

	test("returns JSON with running:false when no state file", async () => {
		const { stdout } = await captureOutput(async () => {
			await mcpCommand(["stop", "--json"]);
		});
		const parsed = JSON.parse(stdout.trim()) as { running: boolean; stopped: boolean };
		expect(parsed.running).toBe(false);
		expect(parsed.stopped).toBe(false);
	});

	test("prints 'not running' when state file has dead PID", async () => {
		await writeServerState(overstoryDir, deadState());
		const { stdout } = await captureOutput(async () => {
			await mcpCommand(["stop"]);
		});
		expect(stdout).toContain("not running");
	});
});

// ─── start — already running ─────────────────────────────────────────────────

describe("mcp start — server already running", () => {
	test("prints 'already running' text", async () => {
		await writeServerState(overstoryDir, liveState());
		const { stdout } = await captureOutput(async () => {
			await mcpCommand(["start"]);
		});
		expect(stdout).toContain("already running");
		expect(stdout).toContain("21817");
	});

	test("returns JSON with running:true when --json", async () => {
		await writeServerState(overstoryDir, liveState(21820));
		const { stdout } = await captureOutput(async () => {
			await mcpCommand(["start", "--json"]);
		});
		const parsed = JSON.parse(stdout.trim()) as { running: boolean; port: number };
		expect(parsed.running).toBe(true);
		expect(parsed.port).toBe(21820);
	});
});

// ─── help ───────────────────────────────────────────────────────────────────

describe("mcp --help", () => {
	test("prints help text", async () => {
		const { stdout } = await captureOutput(async () => {
			await mcpCommand(["--help"]);
		});
		expect(stdout).toContain("overstory mcp");
		expect(stdout).toContain("start");
		expect(stdout).toContain("stop");
		expect(stdout).toContain("status");
	});

	test("prints help when no subcommand given", async () => {
		const { stdout } = await captureOutput(async () => {
			await mcpCommand([]);
		});
		expect(stdout).toContain("overstory mcp");
	});
});

// ─── unknown subcommand ──────────────────────────────────────────────────────

describe("mcp unknown subcommand", () => {
	test("throws ValidationError for unknown subcommand", async () => {
		await expect(mcpCommand(["bogus"])).rejects.toThrow("Unknown mcp subcommand");
	});
});
