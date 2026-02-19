// src/drivers/codex-daemon.test.ts
// Uses real Bun.serve() as a fake HTTP server instead of mocks.
// Real HTTP transport is the natural test boundary for an HTTP client driver.

import { afterEach, describe, expect, test } from "bun:test";
import { CodexDaemonDriver } from "./codex-daemon.ts";
import type { SpawnContext } from "./types.ts";

/** Minimal SpawnContext for tests. Only fields used by CodexDaemonDriver.spawn() are populated. */
function makeSpawnContext(overrides: Partial<SpawnContext> = {}): SpawnContext {
	return {
		config: {
			project: {
				name: "test-project",
				root: "/tmp/test-project",
				canonicalBranch: "main",
			},
			agents: {
				manifestPath: "/tmp/test-project/.overstory/agent-manifest.json",
				baseDir: "/tmp/agents",
				maxConcurrent: 4,
				staggerDelayMs: 500,
				maxDepth: 2,
			},
			worktrees: {
				baseDir: "/tmp/test-project/.overstory/worktrees",
			},
			beads: { enabled: false },
			mulch: { enabled: false, domains: [], primeFormat: "markdown" },
			merge: { aiResolveEnabled: false, reimagineEnabled: false },
			watchdog: {
				tier0Enabled: false,
				tier0IntervalMs: 30000,
				tier1Enabled: false,
				tier2Enabled: false,
				staleThresholdMs: 300000,
				zombieThresholdMs: 600000,
				nudgeIntervalMs: 60000,
			},
			models: {},
			logging: { verbose: false, redactSecrets: false },
			codex: undefined,
		},
		session: {
			id: "sess-001",
			agentName: "test-agent",
			capability: "builder",
			worktreePath: "/tmp/test-project/.overstory/worktrees/test-agent",
			branchName: "overstory/test-agent/task-001",
			beadId: "task-001",
			tmuxSession: "overstory-test-project-test-agent",
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
			agentName: "test-agent",
			beadId: "task-001",
			specPath: null,
			branchName: "overstory/test-agent/task-001",
			worktreePath: "/tmp/test-project/.overstory/worktrees/test-agent",
			fileScope: ["src/foo.ts"],
			mulchDomains: [],
			parentAgent: null,
			depth: 0,
			canSpawn: false,
			capability: "builder",
			baseDefinition: "# Builder\n",
		},
		worktreePath: "/tmp/test-project/.overstory/worktrees/test-agent",
		branchName: "overstory/test-agent/task-001",
		tmuxSessionName: "overstory-test-project-test-agent",
		runId: "run-001",
		...overrides,
	};
}

