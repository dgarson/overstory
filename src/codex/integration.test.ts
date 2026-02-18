// src/codex/integration.test.ts
// End-to-end pipeline tests for the Codex spawn pipeline.
// Validates that all Codex modules work together correctly WITHOUT a real App Server
// (no real WebSocket connection needed).
import { describe, expect, test } from "bun:test";
import type { OverlayConfig } from "../types";
import { evaluateCommandApproval, evaluateFileChangeApproval } from "./approval";
import { parseBridgeConfig } from "./bridge";
import { generateCodexConfig } from "./config-gen";
import { createDeltaBufferManager, normalizeItemCompleted, normalizeItemStarted } from "./events";
import { generateAgentsOverlay } from "./overlay";

describe("Codex integration pipeline", () => {
	test("parseBridgeConfig → approval → event normalization pipeline", () => {
		// 1. Parse config from env vars
		const config = parseBridgeConfig({
			OVERSTORY_AGENT_NAME: "builder-1",
			OVERSTORY_WORKTREE_PATH: "/repo/.overstory/worktrees/builder-1",
			OVERSTORY_BRANCH_NAME: "overstory/builder-1/task-123",
			OVERSTORY_BEAD_ID: "task-123",
			OVERSTORY_CAPABILITY: "builder",
			OVERSTORY_PARENT_AGENT: "lead-1",
			OVERSTORY_DEPTH: "2",
			OVERSTORY_RUN_ID: "run-1",
			OVERSTORY_SESSION_ID: "sess-1",
			OVERSTORY_CODEX_SERVER_URL: "ws://127.0.0.1:21816",
			OVERSTORY_CODEX_MODEL: "o3",
			OVERSTORY_COMPACTION_THRESHOLD: "0.8",
			OVERSTORY_MAX_DELTA_BUFFER: "1048576",
			OVERSTORY_APPROVAL_TIMEOUT: "60000",
			OVERSTORY_FILE_SCOPE: "src/foo.ts,src/bar.ts",
			OVERSTORY_PROJECT_ROOT: "/repo",
		});

		expect(config.agentName).toBe("builder-1");
		expect(config.capability).toBe("builder");
		expect(config.fileScope).toEqual(["src/foo.ts", "src/bar.ts"]);
		expect(config.maxDeltaBufferBytes).toBe(1048576);

		// 2. Evaluate a safe command → accept
		const safeResult = evaluateCommandApproval("bun test src/foo.test.ts", {
			capability: config.capability,
			agentName: config.agentName,
			worktreePath: config.worktreePath,
			fileScope: config.fileScope,
		});
		expect(safeResult.decision).toBe("accept");

		// 3. Evaluate a dangerous command → decline
		const dangerResult = evaluateCommandApproval("git push origin main", {
			capability: config.capability,
			agentName: config.agentName,
			worktreePath: config.worktreePath,
			fileScope: config.fileScope,
		});
		expect(dangerResult.decision).toBe("decline");

		// 4. Create delta buffer, accumulate, flush
		const deltaManager = createDeltaBufferManager(config.maxDeltaBufferBytes);
		deltaManager.start("item-1", "commandExecution", new Date().toISOString());
		deltaManager.appendDelta("item-1", "hello ");
		deltaManager.appendDelta("item-1", "world");
		const flushed = deltaManager.flush("item-1");

		if (flushed === null) throw new Error("expected flushed buffer, got null");
		expect(flushed.output).toBe("hello world");
		expect(flushed.truncated).toBe(false);
		expect(flushed.totalBytes).toBe(11); // "hello " (6) + "world" (5)

		// 5. Normalize to EventStore format (item completed)
		const event = normalizeItemCompleted({
			agentName: config.agentName,
			sessionId: config.sessionId,
			runId: config.runId,
			itemId: "item-1",
			itemType: "commandExecution",
			status: "completed",
			data: { command: "bun test src/foo.test.ts" },
			deltaOutput: flushed,
			durationMs: 1500,
		});

		// 6. Verify normalized event has correct fields
		expect(event.eventType).toBe("tool_end");
		expect(event.toolName).toBe("Bash");
		expect(event.agentName).toBe("builder-1");
		expect(event.level).toBe("info");
		expect(event.toolDurationMs).toBe(1500);
		expect(event.runId).toBe("run-1");
		expect(event.sessionId).toBe("sess-1");
	});

	test("normalizeItemStarted produces correct tool_start record", () => {
		const record = normalizeItemStarted({
			agentName: "builder-1",
			sessionId: "sess-1",
			runId: "run-1",
			itemId: "item-2",
			itemType: "commandExecution",
			data: { command: "bun run lint" },
		});

		expect(record.eventType).toBe("tool_start");
		expect(record.toolName).toBe("Bash");
		expect(record.agentName).toBe("builder-1");
		expect(record.level).toBe("info");
		expect(record.toolArgs).toContain("bun run lint");
	});

	test("AGENTS.md overlay generated correctly for builder", async () => {
		const config: OverlayConfig = {
			agentName: "builder-1",
			beadId: "task-123",
			specPath: "/repo/.overstory/specs/task-123.md",
			branchName: "overstory/builder-1/task-123",
			worktreePath: "/repo/.overstory/worktrees/builder-1",
			fileScope: ["src/foo.ts", "src/bar.ts"],
			mulchDomains: ["cli"],
			parentAgent: "lead-1",
			depth: 2,
			canSpawn: false,
			capability: "builder",
			baseDefinition: "# Builder Agent\n\nYou are a builder.",
		};

		const content = await generateAgentsOverlay(config);

		// Contains the agent name and task ID
		expect(content).toContain("builder-1");
		expect(content).toContain("task-123");
		expect(content).toContain("src/foo.ts");

		// Does NOT reference Claude Code-specific things
		expect(content).not.toContain(".claude/CLAUDE.md");
		expect(content).not.toContain("--dangerously-skip-permissions");

		// Contains the worktree path
		expect(content).toContain("/repo/.overstory/worktrees/builder-1");

		// Contains the base definition content
		expect(content).toContain("You are a builder.");

		// Contains the parent agent name
		expect(content).toContain("lead-1");
	});

	test("generateCodexConfig produces valid TOML for on-request approval", () => {
		const toml = generateCodexConfig({
			model: "codex-mini-latest",
			approvalPolicy: "on-request",
		});
		expect(toml).toContain('model = "codex-mini-latest"');
		expect(toml).toContain('sandbox_policy = "dangerFullAccess"');
		expect(toml).toContain('approval_policy = "on-request"');
	});

	test("generateCodexConfig produces valid TOML for never approval policy", () => {
		const toml = generateCodexConfig({
			model: "o3",
			approvalPolicy: "never",
		});
		expect(toml).toContain('model = "o3"');
		expect(toml).toContain('approval_policy = "never"');
	});

	test("file change approval enforces worktree scope", () => {
		const ctx = {
			capability: "builder",
			agentName: "builder-1",
			worktreePath: "/repo/.overstory/worktrees/builder-1",
			fileScope: ["src/foo.ts"],
		};

		// Within worktree AND in scope → accept
		const inScope = evaluateFileChangeApproval(
			[{ path: "/repo/.overstory/worktrees/builder-1/src/foo.ts", kind: "update" as const }],
			ctx,
		);
		expect(inScope.decision).toBe("accept");

		// Within worktree but outside scope → escalate
		const outOfScope = evaluateFileChangeApproval(
			[{ path: "/repo/.overstory/worktrees/builder-1/src/other.ts", kind: "add" as const }],
			ctx,
		);
		expect(outOfScope.decision).toBe("escalate");

		// Outside worktree entirely → decline
		const outsideWorktree = evaluateFileChangeApproval(
			[{ path: "/repo/src/foo.ts", kind: "update" as const }],
			ctx,
		);
		expect(outsideWorktree.decision).toBe("decline");
	});

	test("scout capability gets extra write prefix for spec files", () => {
		const scoutCtx = {
			capability: "scout",
			agentName: "scout-1",
			worktreePath: "/repo/.overstory/worktrees/scout-1",
			fileScope: [],
		};

		// Scout can use overstory spec write
		const specResult = evaluateCommandApproval(
			"overstory spec write task-456 --body 'spec'",
			scoutCtx,
		);
		expect(specResult.decision).toBe("accept");
	});

	test("non-implementation capability (reviewer) cannot modify files", () => {
		const reviewerCtx = {
			capability: "reviewer",
			agentName: "reviewer-1",
			worktreePath: "/repo/.overstory/worktrees/reviewer-1",
			fileScope: [],
		};

		const result = evaluateFileChangeApproval(
			[{ path: "/repo/.overstory/worktrees/reviewer-1/src/foo.ts", kind: "update" as const }],
			reviewerCtx,
		);
		expect(result.decision).toBe("decline");
	});

	test("delta buffer truncates when output exceeds max bytes", () => {
		const smallMax = 10; // 10 byte limit
		const deltaManager = createDeltaBufferManager(smallMax);

		deltaManager.start("item-trunc", "commandExecution", new Date().toISOString());
		deltaManager.appendDelta("item-trunc", "hello"); // 5 bytes — within limit
		deltaManager.appendDelta("item-trunc", " world!"); // 7 more bytes — exceeds limit

		const flushed = deltaManager.flush("item-trunc");
		if (flushed === null) throw new Error("expected flushed buffer, got null");

		// totalBytes counts all bytes even when truncated
		expect(flushed.totalBytes).toBe(12);
		expect(flushed.truncated).toBe(true);
		// Only the first chunk (within limit) should be in output
		expect(flushed.output).toBe("hello");
	});

	test("parseBridgeConfig uses defaults for missing optional fields", () => {
		const config = parseBridgeConfig({
			OVERSTORY_AGENT_NAME: "test-agent",
			OVERSTORY_SESSION_ID: "sess-x",
		});

		expect(config.agentName).toBe("test-agent");
		expect(config.serverUrl).toBe("ws://127.0.0.1:21816");
		expect(config.model).toBe("o3");
		expect(config.compactionThreshold).toBe(0.8);
		expect(config.maxDeltaBufferBytes).toBe(1048576);
		expect(config.approvalTimeoutMs).toBe(60000);
		expect(config.fileScope).toEqual([]);
		expect(config.parentAgent).toBeNull();
		expect(config.runId).toBeNull();
	});

	test("normalizeItemCompleted marks failed items as error level", () => {
		const event = normalizeItemCompleted({
			agentName: "builder-1",
			sessionId: "sess-1",
			runId: null,
			itemId: "item-fail",
			itemType: "commandExecution",
			status: "failed",
			data: { command: "bun test" },
			deltaOutput: null,
			durationMs: 500,
		});

		expect(event.level).toBe("error");
		expect(event.toolName).toBe("Bash");
		expect(event.runId).toBeNull();
	});

	test("fileChange item type maps to correct tool name based on kind", () => {
		// add → Write
		const addEvent = normalizeItemCompleted({
			agentName: "builder-1",
			sessionId: "sess-1",
			runId: null,
			itemId: "item-add",
			itemType: "fileChange",
			status: "completed",
			data: { kind: "add", path: "src/new.ts" },
			deltaOutput: null,
			durationMs: 100,
		});
		expect(addEvent.toolName).toBe("Write");

		// update → Edit
		const updateEvent = normalizeItemCompleted({
			agentName: "builder-1",
			sessionId: "sess-1",
			runId: null,
			itemId: "item-update",
			itemType: "fileChange",
			status: "completed",
			data: { kind: "update", path: "src/existing.ts" },
			deltaOutput: null,
			durationMs: 100,
		});
		expect(updateEvent.toolName).toBe("Edit");
	});
});
