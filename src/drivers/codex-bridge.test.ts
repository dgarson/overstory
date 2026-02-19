/**
 * Tests for CodexBridgeDriver.
 *
 * Why DI instead of mock.module(): mock.module() leaks across test files in bun:test.
 * All external dependencies (createSession, startServer, writeAgentsOverlay,
 * writeCodexConfig, sendMail) are injected as fakes so tests remain isolated
 * and fast. See mulch record mx-56558b for background.
 */

import { describe, expect, test } from "bun:test";
import type { CodexServerState } from "../codex/types";
import type { AgentRuntime, OverlayConfig } from "../types";
import type { CodexBridgeDriverDeps } from "./codex-bridge";
import { CodexBridgeDriver } from "./codex-bridge";
import type { SpawnContext } from "./types";

/** Build a minimal valid SpawnContext for tests */
function makeSpawnContext(overrides?: Partial<SpawnContext>): SpawnContext {
	return {
		config: {
			project: { name: "test-proj", root: "/tmp/test-proj", canonicalBranch: "main" },
			agents: {
				manifestPath: ".overstory/agent-manifest.json",
				baseDir: "agents",
				maxConcurrent: 5,
				staggerDelayMs: 0,
				maxDepth: 2,
			},
			worktrees: { baseDir: ".overstory/worktrees" },
			beads: { enabled: false },
			mulch: { enabled: false, domains: [], primeFormat: "markdown" },
			merge: { aiResolveEnabled: false, reimagineEnabled: false },
			watchdog: {
				tier0Enabled: false,
				tier0IntervalMs: 30000,
				tier1Enabled: false,
				tier2Enabled: false,
				staleThresholdMs: 60000,
				zombieThresholdMs: 120000,
				nudgeIntervalMs: 60000,
			},
			models: {},
			logging: { verbose: false, redactSecrets: false },
			codex: {
				enabled: true,
				defaultRuntime: {},
				serverPort: 9876,
				model: "gpt-4o",
				compactionThreshold: 0.8,
				maxDeltaBufferBytes: 65536,
				approvalTimeoutMs: 30000,
				intraProcess: false,
				daemonPort: 0,
			},
		},
		session: {
			id: "session-test-001",
			agentName: "test-agent",
			capability: "builder",
			worktreePath: "/tmp/test-proj/.overstory/worktrees/test-agent",
			branchName: "overstory/test-agent/task-001",
			beadId: "task-001",
			tmuxSession: "overstory-test-proj-test-agent",
			state: "booting",
			pid: 0,
			parentAgent: null,
			depth: 0,
			runId: "run-001",
			startedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
			runtime: "codex" as AgentRuntime,
		},
		overlayConfig: {
			agentName: "test-agent",
			beadId: "task-001",
			specPath: null,
			branchName: "overstory/test-agent/task-001",
			worktreePath: "/tmp/test-proj/.overstory/worktrees/test-agent",
			fileScope: ["src/foo.ts"],
			mulchDomains: [],
			parentAgent: null,
			depth: 0,
			canSpawn: false,
			capability: "builder",
			baseDefinition: "# Builder\nYou are a builder.",
			mulchExpertise: undefined,
		} as OverlayConfig,
		worktreePath: "/tmp/test-proj/.overstory/worktrees/test-agent",
		branchName: "overstory/test-agent/task-001",
		tmuxSessionName: "overstory-test-proj-test-agent",
		runId: "run-001",
		...overrides,
	};
}

const fakeServerState: CodexServerState = {
	pid: 12345,
	port: 9876,
	startedAt: new Date().toISOString(),
	url: "ws://127.0.0.1:9876",
};

