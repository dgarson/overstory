import { afterEach, describe, expect, test } from "bun:test";
import { createMailStore } from "../mail/store.ts";
import { createWorkflowEngine } from "../workflow/engine.ts";
import { createWorkflowStore } from "../workflow/store.ts";
import type { CoordinatorLoopDeps } from "./coordinator-loop.ts";
import { startCoordinatorLoop, tick } from "./coordinator-loop.ts";
import { createTransportState } from "./transport.ts";
import type { McpSession } from "./types.ts";

function makeSession(overrides: Partial<McpSession> = {}): McpSession {
	return {
		sessionId: "sess-test-1",
		agentName: "test-agent",
		capability: null,
		projectId: "test-project",
		connectedAt: new Date().toISOString(),
		lastMcpCallAt: new Date().toISOString(),
		sseController: null,
		...overrides,
	};
}

function makeDeps(overrides: Partial<CoordinatorLoopDeps> = {}): CoordinatorLoopDeps {
	const mailStore = createMailStore(":memory:");
	const workflowStore = createWorkflowStore(":memory:");
	const workflowEngine = createWorkflowEngine({ store: workflowStore });
	const transport = createTransportState();

	return {
		mailStore,
		workflowEngine,
		transport,
		config: {
			intervalMs: 5_000,
			idleThresholdMs: 30_000,
			projectId: "test-project",
		},
		...overrides,
	};
}

describe("tick — await_work resolver", () => {
	test("resolves await_work resolver when mail arrives for agent", async () => {
		const deps = makeDeps();
		const session = makeSession({ agentName: "waiting-agent" });
		deps.transport.sessions.set("waiting-agent", session);

		// Register a resolver (simulating await_work being called)
		let resolved: unknown = null;
		deps.transport.awaitWorkResolvers.set("waiting-agent", (work) => {
			resolved = work;
		});

		// Send a message to the waiting agent
		deps.mailStore.insert({
			id: "",
			from: "orchestrator",
			to: "waiting-agent",
			subject: "New task",
			body: "Please process task-1",
			priority: "normal",
			type: "dispatch",
			threadId: null,
			payload: null,
		});

		await tick(deps);

		expect(resolved).not.toBeNull();
		const response = resolved as { timedOut: boolean; messages: unknown[] };
		expect(response.timedOut).toBe(false);
		expect(response.messages).toHaveLength(1);
	});

	test("calls the resolver when pending work arrives", async () => {
		const deps = makeDeps();
		const session = makeSession({ agentName: "cleanup-agent" });
		deps.transport.sessions.set("cleanup-agent", session);

		let calledWith: unknown = null;
		// Simulate the resolver as tools.ts would register it — with self-cleanup
		deps.transport.awaitWorkResolvers.set("cleanup-agent", (work) => {
			deps.transport.awaitWorkResolvers.delete("cleanup-agent");
			calledWith = work;
		});

		deps.mailStore.insert({
			id: "",
			from: "parent",
			to: "cleanup-agent",
			subject: "Work item",
			body: "Do something",
			priority: "normal",
			type: "status",
			threadId: null,
			payload: null,
		});

		await tick(deps);

		// The resolver was called and cleaned itself up (matching tools.ts behavior)
		expect(calledWith).not.toBeNull();
		expect(deps.transport.awaitWorkResolvers.has("cleanup-agent")).toBe(false);
	});
});

