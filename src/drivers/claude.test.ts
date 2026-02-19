/**
 * Tests for ClaudeDriver.
 *
 * Why DI instead of mock.module():
 * mock.module() leaks across test files in bun:test (see mulch record mx-56558b).
 * DI-injected fakes are self-contained and don't affect other test modules.
 *
 * Why no real tmux:
 * Real tmux operations interfere with developer sessions and are fragile in CI.
 */

import { describe, expect, test } from "bun:test";
import type { OverlayConfig, OverstoryConfig } from "../types.ts";
import type { ClaudeDriverDeps, SpawnContext } from "./claude.ts";
import { ClaudeDriver } from "./claude.ts";

// ---------------------------------------------------------------------------
// Minimal fixture builders
// ---------------------------------------------------------------------------

function makeConfig(): OverstoryConfig {
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
	};
}

function makeOverlayConfig(): OverlayConfig {
	return {
		agentName: "test-agent",
		beadId: "task-abc",
		specPath: null,
		branchName: "overstory/test-agent/task-abc",
		worktreePath: "/tmp/test-project/.overstory/worktrees/test-agent",
		fileScope: [],
		mulchDomains: [],
		parentAgent: null,
		depth: 1,
		canSpawn: false,
		capability: "builder",
		baseDefinition: "# Builder Agent\n",
	};
}

function makeSpawnContext(overrides: Partial<SpawnContext> = {}): SpawnContext {
	const config = makeConfig();
	const overlayConfig = makeOverlayConfig();
	return {
		config,
		session: {
			id: "session-123",
			agentName: "test-agent",
			capability: "builder",
			worktreePath: "/tmp/test-project/.overstory/worktrees/test-agent",
			branchName: "overstory/test-agent/task-abc",
			beadId: "task-abc",
			tmuxSession: "overstory-test-project-test-agent",
			state: "booting",
			pid: null,
			parentAgent: null,
			depth: 1,
			runId: "run-2024",
			startedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
			runtime: "claude",
		},
		overlayConfig,
		worktreePath: "/tmp/test-project/.overstory/worktrees/test-agent",
		branchName: "overstory/test-agent/task-abc",
		tmuxSessionName: "overstory-test-project-test-agent",
		runId: "run-2024",
		model: "claude-opus-4-5",
		beaconText: "[OVERSTORY] test-agent (builder) — read .claude/CLAUDE.md",
		...overrides,
	};
}