describe("CodexDaemonDriver", () => {
	let fakeDaemon: ReturnType<typeof Bun.serve> | undefined;

	afterEach(() => {
		fakeDaemon?.stop();
		fakeDaemon = undefined;
	});

	test("name is 'codex-daemon'", () => {
		const driver = new CodexDaemonDriver({ daemonUrl: "http://localhost:0", token: "test" });
		expect(driver.name).toBe("codex-daemon");
	});

	test("spawn POSTs to /agents with bearer token", async () => {
		let receivedAuth: string | undefined;
		let receivedBody: unknown = null;

		fakeDaemon = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method === "POST" && new URL(req.url).pathname === "/agents") {
					receivedAuth = req.headers.get("authorization") ?? undefined;
					receivedBody = await req.json();
					return new Response(null, { status: 201 });
				}
				return new Response("Not Found", { status: 404 });
			},
		});

		const daemonUrl = String(fakeDaemon.url).replace(/\/$/, "");
		const daemonPort = fakeDaemon.port;
		const driver = new CodexDaemonDriver({
			daemonUrl,
			token: "test-token",
			ensureDaemonRunning: async () => ({
				pid: process.pid,
				port: daemonPort ?? 0,
				startedAt: new Date().toISOString(),
				url: daemonUrl,
				token: "test-token",
			}),
		});

		await driver.spawn(makeSpawnContext());
		expect(receivedAuth).toBe("Bearer test-token");
		expect(receivedBody).not.toBeNull();
		const body = receivedBody as Record<string, unknown>;
		expect(body.agentName).toBe("test-agent");
	});

	test("spawn refreshes url and token from ensureDaemonRunning", async () => {
		fakeDaemon = Bun.serve({
			port: 0,
			fetch() {
				return new Response(null, { status: 201 });
			},
		});

		const freshUrl = String(fakeDaemon.url).replace(/\/$/, "");
		const freshPort = fakeDaemon.port;
		const driver = new CodexDaemonDriver({
			daemonUrl: "http://stale-url:9999",
			token: "stale-token",
			ensureDaemonRunning: async () => ({
				pid: process.pid,
				port: freshPort ?? 0,
				startedAt: new Date().toISOString(),
				url: freshUrl,
				token: "fresh-token",
			}),
		});

		// Should not throw — uses the fresh URL returned by ensureDaemonRunning
		await expect(driver.spawn(makeSpawnContext())).resolves.toBeDefined();
	});

	test("spawn throws on non-ok HTTP response", async () => {
		fakeDaemon = Bun.serve({
			port: 0,
			fetch() {
				return new Response("Internal Server Error", { status: 500 });
			},
		});

		const daemonUrl = String(fakeDaemon.url).replace(/\/$/, "");
		const driver = new CodexDaemonDriver({ daemonUrl, token: "t" });

		await expect(driver.spawn(makeSpawnContext())).rejects.toThrow("Daemon spawn failed (500)");
	});

	test("nudge returns NudgeResult from daemon", async () => {
		fakeDaemon = Bun.serve({
			port: 0,
			fetch(req) {
				if (req.method === "POST" && new URL(req.url).pathname.endsWith("/nudge")) {
					return Response.json({ delivered: true });
				}
				return new Response("Not Found", { status: 404 });
			},
		});

		const driver = new CodexDaemonDriver({
			daemonUrl: String(fakeDaemon.url).replace(/\/$/, ""),
			token: "t",
		});
		const result = await driver.nudge("test-agent", "hello", "orch");
		expect(result.delivered).toBe(true);
	});

	test("nudge passes force flag to daemon", async () => {
		let receivedForce: boolean | undefined;

		fakeDaemon = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method === "POST" && new URL(req.url).pathname.endsWith("/nudge")) {
					const body = (await req.json()) as { force?: boolean };
					receivedForce = body.force;
					return Response.json({ delivered: true });
				}
				return new Response("Not Found", { status: 404 });
			},
		});

		const driver = new CodexDaemonDriver({
			daemonUrl: String(fakeDaemon.url).replace(/\/$/, ""),
			token: "t",
		});
		await driver.nudge("test-agent", "escalation", "watchdog", { force: true });
		expect(receivedForce).toBe(true);
	});

	test("nudge passes message to daemon", async () => {
		let receivedMessage: string | undefined;

		fakeDaemon = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method === "POST" && new URL(req.url).pathname.endsWith("/nudge")) {
					const body = (await req.json()) as { message?: string };
					receivedMessage = body.message;
					return Response.json({ delivered: true });
				}
				return new Response("Not Found", { status: 404 });
			},
		});

		const driver = new CodexDaemonDriver({
			daemonUrl: String(fakeDaemon.url).replace(/\/$/, ""),
			token: "t",
		});
		await driver.nudge("test-agent", "check your mail", "orch");
		expect(receivedMessage).toBe("check your mail");
	});

	test("nudge returns delivered:false on HTTP error", async () => {
		fakeDaemon = Bun.serve({
			port: 0,
			fetch() {
				return new Response("Internal Server Error", { status: 500 });
			},
		});

		const driver = new CodexDaemonDriver({
			daemonUrl: String(fakeDaemon.url).replace(/\/$/, ""),
			token: "t",
		});
		const result = await driver.nudge("test-agent", "hello", "orch");
		expect(result.delivered).toBe(false);
		expect(result.reason).toMatch(/HTTP 500/);
	});

	test("nudge sends bearer token in authorization header", async () => {
		let receivedAuth: string | undefined;

		fakeDaemon = Bun.serve({
			port: 0,
			fetch(req) {
				if (req.method === "POST" && new URL(req.url).pathname.endsWith("/nudge")) {
					receivedAuth = req.headers.get("authorization") ?? undefined;
					return Response.json({ delivered: true });
				}
				return new Response("Not Found", { status: 404 });
			},
		});

		const driver = new CodexDaemonDriver({
			daemonUrl: String(fakeDaemon.url).replace(/\/$/, ""),
			token: "secret-nudge-token",
		});
		await driver.nudge("test-agent", "ping", "orch");
		expect(receivedAuth).toBe("Bearer secret-nudge-token");
	});

	test("steer returns true on success", async () => {
		fakeDaemon = Bun.serve({
			port: 0,
			fetch(req) {
				if (req.method === "POST" && new URL(req.url).pathname.endsWith("/steer")) {
					return Response.json({ delivered: true });
				}
				return new Response("Not Found", { status: 404 });
			},
		});

		const driver = new CodexDaemonDriver({
			daemonUrl: String(fakeDaemon.url).replace(/\/$/, ""),
			token: "t",
		});
		const delivered = await driver.steer("test-agent", "stop and summarize");
		expect(delivered).toBe(true);
	});

	test("steer returns false on HTTP error", async () => {
		fakeDaemon = Bun.serve({
			port: 0,
			fetch() {
				return new Response("Not Found", { status: 404 });
			},
		});

		const driver = new CodexDaemonDriver({
			daemonUrl: String(fakeDaemon.url).replace(/\/$/, ""),
			token: "t",
		});
		const delivered = await driver.steer("test-agent", "input");
		expect(delivered).toBe(false);
	});

	test("inspect returns AgentInspection from daemon", async () => {
		const inspection = {
			state: "working",
			lastActivity: "2024-01-01T00:00:00.000Z",
			activeThreadId: "thread-abc",
		};

		fakeDaemon = Bun.serve({
			port: 0,
			fetch(req) {
				const url = new URL(req.url);
				if (req.method === "GET" && url.pathname === "/agents/test-agent") {
					return Response.json(inspection);
				}
				return new Response("Not Found", { status: 404 });
			},
		});

		const driver = new CodexDaemonDriver({
			daemonUrl: String(fakeDaemon.url).replace(/\/$/, ""),
			token: "t",
		});
		const result = await driver.inspect("test-agent");
		expect(result.state).toBe("working");
		expect(result.activeThreadId).toBe("thread-abc");
	});

	test("inspect throws on HTTP error", async () => {
		fakeDaemon = Bun.serve({
			port: 0,
			fetch() {
				return new Response("Not Found", { status: 404 });
			},
		});

		const driver = new CodexDaemonDriver({
			daemonUrl: String(fakeDaemon.url).replace(/\/$/, ""),
			token: "t",
		});
		await expect(driver.inspect("missing-agent")).rejects.toThrow("Inspect failed (404)");
	});

	test("shutdown sends DELETE to /agents/:name", async () => {
		let receivedMethod: string | undefined;
		let receivedPath: string | undefined;

		fakeDaemon = Bun.serve({
			port: 0,
			fetch(req) {
				const url = new URL(req.url);
				receivedMethod = req.method;
				receivedPath = url.pathname;
				return new Response(null, { status: 204 });
			},
		});

		const driver = new CodexDaemonDriver({
			daemonUrl: String(fakeDaemon.url).replace(/\/$/, ""),
			token: "t",
		});
		await driver.shutdown("test-agent");
		expect(receivedMethod).toBe("DELETE");
		expect(receivedPath).toBe("/agents/test-agent");
	});

	test("close is a no-op (does not POST /shutdown)", async () => {
		let shutdownCalled = false;

		fakeDaemon = Bun.serve({
			port: 0,
			fetch(req) {
				if (new URL(req.url).pathname === "/shutdown") {
					shutdownCalled = true;
					return Response.json({ status: "shutting_down" });
				}
				return new Response("Not Found", { status: 404 });
			},
		});

		const driver = new CodexDaemonDriver({
			daemonUrl: String(fakeDaemon.url).replace(/\/$/, ""),
			token: "t",
		});
		await driver.close();
		expect(shutdownCalled).toBe(false);
	});
});
