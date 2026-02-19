// src/codex/daemon/server.test.ts
// Tests for DaemonServer. Uses Bun.serve() on a random port (port: 0) for
// real HTTP testing, and a mock AgentPool to avoid real RPC connections.
import { afterEach, describe, expect, test } from "bun:test";
import type { BridgeConfig } from "../types.ts";
import type { AgentPool, ManagedAgent } from "./pool.ts";
import { createDaemonServer } from "./server.ts";

const TOKEN = "test-token-abc123";

function mockPool(): AgentPool & { addCalls: number; drainCalled: boolean } {
	const agents = new Map<string, ManagedAgent>();
	const mock = {
		addCalls: 0,
		drainCalled: false,

		async add(_config: BridgeConfig): Promise<void> {
			mock.addCalls++;
			// Store minimal ManagedAgent for read-only tests
		},
		get(name: string): ManagedAgent | undefined {
			return agents.get(name);
		},
		async steer(_name: string, _input: string): Promise<boolean> {
			return true;
		},
		async nudge(
			_name: string,
			_message: string,
			_force?: boolean,
		): Promise<{ delivered: boolean; reason?: string }> {
			return { delivered: true };
		},
		async remove(_name: string): Promise<void> {},
		names(): string[] {
			return Array.from(agents.keys());
		},
		async drain(): Promise<void> {
			mock.drainCalled = true;
		},
	};
	return mock;
}

function makeBridgeConfig(overrides: Partial<BridgeConfig> & { agentName: string }): BridgeConfig {
	return {
		agentName: overrides.agentName,
		worktreePath: overrides.worktreePath ?? "/tmp/test-worktree",
		branchName: overrides.branchName ?? "feat/test",
		beadId: overrides.beadId ?? "test-bead-001",
		capability: overrides.capability ?? "builder",
		parentAgent: overrides.parentAgent ?? null,
		depth: overrides.depth ?? 1,
		runId: overrides.runId ?? null,
		sessionId: overrides.sessionId ?? "test-session-id",
		serverUrl: overrides.serverUrl ?? "ws://127.0.0.1:21816",
		model: overrides.model ?? "o3",
		compactionThreshold: overrides.compactionThreshold ?? 0.8,
		maxDeltaBufferBytes: overrides.maxDeltaBufferBytes ?? 1048576,
		approvalTimeoutMs: overrides.approvalTimeoutMs ?? 60000,
		fileScope: overrides.fileScope ?? [],
		projectRoot: overrides.projectRoot ?? "/tmp/test-project",
		maxReconnectAttempts: overrides.maxReconnectAttempts ?? 3,
		reconnectBaseDelayMs: overrides.reconnectBaseDelayMs ?? 2000,
	};
}

describe("DaemonServer", () => {
	let server: ReturnType<typeof Bun.serve> | undefined;

	afterEach(() => {
		server?.stop();
	});

	test("GET /health returns 200 without auth", async () => {
		const pool = mockPool();
		server = createDaemonServer({ port: 0, pool, token: TOKEN });
		const res = await fetch(`${server.url}health`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { status: string; agents: number };
		expect(body.status).toBe("ok");
		expect(body.agents).toBe(0);
	});

	test("POST /agents returns 401 without bearer token", async () => {
		const pool = mockPool();
		server = createDaemonServer({ port: 0, pool, token: TOKEN });
		const res = await fetch(`${server.url}agents`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(makeBridgeConfig({ agentName: "test-agent" })),
		});
		expect(res.status).toBe(401);
	});

	test("POST /agents returns 201 with valid bearer token", async () => {
		const pool = mockPool();
		server = createDaemonServer({ port: 0, pool, token: TOKEN });
		const res = await fetch(`${server.url}agents`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${TOKEN}`,
			},
			body: JSON.stringify(makeBridgeConfig({ agentName: "test-agent" })),
		});
		expect(res.status).toBe(201);
		expect(pool.addCalls).toBe(1);
	});

	test("GET /agents returns list without auth (read-only)", async () => {
		const pool = mockPool();
		server = createDaemonServer({ port: 0, pool, token: TOKEN });
		const res = await fetch(`${server.url}agents`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as unknown[];
		expect(Array.isArray(body)).toBe(true);
		expect(body).toEqual([]);
	});

	test("POST /agents/:name/nudge with force flag", async () => {
		const pool = mockPool();
		server = createDaemonServer({ port: 0, pool, token: TOKEN });
		const res = await fetch(`${server.url}agents/test-agent/nudge`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${TOKEN}`,
			},
			body: JSON.stringify({ message: "check mail", force: true }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { delivered: boolean };
		expect(body.delivered).toBe(true);
	});

	test("POST /shutdown drains pool and stops", async () => {
		const pool = mockPool();
		server = createDaemonServer({ port: 0, pool, token: TOKEN });
		// Note: The setTimeout(..., 100) delay in the shutdown handler means
		// process.exit(0) will not fire before this test assertion completes.
		const res = await fetch(`${server.url}shutdown`, {
			method: "POST",
			headers: { Authorization: `Bearer ${TOKEN}` },
		});
		expect(res.status).toBe(200);
		expect(pool.drainCalled).toBe(true);
	});
});
