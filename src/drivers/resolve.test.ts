import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntime, OverstoryConfig } from "../types";
import {
	resolveDriverForSession,
	resolveDriverForSpawn,
	resolveDriverName,
	resolveRuntimeForSpawn,
} from "./resolve";

describe("resolveRuntimeForSpawn", () => {
	test("returns 'claude' when no codex config", () => {
		expect(resolveRuntimeForSpawn("builder", { codex: undefined })).toBe("claude");
	});

	test("returns 'codex' when capability mapped to codex and intraProcess is false", () => {
		const config = {
			codex: { defaultRuntime: { builder: "codex" as AgentRuntime }, intraProcess: false },
		};
		expect(resolveRuntimeForSpawn("builder", config)).toBe("codex");
	});

	test("returns 'codex-daemon' when capability mapped to codex and intraProcess is true", () => {
		const config = {
			codex: { defaultRuntime: { builder: "codex" as AgentRuntime }, intraProcess: true },
		};
		expect(resolveRuntimeForSpawn("builder", config)).toBe("codex-daemon");
	});

	test("runtime flag overrides config", () => {
		const config = {
			codex: { defaultRuntime: { builder: "claude" as AgentRuntime }, intraProcess: false },
		};
		expect(resolveRuntimeForSpawn("builder", config, "codex")).toBe("codex");
	});

	test("capability mapped to claude is not upgraded even when intraProcess=true", () => {
		const config = {
			codex: { defaultRuntime: { builder: "claude" as AgentRuntime }, intraProcess: true },
		};
		expect(resolveRuntimeForSpawn("builder", config)).toBe("claude");
	});

	test("runtime flag 'codex' with intraProcess=true still resolves to codex-daemon", () => {
		const config = { codex: { defaultRuntime: {}, intraProcess: true } };
		expect(resolveRuntimeForSpawn("builder", config, "codex")).toBe("codex-daemon");
	});

	test("runtime flag 'codex-daemon' is passed through as-is", () => {
		const config = { codex: { defaultRuntime: {}, intraProcess: false } };
		expect(resolveRuntimeForSpawn("builder", config, "codex-daemon")).toBe("codex-daemon");
	});
});

describe("resolveDriverName", () => {
	test("returns 'claude' for runtime 'claude'", () => {
		expect(resolveDriverName("claude")).toBe("claude");
	});

	test("returns 'codex-bridge' for runtime 'codex'", () => {
		expect(resolveDriverName("codex")).toBe("codex-bridge");
	});

	test("returns 'codex-daemon' for runtime 'codex-daemon'", () => {
		expect(resolveDriverName("codex-daemon")).toBe("codex-daemon");
	});
});

// ---------------------------------------------------------------------------
// Minimal config fixture for factory function tests
// ---------------------------------------------------------------------------

function makeConfig(overrides?: { codex?: OverstoryConfig["codex"] }): OverstoryConfig {
	return {
		project: { name: "test-project", root: "/tmp/test-project", canonicalBranch: "main" },
		agents: {
			manifestPath: ".overstory/agent-manifest.json",
			baseDir: "agents",
			maxConcurrent: 10,
			staggerDelayMs: 0,
			maxDepth: 2,
		},
		worktrees: { baseDir: ".overstory/worktrees" },
		beads: { enabled: false },
		mulch: { enabled: false, domains: [], primeFormat: "markdown" },
		merge: { aiResolveEnabled: false, reimagineEnabled: false },
		watchdog: {
			tier0Enabled: false,
			tier0IntervalMs: 30_000,
			tier1Enabled: false,
			tier2Enabled: false,
			staleThresholdMs: 300_000,
			zombieThresholdMs: 600_000,
			nudgeIntervalMs: 60_000,
		},
		models: {},
		logging: { verbose: false, redactSecrets: false },
		...overrides,
	};
}

/**
 * resolveDriverForSession and resolveDriverForSpawn use dynamic imports that
 * pull in modules depending on bundled-defs.ts (a generated file not present
 * in the worktree). We test the full factory path for codex-daemon (which does
 * not need bundled-defs), and test the runtime resolution + driver name contract
 * via direct driver instantiation for claude and codex runtimes.
 */
describe("resolveDriverForSession — codex-daemon", () => {
	test("returns CodexDaemonDriver with ensureDaemonRunning when daemon.json does not exist", async () => {
		const config = makeConfig();
		// No daemon.json → driver is returned with ensureDaemonRunning injected (auto-start)
		const driver = await resolveDriverForSession("codex-daemon", config);
		expect(driver.name).toBe("codex-daemon");
	});

	test("returns CodexDaemonDriver with live state when daemon.json is valid", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "overstory-resolve-test-"));
		const overstoryDir = join(tmpDir, ".overstory");
		mkdirSync(overstoryDir);
		writeFileSync(
			join(overstoryDir, "daemon.json"),
			JSON.stringify({
				pid: process.pid,
				port: 21817,
				startedAt: new Date().toISOString(),
				url: "http://127.0.0.1:21817",
				token: "test-resolve-token",
			}),
		);
		try {
			const config: OverstoryConfig = {
				...makeConfig(),
				project: { name: "test-project", root: tmpDir, canonicalBranch: "main" },
			};
			const driver = await resolveDriverForSession("codex-daemon", config);
			expect(driver.name).toBe("codex-daemon");
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});

describe("resolveDriverForSpawn — runtime resolution", () => {
	// These tests validate that resolveDriverForSpawn correctly delegates runtime
	// resolution to resolveRuntimeForSpawn. The codex-daemon cases exercise the
	// full factory path (reads daemon.json; throws DAEMON_NOT_RUNNING if absent).

	test("codex + intraProcess=true resolves to codex-daemon with auto-start injected", async () => {
		const config = makeConfig({
			codex: {
				enabled: true,
				defaultRuntime: { builder: "codex" as AgentRuntime },
				intraProcess: true,
				model: "codex-mini",
				serverPort: 8765,
				compactionThreshold: 0.3,
				maxDeltaBufferBytes: 1_048_576,
				approvalTimeoutMs: 30_000,
				daemonPort: 0,
			},
		});
		const { runtime, driver } = await resolveDriverForSpawn("builder", config);
		expect(runtime).toBe("codex-daemon");
		expect(driver.name).toBe("codex-daemon");
	});

	test("explicit codex-daemon runtimeFlag returns driver with auto-start", async () => {
		const { runtime, driver } = await resolveDriverForSpawn(
			"builder",
			makeConfig(),
			"codex-daemon",
		);
		expect(runtime).toBe("codex-daemon");
		expect(driver.name).toBe("codex-daemon");
	});

	test("resolveRuntimeForSpawn is used: no codex config defaults to 'claude'", () => {
		// Validate the runtime resolution path that resolveDriverForSpawn delegates to.
		// (The factory itself is tested via the codex-daemon cases above.)
		const runtime = resolveRuntimeForSpawn("builder", makeConfig());
		expect(runtime).toBe("claude");
	});

	test("resolveRuntimeForSpawn is used: capability in defaultRuntime maps to codex", () => {
		const config = makeConfig({
			codex: {
				enabled: true,
				defaultRuntime: { builder: "codex" as AgentRuntime },
				intraProcess: false,
				model: "codex-mini",
				serverPort: 8765,
				compactionThreshold: 0.3,
				maxDeltaBufferBytes: 1_048_576,
				approvalTimeoutMs: 30_000,
				daemonPort: 0,
			},
		});
		const runtime = resolveRuntimeForSpawn("builder", config);
		expect(runtime).toBe("codex");
	});
});
