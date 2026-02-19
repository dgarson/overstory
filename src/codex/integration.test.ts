// src/codex/integration.test.ts
// End-to-end pipeline tests for the Codex spawn pipeline.
// Validates that all Codex modules work together correctly WITHOUT a real App Server
// (no real WebSocket connection needed).
import { describe, expect, test } from "bun:test";
import type { OverlayConfig } from "../types";
import { evaluateCommandApproval, evaluateFileChangeApproval } from "./approval";
import { parseBridgeConfig, shouldShutdown } from "./bridge";
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

		// 3. Builder is an implementation agent → DANGEROUS_BASH_PATTERNS not applied.
		// Unknown commands escalate to parent instead of being declined.
		const unknownResult = evaluateCommandApproval("git push origin main", {
			capability: config.capability,
			agentName: config.agentName,
			worktreePath: config.worktreePath,
			fileScope: config.fileScope,
		});
		expect(unknownResult.decision).toBe("escalate");

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
			model: "o3",
			approvalPolicy: "on-request",
		});
		expect(toml).toContain('model = "o3"');
		expect(toml).toContain('sandbox_mode = "danger-full-access"');
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

	test("path traversal via ../ is blocked by resolve() normalization", () => {
		const ctx = {
			capability: "builder",
			agentName: "builder-1",
			worktreePath: "/repo/.overstory/worktrees/builder-1",
			fileScope: ["src/foo.ts"],
		};

		// Attempt to escape worktree via ../
		const traversal = evaluateFileChangeApproval(
			[{ path: "src/../../etc/passwd", kind: "add" as const }],
			ctx,
		);
		expect(traversal.decision).toBe("decline");

		// Absolute path with ../ that escapes worktree
		const absTraversal = evaluateFileChangeApproval(
			[
				{
					path: "/repo/.overstory/worktrees/builder-1/../builder-2/src/foo.ts",
					kind: "update" as const,
				},
			],
			ctx,
		);
		expect(absTraversal.decision).toBe("decline");

		// Relative path that stays within worktree after resolve
		const safeRelative = evaluateFileChangeApproval(
			[{ path: "src/../src/foo.ts", kind: "update" as const }],
			ctx,
		);
		expect(safeRelative.decision).toBe("accept");
	});

	test("DANGEROUS_BASH_PATTERNS only applied to non-implementation capabilities", () => {
		// Scout (non-implementation) → dangerous command is declined
		const scoutCtx = {
			capability: "scout",
			agentName: "scout-1",
			worktreePath: "/repo/.overstory/worktrees/scout-1",
			fileScope: [],
		};
		const scoutRm = evaluateCommandApproval("rm -rf /tmp/stuff", scoutCtx);
		expect(scoutRm.decision).toBe("decline");

		// Builder (implementation) → same command escalates instead
		const builderCtx = {
			capability: "builder",
			agentName: "builder-1",
			worktreePath: "/repo/.overstory/worktrees/builder-1",
			fileScope: [],
		};
		const builderRm = evaluateCommandApproval("rm -rf /tmp/stuff", builderCtx);
		expect(builderRm.decision).toBe("escalate");
	});

	test("coordination capabilities can git add/commit despite dangerous patterns", () => {
		// Coordinator is a coordination capability (coordinator, supervisor, monitor)
		const coordCtx = {
			capability: "coordinator",
			agentName: "coord-1",
			worktreePath: "/repo/.overstory/worktrees/coord-1",
			fileScope: [],
		};

		// git add/commit are in COORDINATION_SAFE_PREFIXES → accept
		const gitAdd = evaluateCommandApproval("git add src/foo.ts", coordCtx);
		expect(gitAdd.decision).toBe("accept");

		const gitCommit = evaluateCommandApproval('git commit -m "fix"', coordCtx);
		expect(gitCommit.decision).toBe("accept");

		// Dangerous patterns still block other commands for coordinators
		const rmResult = evaluateCommandApproval("rm -rf /tmp/stuff", coordCtx);
		expect(rmResult.decision).toBe("decline");
	});

	test("shouldShutdown recognizes terminal statuses", () => {
		expect(shouldShutdown("completed")).toBe(true);
		expect(shouldShutdown("failed")).toBe(true);
		expect(shouldShutdown("cancelled")).toBe(true);
		expect(shouldShutdown("running")).toBe(false);
		expect(shouldShutdown("paused")).toBe(false);
		expect(shouldShutdown("")).toBe(false);
	});

	test("generateCodexConfig sandbox_mode uses dash-separated key name", () => {
		const toml = generateCodexConfig({
			model: "o3",
			approvalPolicy: "on-request",
		});
		// Must be sandbox_mode (not sandbox_policy) with dash-separated value
		expect(toml).toContain("sandbox_mode");
		expect(toml).not.toContain("sandbox_policy");
		expect(toml).toContain("danger-full-access");
		expect(toml).not.toContain("dangerFullAccess");
	});

	test("parseBridgeConfig with all fields populated round-trips correctly", () => {
		// Verifies that every field in BridgeConfig is parsed and
		// accessible — catches regressions if a new env var is added
		// but the parser forgets to handle it.
		const env: Record<string, string> = {
			OVERSTORY_AGENT_NAME: "lead-alpha",
			OVERSTORY_WORKTREE_PATH: "/proj/.overstory/worktrees/lead-alpha",
			OVERSTORY_BRANCH_NAME: "overstory/lead-alpha/task-999",
			OVERSTORY_BEAD_ID: "task-999",
			OVERSTORY_CAPABILITY: "lead",
			OVERSTORY_PARENT_AGENT: "coordinator",
			OVERSTORY_DEPTH: "1",
			OVERSTORY_RUN_ID: "run-42",
			OVERSTORY_SESSION_ID: "sess-42",
			OVERSTORY_CODEX_SERVER_URL: "ws://127.0.0.1:9999",
			OVERSTORY_CODEX_MODEL: "gpt-4.1",
			OVERSTORY_COMPACTION_THRESHOLD: "0.9",
			OVERSTORY_MAX_DELTA_BUFFER: "2097152",
			OVERSTORY_APPROVAL_TIMEOUT: "120000",
			OVERSTORY_FILE_SCOPE: "src/a.ts,src/b.ts,src/c.ts",
			OVERSTORY_PROJECT_ROOT: "/proj",
		};

		const cfg = parseBridgeConfig(env);

		expect(cfg.agentName).toBe("lead-alpha");
		expect(cfg.capability).toBe("lead");
		expect(cfg.parentAgent).toBe("coordinator");
		expect(cfg.depth).toBe(1);
		expect(cfg.runId).toBe("run-42");
		expect(cfg.sessionId).toBe("sess-42");
		expect(cfg.serverUrl).toBe("ws://127.0.0.1:9999");
		expect(cfg.model).toBe("gpt-4.1");
		expect(cfg.compactionThreshold).toBe(0.9);
		expect(cfg.maxDeltaBufferBytes).toBe(2097152);
		expect(cfg.approvalTimeoutMs).toBe(120000);
		expect(cfg.fileScope).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
		expect(cfg.projectRoot).toBe("/proj");
	});

	test("generateCodexConfig with never policy still includes sandbox_mode", () => {
		// When approval_policy is "never", sandbox_mode should still be present
		// (the App Server needs to know the sandbox environment)
		const toml = generateCodexConfig({
			model: "gpt-4.1",
			approvalPolicy: "never",
		});
		expect(toml).toContain('model = "gpt-4.1"');
		expect(toml).toContain('approval_policy = "never"');
		expect(toml).toContain('sandbox_mode = "danger-full-access"');
	});

	test("buildInitialPrompt inputs: parseBridgeConfig populates all priming fields", () => {
		// buildInitialPrompt is not exported, but we can verify its inputs
		// by testing that parseBridgeConfig correctly populates all the
		// fields that buildInitialPrompt depends on: agentName, capability,
		// beadId, depth, parentAgent, sessionId, and projectRoot.
		const config = parseBridgeConfig({
			OVERSTORY_AGENT_NAME: "builder-priming",
			OVERSTORY_CAPABILITY: "builder",
			OVERSTORY_BEAD_ID: "task-prime-1",
			OVERSTORY_DEPTH: "2",
			OVERSTORY_PARENT_AGENT: "lead-1",
			OVERSTORY_SESSION_ID: "sess-prime",
			OVERSTORY_PROJECT_ROOT: "/proj",
		});

		// All fields used by buildInitialPrompt must be populated
		expect(config.agentName).toBe("builder-priming");
		expect(config.capability).toBe("builder");
		expect(config.beadId).toBe("task-prime-1");
		expect(config.depth).toBe(2);
		expect(config.parentAgent).toBe("lead-1");
		expect(config.sessionId).toBe("sess-prime");
		expect(config.projectRoot).toBe("/proj");
		// Defaults for optional fields should still be sane
		expect(config.serverUrl).toContain("ws://");
		expect(config.model.length).toBeGreaterThan(0);
	});
});
