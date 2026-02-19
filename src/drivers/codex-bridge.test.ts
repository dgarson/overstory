/**
 * Tests for CodexBridgeDriver.
 *
 * Why DI instead of mock.module(): mock.module() leaks across test files in bun:test.
 * All external dependencies (createSession, startServer, writeAgentsOverlay,
 * writeCodexConfig, sendMail) are injected as fakes so tests remain isolated
 * and fast. See mulch record mx-56558b for background.
 *
 * File-persisted debounce tests use real temp directories so we can verify
 * cross-call debounce state without mocking the filesystem.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
		const driver = new CodexBridgeDriver(makeDeps(), "/fake/overstory");
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
			"/fake/overstory",
		);

		const ctx = makeSpawnContext();
		await driver.spawn(ctx);

		expect(calls.length).toBe(1);
		const firstCall = calls[0];
		expect(firstCall).toBeDefined();
		if (!firstCall) return;
		const [wt, cfg, root] = firstCall;
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
			"/fake/overstory",
		);

		const ctx = makeSpawnContext();
		await driver.spawn(ctx);

		expect(calls.length).toBe(1);
		const firstCall = calls[0];
		expect(firstCall).toBeDefined();
		if (!firstCall) return;
		const [wt, opts] = firstCall;
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
			"/fake/overstory",
		);

		const ctx = makeSpawnContext();
		await driver.spawn(ctx);

		expect(calls.length).toBe(1);
		const firstCall = calls[0];
		expect(firstCall).toBeDefined();
		if (!firstCall) return;
		const [dir, port] = firstCall;
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
			"/fake/overstory",
		);

		const ctx = makeSpawnContext();
		await driver.spawn(ctx);

		expect(calls.length).toBe(1);
		const firstCall = calls[0];
		expect(firstCall).toBeDefined();
		if (!firstCall) return;
		const [name, cwd, cmd, env] = firstCall;
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
			"/fake/overstory",
		);

		const result = await driver.spawn(makeSpawnContext());
		expect(result.pid).toBe(42);
	});

	test("throws ConfigError if config.codex is missing", async () => {
		const driver = new CodexBridgeDriver(makeDeps(), "/fake/overstory");
		const ctx = makeSpawnContext();
		// Remove codex config
		ctx.config.codex = undefined;

		await expect(driver.spawn(ctx)).rejects.toThrow(/codex/i);
	});
});

describe("CodexBridgeDriver.nudge", () => {
	test("returns NudgeResult with delivered=true after sending mail", async () => {
		const tmpDir = await mkdtemp(join(tmpdir(), "overstory-test-"));
		try {
			const driver = new CodexBridgeDriver(makeDeps(), tmpDir);
			const result = await driver.nudge("test-agent", "check mail", "orchestrator");
			expect(result.delivered).toBe(true);
		} finally {
			await rm(tmpDir, { recursive: true, force: true });
		}
	});

	test("sends mail to the agent", async () => {
		const tmpDir = await mkdtemp(join(tmpdir(), "overstory-test-"));
		try {
			const mailCalls: Array<{ to: string; body: string }> = [];
			const driver = new CodexBridgeDriver(
				makeDeps({
					sendMail: (_mailDbPath, opts) => {
						mailCalls.push({ to: opts.to, body: opts.body });
					},
				}),
				tmpDir,
			);

			await driver.nudge("test-agent", "wake up", "watchdog");
			expect(mailCalls.length).toBe(1);
			expect(mailCalls[0]?.to).toBe("test-agent");
			expect(mailCalls[0]?.body).toBe("wake up");
		} finally {
			await rm(tmpDir, { recursive: true, force: true });
		}
	});

	test("sendMail is called with correct mailDbPath derived from overstoryDir", async () => {
		const tmpDir = await mkdtemp(join(tmpdir(), "overstory-test-"));
		try {
			const mailPaths: string[] = [];
			const driver = new CodexBridgeDriver(
				makeDeps({
					sendMail: (mailDbPath, _opts) => {
						mailPaths.push(mailDbPath);
					},
				}),
				tmpDir,
			);

			await driver.nudge("test-agent", "check mail", "orchestrator");
			expect(mailPaths.length).toBe(1);
			expect(mailPaths[0]).toBe(join(tmpDir, "mail.db"));
		} finally {
			await rm(tmpDir, { recursive: true, force: true });
		}
	});

	test("getBridgePid is called with correct overstoryDir", async () => {
		const tmpDir = await mkdtemp(join(tmpdir(), "overstory-test-"));
		try {
			const pidCalls: Array<[string, string]> = [];
			const driver = new CodexBridgeDriver(
				makeDeps({
					getBridgePid: async (overstoryDir, agentName) => {
						pidCalls.push([overstoryDir, agentName]);
						return null;
					},
				}),
				tmpDir,
			);

			await driver.nudge("test-agent", "check mail", "orchestrator");
			expect(pidCalls.length).toBe(1);
			const firstCall = pidCalls[0];
			expect(firstCall).toBeDefined();
			if (!firstCall) return;
			expect(firstCall[0]).toBe(tmpDir);
			expect(firstCall[1]).toBe("test-agent");
		} finally {
			await rm(tmpDir, { recursive: true, force: true });
		}
	});

	test("sends SIGUSR1 to bridge PID when available", async () => {
		const tmpDir = await mkdtemp(join(tmpdir(), "overstory-test-"));
		try {
			const signals: Array<[number, string | number]> = [];
			const driver = new CodexBridgeDriver(
				makeDeps({
					getBridgePid: async (_overstoryDir, _agentName) => 5555,
					processKill: (pid, signal) => {
						signals.push([pid, signal]);
					},
				}),
				tmpDir,
			);

			await driver.nudge("test-agent", "check mail", "orchestrator");

			// Should have called kill(5555, 0) to check alive and kill(5555, SIGUSR1)
			const usr1 = signals.find(([pid, sig]) => pid === 5555 && sig === "SIGUSR1");
			expect(usr1).toBeDefined();
		} finally {
			await rm(tmpDir, { recursive: true, force: true });
		}
	});

	test("returns delivered=true even when bridge PID is null (mail-only)", async () => {
		const tmpDir = await mkdtemp(join(tmpdir(), "overstory-test-"));
		try {
			const driver = new CodexBridgeDriver(
				makeDeps({
					getBridgePid: async () => null,
				}),
				tmpDir,
			);

			const result = await driver.nudge("test-agent", "check mail", "orchestrator");
			expect(result.delivered).toBe(true);
		} finally {
			await rm(tmpDir, { recursive: true, force: true });
		}
	});

	test("rapid second nudge without force is debounced", async () => {
		const tmpDir = await mkdtemp(join(tmpdir(), "overstory-test-"));
		try {
			let callCount = 0;
			const driver = new CodexBridgeDriver(
				makeDeps({
					sendMail: (_mailDbPath, _opts) => {
						callCount++;
					},
				}),
				tmpDir,
			);

			// First call succeeds
			const r1 = await driver.nudge("test-agent", "check mail", "orchestrator");
			expect(r1.delivered).toBe(true);

			// Immediate second call should be debounced (nudge-state.json was written)
			const r2 = await driver.nudge("test-agent", "check mail again", "orchestrator");
			expect(r2.delivered).toBe(false);
			expect(r2.reason).toBe("debounced");

			// Only the first call should have sent mail
			expect(callCount).toBe(1);
		} finally {
			await rm(tmpDir, { recursive: true, force: true });
		}
	});

	test("nudge with force=true skips debounce", async () => {
		const tmpDir = await mkdtemp(join(tmpdir(), "overstory-test-"));
		try {
			let callCount = 0;
			const driver = new CodexBridgeDriver(
				makeDeps({
					sendMail: (_mailDbPath, _opts) => {
						callCount++;
					},
				}),
				tmpDir,
			);

			// First call without force
			await driver.nudge("test-agent", "check mail", "orchestrator");
			// Second call immediately (would be debounced) with force=true
			const result = await driver.nudge("test-agent", "escalation", "watchdog", { force: true });

			expect(result.delivered).toBe(true);
			// Both calls should have gone through (force bypasses debounce)
			expect(callCount).toBe(2);
		} finally {
			await rm(tmpDir, { recursive: true, force: true });
		}
	});
});

describe("CodexBridgeDriver.steer", () => {
	test("returns false (no active turn for bridge agents)", async () => {
		const driver = new CodexBridgeDriver(makeDeps(), "/fake/overstory");
		const result = await driver.steer("test-agent", "some input");
		expect(result).toBe(false);
	});
});

describe("CodexBridgeDriver.inspect", () => {
	test("returns AgentInspection with state=working", async () => {
		const driver = new CodexBridgeDriver(makeDeps(), "/fake/overstory");
		const result = await driver.inspect("test-agent");
		expect(result).toBeDefined();
		expect(result.state).toBe("working");
		expect(typeof result.lastActivity).toBe("string");
	});
});

describe("CodexBridgeDriver.shutdown", () => {
	test("resolves without throwing when no bridge PID", async () => {
		const driver = new CodexBridgeDriver(makeDeps(), "/fake/overstory");
		await expect(driver.shutdown("test-agent")).resolves.toBeUndefined();
	});

	test("sends SIGTERM to bridge PID when available", async () => {
		const signals: Array<[number, string | number]> = [];
		const driver = new CodexBridgeDriver(
			makeDeps({
				getBridgePid: async () => 7777,
				processKill: (pid, signal) => {
					signals.push([pid, signal]);
				},
			}),
			"/fake/overstory",
		);

		await driver.shutdown("test-agent");

		const sigterm = signals.find(([pid, sig]) => pid === 7777 && sig === "SIGTERM");
		expect(sigterm).toBeDefined();
	});

	test("does not throw when processKill throws (stale PID)", async () => {
		const driver = new CodexBridgeDriver(
			makeDeps({
				getBridgePid: async () => 8888,
				processKill: (_pid, _signal) => {
					throw new Error("ESRCH: no such process");
				},
			}),
			"/fake/overstory",
		);

		await expect(driver.shutdown("test-agent")).resolves.toBeUndefined();
	});
});

describe("CodexBridgeDriver.close", () => {
	test("resolves without throwing", async () => {
		const driver = new CodexBridgeDriver(makeDeps(), "/fake/overstory");
		await expect(driver.close()).resolves.toBeUndefined();
	});
});
