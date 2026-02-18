// src/codex/bridge-integration.test.ts
// Integration tests for runBridge() using a real mock WebSocket server.
// These tests validate the full lifecycle: connect → turn → events → shutdown.
//
// WHY a real WebSocket server (not mocked):
// The bridge's core value proposition is its JSON-RPC 2.0 protocol handling
// over WebSocket. Mocking the transport would skip the very thing we need to test.
//
// The notification handler in bridge.ts routes turn-level events (turn/completed,
// turn/started) before item-level wildcard patterns (endsWith("/completed"),
// endsWith("/started")) to prevent shadowing. Test M verifies this ordering.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventStore } from "../events/store";
import { createMailStore } from "../mail/store";
import { runBridge } from "./bridge";
import { createMockCodexServer, type MockCodexServer } from "./test-server";
import type { BridgeConfig } from "./types";

describe("runBridge integration", () => {
	let server: MockCodexServer;
	let tempDir: string;
	let overstoryDir: string;

	beforeEach(async () => {
		server = await createMockCodexServer();
		tempDir = join(tmpdir(), `bridge-integ-${Math.random().toString(36).slice(2, 10)}`);
		await mkdir(tempDir, { recursive: true });
		overstoryDir = join(tempDir, ".overstory");
		await mkdir(join(overstoryDir, "agents", "test-builder"), { recursive: true });
	});

	afterEach(async () => {
		// Close server (may already be closed by the test)
		try {
			await server.close();
		} catch {
			// Already closed
		}
		await rm(tempDir, { recursive: true, force: true });
	});

	/** Build a valid BridgeConfig pointing at the mock server */
	function makeConfig(overrides?: Partial<BridgeConfig>): BridgeConfig {
		return {
			agentName: "test-builder",
			worktreePath: join(tempDir, "worktree"),
			branchName: "test-branch",
			beadId: "test-task-1",
			capability: "builder",
			parentAgent: "test-lead",
			depth: 2,
			runId: "run-1",
			sessionId: "sess-1",
			serverUrl: server.url,
			model: "o3",
			compactionThreshold: 0.8,
			maxDeltaBufferBytes: 1048576,
			approvalTimeoutMs: 5000,
			fileScope: ["src/foo.ts"],
			projectRoot: tempDir,
			...overrides,
		};
	}

	/**
	 * Helper: shut down the bridge by closing the mock server.
	 * The bridge detects WebSocket disconnection via its polling interval
	 * and exits gracefully. A short sleep before close lets any in-flight
	 * async operations (e.g. the test server's auto turn/started notification)
	 * settle before we tear down the connection.
	 */
	async function shutdownBridge(bridgePromise: Promise<void>): Promise<void> {
		await Bun.sleep(100);
		await server.close();
		await bridgePromise;
	}

	// ========================================
	// A. Basic lifecycle: connect → turn → shutdown
	// ========================================
	test(
		"basic lifecycle: connect, thread/start, turn/start, shutdown via disconnect",
		async () => {
			const config = makeConfig();
			const bridgePromise = runBridge(config);

			// Wait for thread/start and turn/start to be received
			await server.waitForRequest("thread/start", 5000);
			const turnReq = await server.waitForRequest("turn/start", 5000);

			// Verify thread/start included the model
			const threadReq = server.getReceivedRequests().find((r) => r.method === "thread/start");
			expect(threadReq).toBeDefined();
			expect(threadReq?.params?.model).toBe("o3");

			// Verify turn/start included an input prompt (v2 UserInput array format)
			expect(turnReq.params?.input).toBeDefined();
			expect(Array.isArray(turnReq.params?.input)).toBe(true);

			// Shut down via WebSocket disconnection
			await shutdownBridge(bridgePromise);

			// Verify session_end event was recorded
			const eventStore = createEventStore(join(overstoryDir, "events.db"));
			const events = eventStore.getByAgent("test-builder");
			const sessionEnd = events.find((e) => e.eventType === "session_end");
			expect(sessionEnd).toBeDefined();
			expect(sessionEnd?.agentName).toBe("test-builder");
			eventStore.close();
		},
		{ timeout: 15000 },
	);

	// ========================================
	// B. Event recording: item/started + item/completed
	// ========================================
	test(
		"records tool_start and tool_end events for item lifecycle",
		async () => {
			const config = makeConfig();
			const bridgePromise = runBridge(config);

			await server.waitForRequest("turn/start", 5000);

			// Emit item/started via setTimeout to ensure delivery
			await server.notifyLater("item/started", {
				threadId: "t1",
				turnId: "turn-1",
				itemId: "item-1",
				itemType: "commandExecution",
				data: { command: "bun test" },
			});
			await Bun.sleep(100);

			// Emit item/completed
			await server.notifyLater("item/completed", {
				threadId: "t1",
				turnId: "turn-1",
				itemId: "item-1",
				itemType: "commandExecution",
				status: "completed",
				data: { command: "bun test" },
			});
			await Bun.sleep(200);

			// Shut down
			await shutdownBridge(bridgePromise);

			// Verify events were recorded
			const eventStore = createEventStore(join(overstoryDir, "events.db"));
			const events = eventStore.getByAgent("test-builder");

			const toolStart = events.find((e) => e.eventType === "tool_start");
			expect(toolStart).toBeDefined();
			expect(toolStart?.toolName).toBe("Bash");

			const toolEnd = events.find((e) => e.eventType === "tool_end");
			expect(toolEnd).toBeDefined();
			expect(toolEnd?.toolName).toBe("Bash");

			eventStore.close();
		},
		{ timeout: 15000 },
	);

	// ========================================
	// C. Delta buffer accumulation
	// ========================================
	test(
		"accumulates outputDelta chunks into tool_end event data",
		async () => {
			const config = makeConfig();
			const bridgePromise = runBridge(config);

			await server.waitForRequest("turn/start", 5000);

			// Emit item/started
			await server.notifyLater("item/started", {
				threadId: "t1",
				turnId: "turn-1",
				itemId: "item-1",
				itemType: "commandExecution",
				data: { command: "echo hello" },
			});
			await Bun.sleep(50);

			// Emit several delta chunks
			await server.notifyLater("outputDelta", {
				threadId: "t1",
				turnId: "turn-1",
				itemId: "item-1",
				delta: "hello ",
			});
			await server.notifyLater("outputDelta", {
				threadId: "t1",
				turnId: "turn-1",
				itemId: "item-1",
				delta: "world",
			});
			await server.notifyLater("outputDelta", {
				threadId: "t1",
				turnId: "turn-1",
				itemId: "item-1",
				delta: "!",
			});
			await Bun.sleep(50);

			// Emit item/completed
			await server.notifyLater("item/completed", {
				threadId: "t1",
				turnId: "turn-1",
				itemId: "item-1",
				itemType: "commandExecution",
				status: "completed",
				data: { command: "echo hello" },
			});
			await Bun.sleep(200);

			// Shut down
			await shutdownBridge(bridgePromise);

			// Verify the tool_end event contains accumulated delta output
			const eventStore = createEventStore(join(overstoryDir, "events.db"));
			const events = eventStore.getByAgent("test-builder");
			const toolEnd = events.find((e) => e.eventType === "tool_end");
			expect(toolEnd).toBeDefined();
			expect(toolEnd?.data).toBeDefined();

			const eventData = JSON.parse(toolEnd?.data ?? "{}") as Record<string, unknown>;
			expect(eventData.outputPreview).toContain("hello world!");
			expect(eventData.outputSize).toBe(12); // "hello " (6) + "world" (5) + "!" (1)

			eventStore.close();
		},
		{ timeout: 15000 },
	);

	// ========================================
	// D. Approval: safe command -> accept
	// ========================================
	test(
		"auto-accepts safe commands (overstory mail check)",
		async () => {
			const config = makeConfig();
			const bridgePromise = runBridge(config);

			await server.waitForRequest("turn/start", 5000);
			await Bun.sleep(200);

			// Send a server-initiated approval request for a safe command.
			// server.request() sends a JSON-RPC request with an id, which is
			// dispatched to the bridge's rpc.onRequest() handler (not onNotification).
			const response = await server.request("requestApproval", {
				type: "command",
				command: "overstory mail check --agent test-builder",
				threadId: "t1",
				turnId: "turn-1",
				itemId: "i1",
			});

			const resp = response as Record<string, unknown>;
			expect(resp.decision).toBe("accept");

			// Shutdown
			await shutdownBridge(bridgePromise);
		},
		{ timeout: 15000 },
	);

	// ========================================
	// E. Approval: dangerous command for non-implementation -> decline
	// ========================================
	test(
		"declines dangerous commands for scout capability",
		async () => {
			const config = makeConfig({ capability: "scout", agentName: "test-scout" });
			// Ensure the agent dir exists for scouts too
			await mkdir(join(overstoryDir, "agents", "test-scout"), { recursive: true });

			const bridgePromise = runBridge(config);

			await server.waitForRequest("turn/start", 5000);
			await Bun.sleep(200);

			// Send approval request for a dangerous command
			const response = await server.request("requestApproval", {
				type: "command",
				command: "rm -rf /tmp/stuff",
				threadId: "t1",
				turnId: "turn-1",
				itemId: "i1",
			});

			const resp = response as Record<string, unknown>;
			expect(resp.decision).toBe("decline");

			// Shutdown
			await shutdownBridge(bridgePromise);
		},
		{ timeout: 15000 },
	);

	// ========================================
	// F. Approval: unknown command for builder -> escalate then decline (timeout)
	// ========================================
	test(
		"escalates unknown command to parent, times out -> decline",
		async () => {
			const config = makeConfig({
				approvalTimeoutMs: 3000, // Short timeout
			});
			const bridgePromise = runBridge(config);

			await server.waitForRequest("turn/start", 5000);
			await Bun.sleep(200);

			// Send approval request for an unknown command (builder escalates)
			const response = await server.request("requestApproval", {
				type: "command",
				command: "some-unknown-tool --flag",
				threadId: "t1",
				turnId: "turn-1",
				itemId: "i-esc",
			});

			const resp = response as Record<string, unknown>;
			// Builder escalates unknown commands. With no parent reply, it times out -> decline
			expect(resp.decision).toBe("decline");

			// Verify escalation mail was sent to parent
			const mailStore = createMailStore(join(overstoryDir, "mail.db"));
			const messages = mailStore.getAll({ to: "test-lead" });
			const escalation = messages.find(
				(m) => m.subject.includes("Approval needed") && m.type === "question",
			);
			expect(escalation).toBeDefined();
			mailStore.close();

			// Shutdown
			await shutdownBridge(bridgePromise);
		},
		{ timeout: 30000 },
	);

	// ========================================
	// G. File change outside worktree -> decline
	// ========================================
	test(
		"declines file changes outside worktree boundary",
		async () => {
			const config = makeConfig();
			const bridgePromise = runBridge(config);

			await server.waitForRequest("turn/start", 5000);
			await Bun.sleep(200);

			// Send approval request for a file change outside worktree
			const response = await server.request("requestApproval", {
				type: "fileChange",
				changes: [{ path: "/etc/passwd", kind: "add" }],
				threadId: "t1",
				turnId: "turn-1",
				itemId: "i-fc",
			});

			const resp = response as Record<string, unknown>;
			expect(resp.decision).toBe("decline");

			// Shutdown
			await shutdownBridge(bridgePromise);
		},
		{ timeout: 15000 },
	);

	// ========================================
	// H. WebSocket disconnection -> bridge exits
	// ========================================
	test(
		"exits gracefully when WebSocket disconnects",
		async () => {
			const config = makeConfig();
			const bridgePromise = runBridge(config);

			await server.waitForRequest("turn/start", 5000);
			await Bun.sleep(200);

			// Close the server (simulates server crash)
			await server.close();

			// Bridge should detect disconnection and resolve
			await bridgePromise;

			// If we get here, the bridge exited gracefully
		},
		{ timeout: 15000 },
	);

	// ========================================
	// I. Token usage + compaction checkpoint
	// ========================================
	test(
		"saves checkpoint when token usage exceeds compaction threshold",
		async () => {
			const config = makeConfig({ compactionThreshold: 0.8 });
			const bridgePromise = runBridge(config);

			await server.waitForRequest("turn/start", 5000);
			await Bun.sleep(200);

			// Emit token usage above threshold (0.9 > 0.8) via setTimeout
			await server.notifyLater("thread/tokenUsage/updated", {
				threadId: "t1",
				inputTokens: 450,
				outputTokens: 450,
				totalTokens: 900,
				contextWindowSize: 1000,
			});

			// Wait for async checkpoint save
			await Bun.sleep(500);

			// Verify checkpoint file exists
			const checkpointPath = join(overstoryDir, "agents", "test-builder", "checkpoint.json");
			const checkpointFile = Bun.file(checkpointPath);
			expect(await checkpointFile.exists()).toBe(true);

			const checkpoint = JSON.parse(await checkpointFile.text()) as Record<string, unknown>;
			expect(checkpoint.agentName).toBe("test-builder");
			expect(checkpoint.beadId).toBe("test-task-1");
			expect(checkpoint.currentBranch).toBe("test-branch");

			// Shutdown
			await shutdownBridge(bridgePromise);
		},
		{ timeout: 15000 },
	);

	// ========================================
	// J. Modified files tracking
	// ========================================
	test(
		"tracks modified files in checkpoint via fileChange items",
		async () => {
			const config = makeConfig({ compactionThreshold: 0.8 });
			const bridgePromise = runBridge(config);

			await server.waitForRequest("turn/start", 5000);
			await Bun.sleep(100);

			// Emit a fileChange item
			await server.notifyLater("item/started", {
				threadId: "t1",
				turnId: "turn-1",
				itemId: "item-fc-1",
				itemType: "fileChange",
				data: { path: "src/foo.ts", kind: "update" },
			});
			await Bun.sleep(50);
			await server.notifyLater("item/completed", {
				threadId: "t1",
				turnId: "turn-1",
				itemId: "item-fc-1",
				itemType: "fileChange",
				status: "completed",
				data: { path: "src/foo.ts", kind: "update" },
			});
			await Bun.sleep(200);

			// Trigger compaction checkpoint via high token usage
			await server.notifyLater("thread/tokenUsage/updated", {
				threadId: "t1",
				inputTokens: 500,
				outputTokens: 450,
				totalTokens: 950,
				contextWindowSize: 1000,
			});

			// Wait for checkpoint save
			await Bun.sleep(500);

			// Verify checkpoint includes the modified file
			const checkpointPath = join(overstoryDir, "agents", "test-builder", "checkpoint.json");
			const checkpointFile = Bun.file(checkpointPath);
			expect(await checkpointFile.exists()).toBe(true);

			const checkpoint = JSON.parse(await checkpointFile.text()) as Record<string, unknown>;
			const filesModified = checkpoint.filesModified as string[];
			expect(filesModified).toContain("src/foo.ts");

			// Shutdown
			await shutdownBridge(bridgePromise);
		},
		{ timeout: 15000 },
	);

	// ========================================
	// K. Worker done mail sent to parent on shutdown
	// ========================================
	test(
		"sends worker_done mail to parent on shutdown",
		async () => {
			const config = makeConfig({ parentAgent: "lead-alpha" });
			const bridgePromise = runBridge(config);

			await server.waitForRequest("turn/start", 5000);
			await Bun.sleep(100);

			// Shutdown triggers performShutdownBookkeeping which sends worker_done
			await shutdownBridge(bridgePromise);

			// Verify worker_done mail was sent
			const mailStore = createMailStore(join(overstoryDir, "mail.db"));
			const messages = mailStore.getAll({ to: "lead-alpha" });
			const workerDone = messages.find((m) => m.type === "worker_done");
			expect(workerDone).toBeDefined();
			expect(workerDone?.from).toBe("test-builder");
			expect(workerDone?.subject).toContain("Worker done");
			mailStore.close();
		},
		{ timeout: 15000 },
	);

	// ========================================
	// L. Verify RPC lifecycle: initialize, thread/start, turn/start order
	// ========================================
	test(
		"sends initialize, thread/start, turn/start in correct order",
		async () => {
			const config = makeConfig();
			const bridgePromise = runBridge(config);

			await server.waitForRequest("turn/start", 5000);

			const requests = server.getReceivedRequests().map((r) => r.method);
			expect(requests[0]).toBe("initialize");
			expect(requests[1]).toBe("thread/start");
			expect(requests[2]).toBe("turn/start");

			await shutdownBridge(bridgePromise);
		},
		{ timeout: 15000 },
	);

	// ========================================
	// M. Shutdown via turn/completed (not WebSocket disconnect)
	// ========================================
	// Regression test: turn/completed must be routed to the shutdown handler,
	// not swallowed by the item/completed wildcard (endsWith("/completed")).
	test(
		"shuts down via turn/completed notification (not WebSocket disconnect)",
		async () => {
			const config = makeConfig();
			const bridgePromise = runBridge(config);

			await server.waitForRequest("turn/start", 5000);
			await Bun.sleep(200);

			// Send turn/completed notification — bridge should detect this and exit
			await server.notifyLater("turn/completed", {
				threadId: "t1",
				turnId: "turn-1",
				status: "completed",
			});

			// Bridge should resolve without us closing the server
			await bridgePromise;

			// If we get here, turn/completed was correctly routed to the shutdown
			// handler instead of being swallowed by item/completed's endsWith wildcard.

			// Verify session_end event was recorded
			const eventStore = createEventStore(join(overstoryDir, "events.db"));
			const events = eventStore.getByAgent("test-builder");
			const sessionEnd = events.find((e) => e.eventType === "session_end");
			expect(sessionEnd).toBeDefined();
			eventStore.close();
		},
		{ timeout: 15000 },
	);
});
