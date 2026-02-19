import { describe, expect, test } from "bun:test";
import { createMailStore } from "../mail/store.ts";
import { createWorkflowEngine } from "../workflow/engine.ts";
import { createWorkflowStore } from "../workflow/store.ts";
import type { ToolDependencies } from "./tools.ts";
import { buildToolHandlers } from "./tools.ts";
import { createTransportState } from "./transport.ts";
import type { McpSession } from "./types.ts";

function makeSession(overrides: Partial<McpSession> = {}): McpSession {
	return {
		sessionId: "sess-test",
		agentName: "test-agent",
		capability: null,
		projectId: "test-project",
		connectedAt: new Date().toISOString(),
		lastMcpCallAt: new Date().toISOString(),
		sseController: null,
		...overrides,
	};
}

function makeDeps(overrides: Partial<ToolDependencies> = {}): ToolDependencies {
	const mailStore = createMailStore(":memory:");
	const workflowStore = createWorkflowStore(":memory:");
	const workflowEngine = createWorkflowEngine({ store: workflowStore });
	const transport = createTransportState();

	return {
		mailStore,
		workflowEngine,
		transport,
		config: {
			awaitWorkMaxMs: 30_000,
		},
		...overrides,
	};
}

/** Invoke tools/call with a given tool name and arguments. */
async function callTool(
	handlers: ReturnType<typeof buildToolHandlers>,
	session: McpSession,
	toolName: string,
	args: Record<string, unknown> = {},
): Promise<unknown> {
	const handler = handlers.get("tools/call");
	if (!handler) throw new Error("tools/call handler not found");
	return handler({ name: toolName, arguments: args }, session);
}

describe("tools/list", () => {
	test("returns an array of tool definitions", async () => {
		const deps = makeDeps();
		const handlers = buildToolHandlers(deps);
		const listHandler = handlers.get("tools/list");
		expect(listHandler).toBeDefined();

		if (!listHandler) throw new Error("tools/list handler missing");
		const result = (await listHandler({}, makeSession())) as { tools: unknown[] };
		expect(Array.isArray(result.tools)).toBe(true);
		expect(result.tools.length).toBeGreaterThan(0);
	});

	test("includes expected tool names", async () => {
		const deps = makeDeps();
		const handlers = buildToolHandlers(deps);
		const listHandler = handlers.get("tools/list");
		if (!listHandler) throw new Error("tools/list handler missing");
		const result = (await listHandler({}, makeSession())) as { tools: Array<{ name: string }> };
		const names = result.tools.map((t) => t.name);
		expect(names).toContain("await_work");
		expect(names).toContain("check_messages");
		expect(names).toContain("send_message");
		expect(names).toContain("get_pending_work");
		expect(names).toContain("report_activity");
	});
});

describe("initialize", () => {
	test("returns protocol version and server info", async () => {
		const deps = makeDeps();
		const handlers = buildToolHandlers(deps);
		const initHandler = handlers.get("initialize");
		expect(initHandler).toBeDefined();

		if (!initHandler) throw new Error("initialize handler missing");
		const result = (await initHandler({}, makeSession())) as Record<string, unknown>;
		expect(result.protocolVersion).toBe("2024-11-05");
		expect(result.capabilities).toBeDefined();
		const serverInfo = result.serverInfo as Record<string, unknown>;
		expect(serverInfo.name).toBe("overstory");
	});

	test("includes clientName from params", async () => {
		const deps = makeDeps();
		const handlers = buildToolHandlers(deps);
		const initHandler = handlers.get("initialize");

		if (!initHandler) throw new Error("initialize handler missing");
		const result = (await initHandler(
			{ clientInfo: { name: "my-client" } },
			makeSession(),
		)) as Record<string, unknown>;

		const serverInfo = result.serverInfo as Record<string, unknown>;
		expect(serverInfo.clientName).toBe("my-client");
	});
});