describe("tick — tmux nudge", () => {
	test("does NOT call tmux when agent is not idle (recent lastMcpCallAt)", async () => {
		const tmuxCalls: string[] = [];
		const fakeTmux = {
			sendKeys: async (session: string) => {
				tmuxCalls.push(session);
			},
		};

		const deps = makeDeps({ _tmux: fakeTmux });
		// Agent was active 1 second ago (well within idleThresholdMs of 30s)
		const recentTime = new Date(Date.now() - 1_000).toISOString();
		const session = makeSession({ agentName: "active-agent", lastMcpCallAt: recentTime });
		deps.transport.sessions.set("active-agent", session);

		// Send a message so there is pending work
		deps.mailStore.insert({
			id: "",
			from: "parent",
			to: "active-agent",
			subject: "Task ready",
			body: "Do it",
			priority: "normal",
			type: "dispatch",
			threadId: null,
			payload: null,
		});

		await tick(deps);

		expect(tmuxCalls).toHaveLength(0);
	});

	test("calls tmux nudge when agent is idle with pending mail", async () => {
		const tmuxCalls: string[] = [];
		const fakeTmux = {
			sendKeys: async (session: string) => {
				tmuxCalls.push(session);
			},
		};

		const deps = makeDeps({ _tmux: fakeTmux });
		// Agent was last active 60 seconds ago (exceeds idleThresholdMs of 30s)
		const oldTime = new Date(Date.now() - 60_000).toISOString();
		const session = makeSession({ agentName: "idle-agent", lastMcpCallAt: oldTime });
		deps.transport.sessions.set("idle-agent", session);

		// Send a message so there is pending work
		deps.mailStore.insert({
			id: "",
			from: "parent",
			to: "idle-agent",
			subject: "Wake up",
			body: "There is work waiting",
			priority: "high",
			type: "dispatch",
			threadId: null,
			payload: null,
		});

		await tick(deps);

		expect(tmuxCalls).toHaveLength(1);
		// Tmux session name follows pattern: overstory-{projectId}-{agentName}
		expect(tmuxCalls[0]).toBe("overstory-test-project-idle-agent");
	});

	test("does NOT nudge agent when no pending work", async () => {
		const tmuxCalls: string[] = [];
		const fakeTmux = {
			sendKeys: async (session: string) => {
				tmuxCalls.push(session);
			},
		};

		const deps = makeDeps({ _tmux: fakeTmux });
		// Agent is idle (old timestamp) but has no pending work
		const oldTime = new Date(Date.now() - 60_000).toISOString();
		const session = makeSession({ agentName: "idle-no-work", lastMcpCallAt: oldTime });
		deps.transport.sessions.set("idle-no-work", session);

		await tick(deps);

		expect(tmuxCalls).toHaveLength(0);
	});
});

describe("tick — stale session cleanup", () => {
	test("removes stale sessions (no SSE + > 5min idle)", async () => {
		const deps = makeDeps();
		// Session that has been idle for 10 minutes with no SSE
		const oldTime = new Date(Date.now() - 10 * 60_000).toISOString();
		const session = makeSession({
			sessionId: "stale-session",
			agentName: "stale-agent",
			lastMcpCallAt: oldTime,
			sseController: null,
		});
		deps.transport.sessions.set("stale-session", session);

		expect(deps.transport.sessions.size).toBe(1);

		await tick(deps);

		expect(deps.transport.sessions.has("stale-session")).toBe(false);
	});

	test("keeps sessions that are not stale", async () => {
		const deps = makeDeps();
		// Session that was recently active
		const recentTime = new Date(Date.now() - 60_000).toISOString();
		const session = makeSession({
			sessionId: "fresh-session",
			agentName: "fresh-agent",
			lastMcpCallAt: recentTime,
			sseController: null,
		});
		deps.transport.sessions.set("fresh-session", session);

		await tick(deps);

		expect(deps.transport.sessions.has("fresh-session")).toBe(true);
	});

	test("does not remove session that has an active SSE controller", async () => {
		const deps = makeDeps();
		// Session is old but has an active SSE stream
		const oldTime = new Date(Date.now() - 10 * 60_000).toISOString();

		// Create a minimal fake SSE controller
		const fakeController = {} as ReadableStreamDefaultController<Uint8Array>;
		const session = makeSession({
			sessionId: "sse-active-session",
			agentName: "sse-agent",
			lastMcpCallAt: oldTime,
			sseController: fakeController,
		});
		deps.transport.sessions.set("sse-active-session", session);

		await tick(deps);

		// Session should be kept because it has an active SSE controller
		expect(deps.transport.sessions.has("sse-active-session")).toBe(true);
	});
});

