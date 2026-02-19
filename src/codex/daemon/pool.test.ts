// src/codex/daemon/pool.test.ts
// Tests for AgentPool. Uses mock RpcClient because real connections require
// a running Codex App Server (external service with real costs and latency).
import { describe, expect, test } from "bun:test";
import type { RequestHandler, RpcClient } from "../rpc-client";
import type { BridgeConfig } from "../types";
import { createAgentPool } from "./pool";

function mockRpcClient(): RpcClient {
	return {
		request(_method: string, _params?: Record<string, unknown>): Promise<unknown> {
			return Promise.resolve(null);
		},
		onNotification(_handler: (method: string, params: unknown) => void): void {
			// no-op
		},
		onRequest(_handler: RequestHandler): void {
			// no-op
		},
		get closed(): boolean {
			return false;
		},
		close(): void {
			// no-op
		},
	};
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

describe("AgentPool", () => {
	test("add registers an agent by name", async () => {
		const pool = createAgentPool({ createRpcClient: async () => mockRpcClient() });
		await pool.add(makeBridgeConfig({ agentName: "test-agent" }));
		expect(pool.names()).toContain("test-agent");
	});

	test("get returns undefined for unknown agent", () => {
		const pool = createAgentPool({ createRpcClient: async () => mockRpcClient() });
		expect(pool.get("nonexistent")).toBeUndefined();
	});

	test("remove deletes agent from pool", async () => {
		const pool = createAgentPool({ createRpcClient: async () => mockRpcClient() });
		await pool.add(makeBridgeConfig({ agentName: "test-agent" }));
		await pool.remove("test-agent");
		expect(pool.get("test-agent")).toBeUndefined();
	});

	test("steer returns false when no active turn", async () => {
		const pool = createAgentPool({ createRpcClient: async () => mockRpcClient() });
		await pool.add(makeBridgeConfig({ agentName: "test-agent" }));
		const result = await pool.steer("test-agent", "hello");
		expect(result).toBe(false);
	});

	test("add rejects duplicate agent name", async () => {
		const pool = createAgentPool({ createRpcClient: async () => mockRpcClient() });
		await pool.add(makeBridgeConfig({ agentName: "dup" }));
		await expect(pool.add(makeBridgeConfig({ agentName: "dup" }))).rejects.toThrow();
	});

	test("drain removes all agents", async () => {
		const pool = createAgentPool({ createRpcClient: async () => mockRpcClient() });
		await pool.add(makeBridgeConfig({ agentName: "a1" }));
		await pool.add(makeBridgeConfig({ agentName: "a2" }));
		await pool.drain();
		expect(pool.names()).toEqual([]);
	});

	test("get returns the managed agent after add", async () => {
		const pool = createAgentPool({ createRpcClient: async () => mockRpcClient() });
		await pool.add(makeBridgeConfig({ agentName: "my-agent" }));
		const agent = pool.get("my-agent");
		expect(agent).toBeDefined();
		expect(agent?.config.agentName).toBe("my-agent");
		expect(agent?.state).toBe("booting");
		expect(agent?.activeTurnId).toBeNull();
	});

	test("steer returns false when agent not in pool", async () => {
		const pool = createAgentPool({ createRpcClient: async () => mockRpcClient() });
		const result = await pool.steer("nobody", "hello");
		expect(result).toBe(false);
	});

	test("steer dispatches agent/steer RPC when turn is active", async () => {
		const rpcRequests: Array<{ method: string; params: unknown }> = [];
		const pool = createAgentPool({
			createRpcClient: async () => ({
				request: async (method: string, params?: Record<string, unknown>) => {
					rpcRequests.push({ method, params });
					return {};
				},
				onNotification: () => {},
				onRequest: () => {},
				closed: false,
				close: () => {},
			}),
		});
		await pool.add(makeBridgeConfig({ agentName: "alpha" }));
		const agent = pool.get("alpha");
		if (agent !== undefined) {
			agent.activeTurnId = "t1";
		}
		const delivered = await pool.steer("alpha", "hello");
		expect(delivered).toBe(true);
		const calls = rpcRequests.filter((r) => r.method === "agent/steer");
		expect(calls.length).toBe(1);
		expect(calls[0]?.params).toMatchObject({ input: "hello", turnId: "t1" });
	});

	test("nudge returns delivered false when no active turn", async () => {
		const pool = createAgentPool({ createRpcClient: async () => mockRpcClient() });
		await pool.add(makeBridgeConfig({ agentName: "agent-x" }));
		const result = await pool.nudge("agent-x", "wake up");
		expect(result.delivered).toBe(false);
		expect(result.reason).toBeDefined();
	});

	test("nudge returns delivered false when agent not found", async () => {
		const pool = createAgentPool({ createRpcClient: async () => mockRpcClient() });
		const result = await pool.nudge("ghost", "hello");
		expect(result.delivered).toBe(false);
		expect(result.reason).toBeDefined();
	});

	test("names returns all registered agent names", async () => {
		const pool = createAgentPool({ createRpcClient: async () => mockRpcClient() });
		await pool.add(makeBridgeConfig({ agentName: "alpha" }));
		await pool.add(makeBridgeConfig({ agentName: "beta" }));
		await pool.add(makeBridgeConfig({ agentName: "gamma" }));
		const names = pool.names();
		expect(names).toContain("alpha");
		expect(names).toContain("beta");
		expect(names).toContain("gamma");
		expect(names).toHaveLength(3);
	});

	test("remove is idempotent for unknown names", async () => {
		const pool = createAgentPool({ createRpcClient: async () => mockRpcClient() });
		// Removing a non-existent agent should not throw
		await expect(pool.remove("nobody")).resolves.toBeUndefined();
	});

	test("nudge calls rpc.request with message", async () => {
		const requests: Array<{ method: string; params: unknown }> = [];
		const pool = createAgentPool({
			createRpcClient: async () => ({
				request: async (method: string, params?: Record<string, unknown>) => {
					requests.push({ method, params });
					return {};
				},
				onNotification: () => {},
				onRequest: () => {},
				closed: false,
				close: () => {},
			}),
		});
		// Set activeTurnId so nudge proceeds to the rpc call
		await pool.add(makeBridgeConfig({ agentName: "test-agent" }));
		const agent = pool.get("test-agent");
		if (agent !== undefined) {
			agent.activeTurnId = "turn-1";
		}
		await pool.nudge("test-agent", "check your mail");
		expect(requests.length).toBe(1);
		expect(requests[0]?.method).toBe("agent/nudge");
		expect(requests[0]?.params).toMatchObject({ message: "check your mail" });
	});

	test("remove calls rpc.close()", async () => {
		let closeCalled = false;
		const pool = createAgentPool({
			createRpcClient: async () => ({
				request: async () => ({}),
				onNotification: () => {},
				onRequest: () => {},
				closed: false,
				close: () => {
					closeCalled = true;
				},
			}),
		});
		await pool.add(makeBridgeConfig({ agentName: "test-agent" }));
		await pool.remove("test-agent");
		expect(closeCalled).toBe(true);
	});

	test("threadId is a UUID-shaped string", async () => {
		const pool = createAgentPool({ createRpcClient: async () => mockRpcClient() });
		await pool.add(makeBridgeConfig({ agentName: "uuid-check" }));
		const agent = pool.get("uuid-check");
		expect(agent?.threadId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
	});
});