/** Build a minimal valid deps object with all fakes. */
function makeDeps(overrides?: Partial<CodexBridgeDriverDeps>): CodexBridgeDriverDeps {
	return {
		createSession: async (_name, _cwd, _cmd, _env) => 9999,
		startServer: async (_overstoryDir, _port) => fakeServerState,
		writeAgentsOverlay: async (_worktreePath, _config, _canonicalRoot) => {},
		writeCodexConfig: async (_worktreePath, _opts) => {},
		sendMail: (_mailDbPath, _opts) => {},
		getBridgePid: async (_overstoryDir, _agentName) => null,
		processKill: (_pid, _signal) => {},
		...overrides,
	};
}

describe("CodexBridgeDriver.name", () => {
	test("is 'codex-bridge'", () => {
		const driver = new CodexBridgeDriver(makeDeps());
		expect(driver.name).toBe("codex-bridge");
	});
});

describe("CodexBridgeDriver.spawn", () => {
	test("calls writeAgentsOverlay with correct args", async () => {
		const calls: Array<[string, OverlayConfig, string]> = [];
		const driver = new CodexBridgeDriver(
			makeDeps({
				writeAgentsOverlay: async (worktreePath, config, canonicalRoot) => {
					calls.push([worktreePath, config, canonicalRoot]);
				},
			}),
		);

		const ctx = makeSpawnContext();
		await driver.spawn(ctx);

		expect(calls.length).toBe(1);
		const [wt, cfg, root] = calls[0]!;
		expect(wt).toBe(ctx.worktreePath);
		expect(cfg).toBe(ctx.overlayConfig);
		expect(root).toBe(ctx.config.project.root);
	});

	test("calls writeCodexConfig with model and approval policy", async () => {
		const calls: Array<[string, { model: string; approvalPolicy: string }]> = [];
		const driver = new CodexBridgeDriver(
			makeDeps({
				writeCodexConfig: async (worktreePath, opts) => {
					calls.push([worktreePath, opts]);
				},
			}),
		);

		const ctx = makeSpawnContext();
		await driver.spawn(ctx);

		expect(calls.length).toBe(1);
		const [wt, opts] = calls[0]!;
		expect(wt).toBe(ctx.worktreePath);
		expect(opts.model).toBe("gpt-4o");
		expect(opts.approvalPolicy).toBe("on-request");
	});

	test("calls startServer with overstoryDir and serverPort", async () => {
		const calls: Array<[string, number]> = [];
		const driver = new CodexBridgeDriver(
			makeDeps({
				startServer: async (overstoryDir, port) => {
					calls.push([overstoryDir, port]);
					return fakeServerState;
				},
			}),
		);

		const ctx = makeSpawnContext();
		await driver.spawn(ctx);

		expect(calls.length).toBe(1);
		const [dir, port] = calls[0]!;
		expect(dir).toEndWith(".overstory");
		expect(port).toBe(9876);
	});

	test("calls createSession with correct tmux session name and env vars", async () => {
		const calls: Array<[string, string, string, Record<string, string> | undefined]> = [];
		const driver = new CodexBridgeDriver(
			makeDeps({
				createSession: async (name, cwd, cmd, env) => {
					calls.push([name, cwd, cmd, env]);
					return 9999;
				},
			}),
		);

		const ctx = makeSpawnContext();
		await driver.spawn(ctx);

		expect(calls.length).toBe(1);
		const [name, cwd, cmd, env] = calls[0]!;
		expect(name).toBe(ctx.tmuxSessionName);
		expect(cwd).toBe(ctx.worktreePath);
		expect(cmd).toContain("bridge.ts");
		expect(env?.OVERSTORY_AGENT_NAME).toBe("test-agent");
		expect(env?.OVERSTORY_CODEX_SERVER_URL).toBe(fakeServerState.url);
		expect(env?.OVERSTORY_CODEX_MODEL).toBe("gpt-4o");
		expect(env?.OVERSTORY_FILE_SCOPE).toBe("src/foo.ts");
	});

	test("returns SpawnResult with pid from createSession", async () => {
		const driver = new CodexBridgeDriver(
			makeDeps({
				createSession: async () => 42,
			}),
		);

		const result = await driver.spawn(makeSpawnContext());
		expect(result.pid).toBe(42);
	});

	test("throws ConfigError if config.codex is missing", async () => {
		const driver = new CodexBridgeDriver(makeDeps());
		const ctx = makeSpawnContext();
		// Remove codex config
		ctx.config.codex = undefined;

		await expect(driver.spawn(ctx)).rejects.toThrow(/codex/i);
	});
});