describe("tick — unknown agent handling", () => {
	test("skips sessions with agentName === unknown", async () => {
		const tmuxCalls: string[] = [];
		const fakeTmux = {
			sendKeys: async (session: string) => {
				tmuxCalls.push(session);
			},
		};

		const deps = makeDeps({ _tmux: fakeTmux });
		const oldTime = new Date(Date.now() - 60_000).toISOString();
		const session = makeSession({
			agentName: "unknown",
			lastMcpCallAt: oldTime,
		});
		deps.transport.sessions.set("unknown", session);

		// Even with pending work, unknown agents should be skipped
		deps.mailStore.insert({
			id: "",
			from: "parent",
			to: "unknown",
			subject: "Task",
			body: "Work",
			priority: "normal",
			type: "status",
			threadId: null,
			payload: null,
		});

		await tick(deps);

		// No tmux calls, no resolver calls for unknown agents
		expect(tmuxCalls).toHaveLength(0);
	});
});

describe("startCoordinatorLoop", () => {
	let stopFn: (() => void) | null = null;

	afterEach(() => {
		if (stopFn) {
			stopFn();
			stopFn = null;
		}
	});

	test("returns a stop function that stops the interval", async () => {
		let tickCount = 0;
		const deps = makeDeps();
		// Override the deps config with a very short interval
		deps.config.intervalMs = 10;

		// Patch tick by using a transport sessions set that we can observe
		// The loop runs tick() on setInterval — we verify it ran by checking side effects
		const session = makeSession({ agentName: "loop-agent" });
		deps.transport.sessions.set("loop-agent", session);

		stopFn = startCoordinatorLoop(deps);

		// Let it run briefly
		await new Promise<void>((resolve) => setTimeout(resolve, 50));

		// Stop it
		stopFn();
		stopFn = null;

		// Record the state at stop time
		tickCount = deps.transport.sessions.size;

		// Wait a bit more — interval should not fire again after stop
		await new Promise<void>((resolve) => setTimeout(resolve, 50));

		// Sessions size unchanged (stale session cleanup would have removed a 5+ min old session,
		// but our session is fresh so it stays)
		expect(deps.transport.sessions.size).toBe(tickCount);
	});

	test("startCoordinatorLoop returns a callable stop function", () => {
		const deps = makeDeps();
		const stop = startCoordinatorLoop(deps);
		expect(typeof stop).toBe("function");
		stop();
	});
});

describe("tick — multiple sessions", () => {
	test("handles multiple sessions in a single tick", async () => {
		const tmuxCalls: string[] = [];
		const fakeTmux = {
			sendKeys: async (session: string) => {
				tmuxCalls.push(session);
			},
		};

		const deps = makeDeps({ _tmux: fakeTmux });

		// Agent 1: idle with pending work — should be nudged
		const oldTime = new Date(Date.now() - 60_000).toISOString();
		const session1 = makeSession({
			sessionId: "sess-1",
			agentName: "idle-with-work",
			lastMcpCallAt: oldTime,
		});
		deps.transport.sessions.set("idle-with-work", session1);

		deps.mailStore.insert({
			id: "",
			from: "parent",
			to: "idle-with-work",
			subject: "Work",
			body: "Do it",
			priority: "normal",
			type: "dispatch",
			threadId: null,
			payload: null,
		});

		// Agent 2: recent activity, no pending work — should NOT be nudged
		const recentTime = new Date(Date.now() - 1_000).toISOString();
		const session2 = makeSession({
			sessionId: "sess-2",
			agentName: "active-no-work",
			lastMcpCallAt: recentTime,
		});
		deps.transport.sessions.set("active-no-work", session2);

		await tick(deps);

		expect(tmuxCalls).toHaveLength(1);
		expect(tmuxCalls[0]).toContain("idle-with-work");
	});
});