describe("check_messages", () => {
	test("returns empty messages when no mail", async () => {
		const deps = makeDeps();
		const handlers = buildToolHandlers(deps);
		const session = makeSession({ agentName: "no-mail-agent" });

		const result = (await callTool(handlers, session, "check_messages")) as {
			messages: unknown[];
			count: number;
		};
		expect(result.messages).toHaveLength(0);
		expect(result.count).toBe(0);
	});

	test("returns messages when mail exists for the agent", async () => {
		const deps = makeDeps();
		const handlers = buildToolHandlers(deps);
		const session = makeSession({ agentName: "mail-recipient" });

		// Insert a message for this agent
		deps.mailStore.insert({
			id: "",
			from: "sender",
			to: "mail-recipient",
			subject: "Hello",
			body: "World",
			priority: "normal",
			type: "status",
			threadId: null,
			payload: null,
		});

		const result = (await callTool(handlers, session, "check_messages")) as {
			messages: Array<{ subject: string }>;
			count: number;
		};
		expect(result.messages).toHaveLength(1);
		expect(result.count).toBe(1);
		expect(result.messages[0]?.subject).toBe("Hello");
	});

	test("marks messages as read after check", async () => {
		const deps = makeDeps();
		const handlers = buildToolHandlers(deps);
		const session = makeSession({ agentName: "read-check-agent" });

		deps.mailStore.insert({
			id: "",
			from: "sender",
			to: "read-check-agent",
			subject: "Once",
			body: "Read me",
			priority: "normal",
			type: "status",
			threadId: null,
			payload: null,
		});

		// First check: should see the message
		const first = (await callTool(handlers, session, "check_messages")) as { count: number };
		expect(first.count).toBe(1);

		// Second check: message is now read, should return empty
		const second = (await callTool(handlers, session, "check_messages")) as { count: number };
		expect(second.count).toBe(0);
	});

	test("uses agentName from params when provided", async () => {
		const deps = makeDeps();
		const handlers = buildToolHandlers(deps);
		const session = makeSession({ agentName: "session-agent" });

		deps.mailStore.insert({
			id: "",
			from: "sender",
			to: "param-agent",
			subject: "For param-agent",
			body: "Hi",
			priority: "normal",
			type: "status",
			threadId: null,
			payload: null,
		});

		// Ask for a different agent's messages
		const result = (await callTool(handlers, session, "check_messages", {
			agentName: "param-agent",
		})) as { count: number };
		expect(result.count).toBe(1);
	});
});

describe("send_message", () => {
	test("inserts a message and returns messageId", async () => {
		const deps = makeDeps();
		const handlers = buildToolHandlers(deps);
		const session = makeSession({ agentName: "sender-agent" });

		const result = (await callTool(handlers, session, "send_message", {
			to: "recipient-agent",
			subject: "Test message",
			body: "Hello from test",
		})) as { messageId: string; delivered: boolean };

		expect(result.messageId).toBeDefined();
		expect(typeof result.messageId).toBe("string");
		expect(result.delivered).toBe(true);
	});

	test("message is retrievable via check_messages", async () => {
		const deps = makeDeps();
		const handlers = buildToolHandlers(deps);
		const senderSession = makeSession({ agentName: "the-sender" });
		const recipientSession = makeSession({ agentName: "the-recipient" });

		await callTool(handlers, senderSession, "send_message", {
			to: "the-recipient",
			subject: "Sent via MCP",
			body: "Content here",
		});

		const checkResult = (await callTool(handlers, recipientSession, "check_messages", {
			agentName: "the-recipient",
		})) as { messages: Array<{ from: string; subject: string }>; count: number };

		expect(checkResult.count).toBe(1);
		expect(checkResult.messages[0]?.from).toBe("the-sender");
		expect(checkResult.messages[0]?.subject).toBe("Sent via MCP");
	});

	test("throws when 'to' is missing", async () => {
		const deps = makeDeps();
		const handlers = buildToolHandlers(deps);
		const session = makeSession();

		await expect(
			callTool(handlers, session, "send_message", { subject: "No to", body: "oops" }),
		).rejects.toThrow("send_message requires 'to'");
	});
});

describe("report_activity", () => {
	test("updates session.lastMcpCallAt and returns acknowledged", async () => {
		const deps = makeDeps();
		const handlers = buildToolHandlers(deps);
		const session = makeSession({
			lastMcpCallAt: new Date(Date.now() - 60_000).toISOString(),
		});
		const before = session.lastMcpCallAt;

		const result = (await callTool(handlers, session, "report_activity")) as {
			acknowledged: boolean;
			timestamp: string;
		};

		expect(result.acknowledged).toBe(true);
		expect(result.timestamp).toBeDefined();
		expect(result.timestamp).not.toBe(before);
		// session.lastMcpCallAt should be updated
		expect(session.lastMcpCallAt).toBe(result.timestamp);
	});
});