describe("CodexBridgeDriver.nudge", () => {
	test("returns NudgeResult with delivered=true after sending mail", async () => {
		const driver = new CodexBridgeDriver(makeDeps());
		const result = await driver.nudge("test-agent", "check mail", "orchestrator");
		expect(result.delivered).toBe(true);
	});

	test("sends mail to the agent", async () => {
		const mailCalls: Array<{ to: string; body: string }> = [];
		const driver = new CodexBridgeDriver(
			makeDeps({
				sendMail: (_mailDbPath, opts) => {
					mailCalls.push({ to: opts.to, body: opts.body });
				},
			}),
		);

		await driver.nudge("test-agent", "wake up", "watchdog");
		expect(mailCalls.length).toBe(1);
		expect(mailCalls[0]?.to).toBe("test-agent");
		expect(mailCalls[0]?.body).toBe("wake up");
	});

	test("sends SIGUSR1 to bridge PID when available", async () => {
		const signals: Array<[number, string | number]> = [];
		const driver = new CodexBridgeDriver(
			makeDeps({
				getBridgePid: async (_overstoryDir, _agentName) => 5555,
				processKill: (pid, signal) => {
					signals.push([pid, signal]);
				},
			}),
		);

		await driver.nudge("test-agent", "check mail", "orchestrator");

		// Should have called kill(5555, 0) to check alive and kill(5555, SIGUSR1)
		const usr1 = signals.find(([pid, sig]) => pid === 5555 && sig === "SIGUSR1");
		expect(usr1).toBeDefined();
	});

	test("returns delivered=true even when bridge PID is null (mail-only)", async () => {
		const driver = new CodexBridgeDriver(
			makeDeps({
				getBridgePid: async () => null,
			}),
		);

		const result = await driver.nudge("test-agent", "check mail", "orchestrator");
		expect(result.delivered).toBe(true);
	});

	test("nudge with force=true skips debounce", async () => {
		let callCount = 0;
		const driver = new CodexBridgeDriver(
			makeDeps({
				sendMail: (_mailDbPath, _opts) => {
					callCount++;
				},
			}),
		);

		// First call without force
		await driver.nudge("test-agent", "check mail", "orchestrator");
		// Second call immediately (would be debounced) with force=true
		const result = await driver.nudge("test-agent", "escalation", "watchdog", { force: true });

		expect(result.delivered).toBe(true);
		// Both calls should have gone through (force bypasses debounce)
		expect(callCount).toBe(2);
	});
});

describe("CodexBridgeDriver.steer", () => {
	test("returns false (no active turn for bridge agents)", async () => {
		const driver = new CodexBridgeDriver(makeDeps());
		const result = await driver.steer("test-agent", "some input");
		expect(result).toBe(false);
	});
});

describe("CodexBridgeDriver.inspect", () => {
	test("returns AgentInspection with state=unknown", async () => {
		const driver = new CodexBridgeDriver(makeDeps());
		const result = await driver.inspect("test-agent");
		expect(result).toBeDefined();
		expect(typeof result.state).toBe("string");
		expect(typeof result.lastActivity).toBe("string");
	});
});

describe("CodexBridgeDriver.shutdown", () => {
	test("resolves without throwing", async () => {
		const driver = new CodexBridgeDriver(makeDeps());
		await expect(driver.shutdown("test-agent")).resolves.toBeUndefined();
	});
});

describe("CodexBridgeDriver.close", () => {
	test("resolves without throwing", async () => {
		const driver = new CodexBridgeDriver(makeDeps());
		await expect(driver.close()).resolves.toBeUndefined();
	});
});