function makeDeps(overrides: Partial<ClaudeDriverDeps> = {}): ClaudeDriverDeps {
	return {
		createSession: async (_name, _cwd, _cmd, _env) => 42,
		sendKeys: async (_session, _text) => {},
		isSessionAlive: async (_session) => true,
		writeOverlay: async (_worktreePath, _config, _canonicalRoot) => {},
		deployHooks: async (_worktreePath, _agentName, _capability) => {},
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ClaudeDriver", () => {
	test("name is 'claude'", () => {
		const driver = new ClaudeDriver(makeDeps());
		expect(driver.name).toBe("claude");
	});

	test("spawn calls writeOverlay with worktreePath and overlayConfig", async () => {
		const calls: Array<{ worktreePath: string; agentName: string }> = [];
		const deps = makeDeps({
			writeOverlay: async (worktreePath, config, _canonicalRoot) => {
				calls.push({ worktreePath, agentName: config.agentName });
			},
		});
		const driver = new ClaudeDriver(deps);
		await driver.spawn(makeSpawnContext());
		expect(calls.length).toBe(1);
		expect(calls[0]?.worktreePath).toBe("/tmp/test-project/.overstory/worktrees/test-agent");
		expect(calls[0]?.agentName).toBe("test-agent");
	});

	test("spawn calls deployHooks with worktreePath, agentName, capability", async () => {
		const calls: Array<{ worktreePath: string; agentName: string; capability: string }> = [];
		const deps = makeDeps({
			deployHooks: async (worktreePath, agentName, capability) => {
				calls.push({ worktreePath, agentName, capability: capability ?? "builder" });
			},
		});
		const driver = new ClaudeDriver(deps);
		await driver.spawn(makeSpawnContext());
		expect(calls.length).toBe(1);
		expect(calls[0]?.agentName).toBe("test-agent");
		expect(calls[0]?.capability).toBe("builder");
	});

	test("spawn calls createSession with claude command and returns pid", async () => {
		const sessionCalls: Array<{ name: string; cmd: string }> = [];
		const deps = makeDeps({
			createSession: async (name, _cwd, cmd, _env) => {
				sessionCalls.push({ name, cmd });
				return 99;
			},
		});
		const driver = new ClaudeDriver(deps);
		const result = await driver.spawn(makeSpawnContext());
		expect(result.pid).toBe(99);
		expect(sessionCalls.length).toBe(1);
		expect(sessionCalls[0]?.cmd).toContain("claude");
		expect(sessionCalls[0]?.name).toBe("overstory-test-project-test-agent");
	});

	test("spawn sends beacon via sendKeys after createSession", async () => {
		const keysSent: string[] = [];
		const deps = makeDeps({
			sendKeys: async (_session, text) => {
				keysSent.push(text);
			},
		});
		const driver = new ClaudeDriver(deps);
		await driver.spawn(makeSpawnContext());
		// Should have sent the beacon and follow-up Enter
		expect(keysSent.length).toBeGreaterThanOrEqual(2);
		// At least one non-empty message (the beacon)
		const nonEmpty = keysSent.filter((k) => k.length > 0);
		expect(nonEmpty.length).toBeGreaterThanOrEqual(1);
	});

	test("spawn passes OVERSTORY_AGENT_NAME env to createSession", async () => {
		const envCaptures: Array<Record<string, string>> = [];
		const deps = makeDeps({
			createSession: async (_name, _cwd, _cmd, env) => {
				if (env) envCaptures.push(env);
				return 1;
			},
		});
		const driver = new ClaudeDriver(deps);
		await driver.spawn(makeSpawnContext());
		expect(envCaptures.length).toBe(1);
		expect(envCaptures[0]?.OVERSTORY_AGENT_NAME).toBe("test-agent");
	});

	test("nudge returns delivered=true when session is alive", async () => {
		const driver = new ClaudeDriver(
			makeDeps({
				isSessionAlive: async () => true,
			}),
		);
		const result = await driver.nudge("test-agent", "hello", "orchestrator");
		expect(result.delivered).toBe(true);
	});

	test("nudge returns delivered=false when session is dead", async () => {
		const driver = new ClaudeDriver(
			makeDeps({
				isSessionAlive: async () => false,
			}),
		);
		const result = await driver.nudge("test-agent", "hello", "orchestrator");
		expect(result.delivered).toBe(false);
		expect(result.reason).toBeDefined();
	});

	test("nudge calls sendKeys with message when session is alive", async () => {
		const sentMessages: string[] = [];
		const driver = new ClaudeDriver(
			makeDeps({
				isSessionAlive: async () => true,
				sendKeys: async (_session, text) => {
					sentMessages.push(text);
				},
			}),
		);
		await driver.nudge("test-agent", "check your mail", "orchestrator");
		const nonEmpty = sentMessages.filter((m) => m.length > 0);
		expect(nonEmpty.length).toBeGreaterThanOrEqual(1);
		expect(nonEmpty[0]).toContain("check your mail");
	});

	test("nudge skips session alive check when opts.force is true", async () => {
		let aliveChecked = false;
		const driver = new ClaudeDriver(
			makeDeps({
				isSessionAlive: async () => {
					aliveChecked = true;
					return false;
				},
			}),
		);
		// force=true should skip debounce but still check alive (alive check is not debounce)
		// The intent is: force skips debounce, not the liveness check.
		// When session is dead even with force, delivery fails.
		const result = await driver.nudge("test-agent", "msg", "orch", { force: true });
		expect(aliveChecked).toBe(true);
		expect(result.delivered).toBe(false);
	});

	test("steer delegates to nudge and returns delivered boolean", async () => {
		const driver = new ClaudeDriver(
			makeDeps({
				isSessionAlive: async () => true,
			}),
		);
		const result = await driver.steer("test-agent", "do this");
		expect(result).toBe(true);
	});

	test("steer returns false when session is dead", async () => {
		const driver = new ClaudeDriver(
			makeDeps({
				isSessionAlive: async () => false,
			}),
		);
		const result = await driver.steer("test-agent", "do this");
		expect(result).toBe(false);
	});

	test("inspect returns AgentInspection with state field", async () => {
		const driver = new ClaudeDriver(makeDeps());
		const inspection = await driver.inspect("test-agent");
		expect(inspection.state).toBeDefined();
		expect(inspection.lastActivity).toBeDefined();
	});

	test("shutdown does not throw", async () => {
		const driver = new ClaudeDriver(makeDeps());
		await expect(driver.shutdown("test-agent")).resolves.toBeUndefined();
	});

	test("close does not throw", async () => {
		const driver = new ClaudeDriver(makeDeps());
		await expect(driver.close()).resolves.toBeUndefined();
	});
});
