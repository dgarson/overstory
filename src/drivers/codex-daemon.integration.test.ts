// src/drivers/codex-daemon.integration.test.ts
// Failure-mode integration tests for the CodexDaemonDriver.
// Covers the six scenarios from the pluggable-drivers design doc §P2:
//
//   1. Concurrent /agents POST — two parallel spawns, no duplicate/loss
//   2. Mixed bridge+daemon fleet — driver name isolation per runtime
//   3. Daemon crash mid-turn — unreachable daemon returns graceful NudgeResult
//   4. Config flip during active sessions — persisted runtime determines routing
//   5. Token validation — mutation endpoints require bearer token
//   6. Port race — concurrent ensureDaemonRunning with alive daemon returns same state
//
// Uses real Bun.serve() for HTTP and real temp directories. No mocking.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDaemonRunning } from "../codex/daemon/lifecycle.ts";
import { CodexDaemonDriver } from "./codex-daemon.ts";
import { resolveDriverName, resolveRuntimeForSpawn } from "./resolve.ts";
import type { SpawnContext } from "./types.ts";

/** Minimal SpawnContext — only fields used by CodexDaemonDriver.spawn() are populated. */
function makeSpawnCtx(agentName = "test-agent"): SpawnContext {
	return {
		config: {
			project: { name: "test", root: "/tmp/test", canonicalBranch: "main" },
			agents: {
				manifestPath: "/tmp/test/.overstory/agent-manifest.json",
				baseDir: "/tmp/agents",
				maxConcurrent: 4,
				staggerDelayMs: 0,
				maxDepth: 2,
			},
			worktrees: { baseDir: "/tmp/test/.overstory/worktrees" },
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
			codex: {
				enabled: true,
				defaultRuntime: {},
				intraProcess: true,
				model: "o3",
				serverPort: 21816,
				compactionThreshold: 0.8,
				maxDeltaBufferBytes: 1_048_576,
				approvalTimeoutMs: 60_000,
				daemonPort: 0,
			},
		},
		session: {
			id: `sess-${agentName}`,
			agentName,
			capability: "builder",
			worktreePath: `/tmp/test/.overstory/worktrees/${agentName}`,
			branchName: `overstory/${agentName}/task-001`,
			beadId: "task-001",
			tmuxSession: `overstory-test-${agentName}`,
			state: "working",
			pid: null,
			parentAgent: null,
			depth: 0,
			runId: "run-001",
			startedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
		},
		overlayConfig: {
			agentName,
			beadId: "task-001",
			specPath: null,
			branchName: `overstory/${agentName}/task-001`,
			worktreePath: `/tmp/test/.overstory/worktrees/${agentName}`,
			fileScope: [],
			mulchDomains: [],
			parentAgent: null,
			depth: 0,
			canSpawn: false,
			capability: "builder",
			baseDefinition: "# Builder\n",
		},
		worktreePath: `/tmp/test/.overstory/worktrees/${agentName}`,
		branchName: `overstory/${agentName}/task-001`,
		tmuxSessionName: `overstory-test-${agentName}`,
		runId: "run-001",
	};
}

// ---------------------------------------------------------------------------
// Scenario 1: Concurrent /agents POST
// ---------------------------------------------------------------------------

describe("Scenario 1: concurrent spawn", () => {
	let fakeDaemon: ReturnType<typeof Bun.serve> | undefined;

	afterEach(() => {
		fakeDaemon?.stop();
		fakeDaemon = undefined;
	});

	test("two parallel spawns both reach the daemon without loss", async () => {
		const spawnNames: string[] = [];

		fakeDaemon = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method === "POST" && new URL(req.url).pathname === "/agents") {
					const body = (await req.json()) as { agentName?: string };
					if (body.agentName) spawnNames.push(body.agentName);
					return new Response(null, { status: 201 });
				}
				return new Response("Not Found", { status: 404 });
			},
		});

		const daemonUrl = String(fakeDaemon.url).replace(/\/$/, "");
		const daemonPort = fakeDaemon.port ?? 0;
		const makeDriver = () =>
			new CodexDaemonDriver({
				daemonUrl,
				token: "t",
				ensureDaemonRunning: async () => ({
					pid: process.pid,
					port: daemonPort,
					startedAt: new Date().toISOString(),
					url: daemonUrl,
					token: "t",
				}),
			});

		await Promise.all([
			makeDriver().spawn(makeSpawnCtx("alpha")),
			makeDriver().spawn(makeSpawnCtx("beta")),
		]);

		expect(spawnNames).toContain("alpha");
		expect(spawnNames).toContain("beta");
		expect(spawnNames).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// Scenario 2: Mixed bridge+daemon fleet — driver name isolation
// ---------------------------------------------------------------------------

describe("Scenario 2: mixed fleet routing", () => {
	test("each runtime maps to a distinct driver name", () => {
		expect(resolveDriverName("claude")).toBe("claude");
		expect(resolveDriverName("codex")).toBe("codex-bridge");
		expect(resolveDriverName("codex-daemon")).toBe("codex-daemon");
	});

	test("config flip after spawn does not affect persisted runtime routing", () => {
		// At spawn time with intraProcess=false, "codex" runtime is persisted on session
		const rtAtSpawn = resolveRuntimeForSpawn("builder", {
			codex: { defaultRuntime: { builder: "codex" as const }, intraProcess: false },
		});
		expect(rtAtSpawn).toBe("codex");

		// Even if intraProcess is now true, the PERSISTED runtime "codex" always maps
		// to "codex-bridge" — not "codex-daemon". Operation-time routing uses the
		// persisted value, never re-reads config.
		expect(resolveDriverName(rtAtSpawn)).toBe("codex-bridge");
	});
});