describe("get_pending_work", () => {
	test("throws when role is missing", async () => {
		const deps = makeDeps();
		const handlers = buildToolHandlers(deps);
		const session = makeSession();

		await expect(callTool(handlers, session, "get_pending_work", {})).rejects.toThrow(
			"get_pending_work requires role",
		);
	});

	test("returns empty tasks array when no pending work", async () => {
		const deps = makeDeps();
		const handlers = buildToolHandlers(deps);
		const session = makeSession();

		const result = (await callTool(handlers, session, "get_pending_work", { role: "builder" })) as {
			tasks: unknown[];
		};
		expect(Array.isArray(result.tasks)).toBe(true);
		expect(result.tasks).toHaveLength(0);
	});
});

describe("await_work", () => {
	test("times out when no work arrives", async () => {
		const deps = makeDeps({ config: { awaitWorkMaxMs: 200 } });
		const handlers = buildToolHandlers(deps);
		const session = makeSession({ agentName: "waiting-agent" });

		// Use a small timeoutMs so the test does not hang
		const result = (await callTool(handlers, session, "await_work", {
			agentName: "waiting-agent",
			timeoutMs: 50,
		})) as { timedOut: boolean; messages: unknown[]; transitions: unknown[] };

		expect(result.timedOut).toBe(true);
		expect(result.messages).toHaveLength(0);
		expect(result.transitions).toHaveLength(0);
	});

	test("clamps timeoutMs to awaitWorkMaxMs", async () => {
		const deps = makeDeps({ config: { awaitWorkMaxMs: 100 } });
		const handlers = buildToolHandlers(deps);
		const session = makeSession({ agentName: "clamped-agent" });

		// Request a timeout larger than awaitWorkMaxMs
		const start = Date.now();
		const result = (await callTool(handlers, session, "await_work", {
			agentName: "clamped-agent",
			timeoutMs: 999_999,
		})) as { timedOut: boolean };

		const elapsed = Date.now() - start;
		expect(result.timedOut).toBe(true);
		// Should have timed out in roughly awaitWorkMaxMs (100ms), not the requested 999999ms
		expect(elapsed).toBeLessThan(500);
	});

	test("resolves immediately when resolver is called", async () => {
		const deps = makeDeps({ config: { awaitWorkMaxMs: 5_000 } });
		const handlers = buildToolHandlers(deps);
		const session = makeSession({ agentName: "resolver-agent" });

		// Start await_work — it will block
		const awaitPromise = callTool(handlers, session, "await_work", {
			agentName: "resolver-agent",
			timeoutMs: 4_000,
		}) as Promise<{ timedOut: boolean; messages: Array<{ subject: string }> }>;

		// Resolve it externally (simulating coordinator loop behavior)
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
		const resolver = deps.transport.awaitWorkResolvers.get("resolver-agent");
		expect(resolver).toBeDefined();

		const fakeWork = {
			timedOut: false,
			messages: [
				{
					id: "m1",
					from: "sender",
					subject: "Go!",
					body: "",
					type: "dispatch",
					priority: "normal",
					createdAt: new Date().toISOString(),
				},
			],
			transitions: [],
			instruction: "Process now",
		};
		resolver?.(fakeWork);

		const result = await awaitPromise;
		expect(result.timedOut).toBe(false);
		expect(result.messages).toHaveLength(1);
		expect(result.messages[0]?.subject).toBe("Go!");
	});
});

describe("tools/call dispatch — unknown tool", () => {
	test("throws for unknown tool name", async () => {
		const deps = makeDeps();
		const handlers = buildToolHandlers(deps);
		const session = makeSession();

		await expect(callTool(handlers, session, "nonexistent_tool")).rejects.toThrow(
			"Unknown tool: nonexistent_tool",
		);
	});

	test("throws when name param is missing from tools/call", async () => {
		const deps = makeDeps();
		const handlers = buildToolHandlers(deps);
		const session = makeSession();
		const handler = handlers.get("tools/call");
		expect(handler).toBeDefined();

		if (!handler) throw new Error("tools/call handler missing");
		await expect(handler({ arguments: {} }, session)).rejects.toThrow("tools/call requires 'name'");
	});
});