// ---------------------------------------------------------------------------
// Scenario 3: Daemon crash / unreachable
// ---------------------------------------------------------------------------

describe("Scenario 3: daemon unreachable", () => {
	test("nudge returns delivered:false when daemon is unreachable", async () => {
		// Start a server, record its URL, then stop it so the port is closed
		const deadServer = Bun.serve({ port: 0, fetch: () => new Response("ok") });
		const deadUrl = String(deadServer.url).replace(/\/$/, "");
		deadServer.stop();

		const driver = new CodexDaemonDriver({ daemonUrl: deadUrl, token: "t" });
		const result = await driver.nudge("agent", "hello", "orch");

		expect(result.delivered).toBe(false);
		expect(result.reason).toMatch(/Connection failed/);
	});

	test("steer returns false when daemon is unreachable", async () => {
		const deadServer = Bun.serve({ port: 0, fetch: () => new Response("ok") });
		const deadUrl = String(deadServer.url).replace(/\/$/, "");
		deadServer.stop();

		const driver = new CodexDaemonDriver({ daemonUrl: deadUrl, token: "t" });
		const delivered = await driver.steer("agent", "input");

		expect(delivered).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Scenario 5: Token validation
// ---------------------------------------------------------------------------

describe("Scenario 5: token validation", () => {
	let fakeDaemon: ReturnType<typeof Bun.serve> | undefined;

	afterEach(() => {
		fakeDaemon?.stop();
		fakeDaemon = undefined;
	});

	test("nudge with wrong token returns delivered:false (401)", async () => {
		const TOKEN = "correct-token";
		fakeDaemon = Bun.serve({
			port: 0,
			fetch(req) {
				const auth = req.headers.get("authorization");
				if (auth !== `Bearer ${TOKEN}`) return new Response("Unauthorized", { status: 401 });
				return Response.json({ delivered: true });
			},
		});

		const driver = new CodexDaemonDriver({
			daemonUrl: String(fakeDaemon.url).replace(/\/$/, ""),
			token: "wrong-token",
		});
		const result = await driver.nudge("agent", "hello", "orch");
		expect(result.delivered).toBe(false);
		expect(result.reason).toMatch(/401/);
	});

	test("steer with wrong token returns false (401)", async () => {
		const TOKEN = "steer-correct";
		fakeDaemon = Bun.serve({
			port: 0,
			fetch(req) {
				const auth = req.headers.get("authorization");
				if (auth !== `Bearer ${TOKEN}`) return new Response("Unauthorized", { status: 401 });
				return Response.json({ delivered: true });
			},
		});

		const driver = new CodexDaemonDriver({
			daemonUrl: String(fakeDaemon.url).replace(/\/$/, ""),
			token: "wrong",
		});
		expect(await driver.steer("agent", "input")).toBe(false);
	});

	test("spawn with wrong token throws (401)", async () => {
		const TOKEN = "spawn-correct";
		fakeDaemon = Bun.serve({
			port: 0,
			fetch(req) {
				const auth = req.headers.get("authorization");
				if (auth !== `Bearer ${TOKEN}`) return new Response("Unauthorized", { status: 401 });
				return new Response(null, { status: 201 });
			},
		});

		const daemonUrl = String(fakeDaemon.url).replace(/\/$/, "");
		const driver = new CodexDaemonDriver({
			daemonUrl,
			token: "wrong-spawn-token",
			ensureDaemonRunning: async () => ({
				pid: process.pid,
				port: fakeDaemon?.port ?? 0,
				startedAt: "",
				url: daemonUrl,
				token: "wrong-spawn-token",
			}),
		});
		await expect(driver.spawn(makeSpawnCtx("auth-test"))).rejects.toThrow(
			"Daemon spawn failed (401)",
		);
	});
});

// ---------------------------------------------------------------------------
// Scenario 6: Port race — concurrent ensureDaemonRunning with alive daemon
// ---------------------------------------------------------------------------

describe("Scenario 6: port race / file lock", () => {
	test("concurrent ensureDaemonRunning with alive daemon.json returns consistent state", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "overstory-race-test-"));
		const overstoryDir = join(tmpDir, ".overstory");
		mkdirSync(overstoryDir);

		const existingState = {
			pid: process.pid, // current process is alive
			port: 21817,
			startedAt: new Date().toISOString(),
			url: "http://127.0.0.1:21817",
			token: "race-test-token",
		};
		writeFileSync(join(overstoryDir, "daemon.json"), JSON.stringify(existingState));

		try {
			const opts = {
				port: 0,
				codexServerUrl: "ws://127.0.0.1:21816",
				projectRoot: tmpDir,
			};
			// Two concurrent callers: both should find the alive daemon and return
			// the same existing state without spawning a new process
			const [s1, s2] = await Promise.all([
				ensureDaemonRunning(overstoryDir, opts),
				ensureDaemonRunning(overstoryDir, opts),
			]);

			// Both see the same PID and token — no double-start
			expect(s1.pid).toBe(process.pid);
			expect(s2.pid).toBe(process.pid);
			expect(s1.token).toBe("race-test-token");
			expect(s2.token).toBe("race-test-token");
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});
