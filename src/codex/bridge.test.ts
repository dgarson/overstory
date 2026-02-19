// src/codex/bridge.test.ts

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCheckpoint } from "../agents/checkpoint";
import { createIdentity } from "../agents/identity";
import { createEventStore } from "../events/store";
import { createMailClient } from "../mail/client";
import { createMailStore } from "../mail/store";
import { openSessionStore } from "../sessions/compat";
import { createRunStore, createSessionStore } from "../sessions/store";
import type { AgentIdentity } from "../types";
import {
	buildInitialPrompt,
	buildReconnectPrompt,
	matchesEscalationReply,
	parseBridgeConfig,
	performShutdownBookkeeping,
	type ShutdownDeps,
	shouldAttemptReconnect,
	shouldSaveCheckpoint,
	shouldShutdown,
} from "./bridge";
import type { BridgeConfig } from "./types";

// ---- Existing tests ----

describe("parseBridgeConfig", () => {
	test("parses all fields from env vars", () => {
		const env = {
			OVERSTORY_AGENT_NAME: "builder-1",
			OVERSTORY_WORKTREE_PATH: "/repo/.overstory/worktrees/builder-1",
			OVERSTORY_BRANCH_NAME: "overstory/builder-1/task-123",
			OVERSTORY_BEAD_ID: "task-123",
			OVERSTORY_CAPABILITY: "builder",
			OVERSTORY_PARENT_AGENT: "lead-1",
			OVERSTORY_DEPTH: "2",
			OVERSTORY_RUN_ID: "run-2024",
			OVERSTORY_SESSION_ID: "sess-1",
			OVERSTORY_CODEX_SERVER_URL: "ws://127.0.0.1:21816",
			OVERSTORY_CODEX_MODEL: "o3",
			OVERSTORY_COMPACTION_THRESHOLD: "0.8",
			OVERSTORY_MAX_DELTA_BUFFER: "1048576",
			OVERSTORY_APPROVAL_TIMEOUT: "60000",
			OVERSTORY_FILE_SCOPE: "src/foo.ts,src/bar.ts",
			OVERSTORY_PROJECT_ROOT: "/repo",
		};

		const config = parseBridgeConfig(env);
		expect(config.agentName).toBe("builder-1");
		expect(config.worktreePath).toBe("/repo/.overstory/worktrees/builder-1");
		expect(config.branchName).toBe("overstory/builder-1/task-123");
		expect(config.beadId).toBe("task-123");
		expect(config.capability).toBe("builder");
		expect(config.parentAgent).toBe("lead-1");
		expect(config.depth).toBe(2);
		expect(config.runId).toBe("run-2024");
		expect(config.sessionId).toBe("sess-1");
		expect(config.serverUrl).toBe("ws://127.0.0.1:21816");
		expect(config.model).toBe("o3");
		expect(config.compactionThreshold).toBe(0.8);
		expect(config.maxDeltaBufferBytes).toBe(1048576);
		expect(config.approvalTimeoutMs).toBe(60000);
		expect(config.fileScope).toEqual(["src/foo.ts", "src/bar.ts"]);
		expect(config.projectRoot).toBe("/repo");
	});

	test("applies defaults for missing optional env vars", () => {
		const env: Record<string, string | undefined> = {};
		const config = parseBridgeConfig(env);
		expect(config.agentName).toBe("");
		expect(config.capability).toBe("builder");
		expect(config.serverUrl).toBe("ws://127.0.0.1:21816");
		expect(config.model).toBe("o3");
		expect(config.compactionThreshold).toBe(0.8);
		expect(config.maxDeltaBufferBytes).toBe(1048576);
		expect(config.approvalTimeoutMs).toBe(60000);
		expect(config.fileScope).toEqual([]);
		expect(config.parentAgent).toBeNull();
		expect(config.runId).toBeNull();
		expect(config.depth).toBe(0);
		expect(config.maxReconnectAttempts).toBe(3);
		expect(config.reconnectBaseDelayMs).toBe(2000);
	});

	test("parses reconnect config from env vars", () => {
		const env = {
			OVERSTORY_MAX_RECONNECT_ATTEMPTS: "5",
			OVERSTORY_RECONNECT_BASE_DELAY: "1000",
		};
		const config = parseBridgeConfig(env);
		expect(config.maxReconnectAttempts).toBe(5);
		expect(config.reconnectBaseDelayMs).toBe(1000);
	});

	test("parses empty file scope as empty array", () => {
		const env = { OVERSTORY_FILE_SCOPE: "" };
		const config = parseBridgeConfig(env);
		expect(config.fileScope).toEqual([]);
	});

	test("parentAgent is null when env var is empty string", () => {
		const env = { OVERSTORY_PARENT_AGENT: "" };
		const config = parseBridgeConfig(env);
		expect(config.parentAgent).toBeNull();
	});

	test("runId is null when env var is empty string", () => {
		const env = { OVERSTORY_RUN_ID: "" };
		const config = parseBridgeConfig(env);
		expect(config.runId).toBeNull();
	});
});

describe("shouldShutdown", () => {
	test("returns true for terminal turn statuses", () => {
		expect(shouldShutdown("completed")).toBe(true);
		expect(shouldShutdown("failed")).toBe(true);
		expect(shouldShutdown("cancelled")).toBe(true);
	});

	test("returns false for non-terminal turn statuses", () => {
		expect(shouldShutdown("interrupted")).toBe(false);
		expect(shouldShutdown("running")).toBe(false);
		expect(shouldShutdown("")).toBe(false);
		expect(shouldShutdown("unknown")).toBe(false);
	});
});

// ---- New extracted function tests ----

/** Helper: build a minimal BridgeConfig for tests. */
function makeTestConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
	return {
		agentName: "test-builder",
		worktreePath: "/tmp/test-worktree",
		branchName: "overstory/test-builder/task-1",
		beadId: "task-1",
		capability: "builder",
		parentAgent: "lead-1",
		depth: 2,
		runId: "run-1",
		sessionId: "sess-1",
		serverUrl: "ws://127.0.0.1:21816",
		model: "o3",
		compactionThreshold: 0.8,
		maxDeltaBufferBytes: 1048576,
		approvalTimeoutMs: 60000,
		fileScope: ["src/foo.ts"],
		projectRoot: "/tmp/test-project",
		maxReconnectAttempts: 3,
		reconnectBaseDelayMs: 2000,
		...overrides,
	};
}

// ========================================
// buildInitialPrompt
// ========================================

describe("buildInitialPrompt", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "bridge-prompt-test-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("includes beacon header with agent name, capability, and beadId", async () => {
		const config = makeTestConfig({ projectRoot: tempDir });
		const overstoryDir = join(tempDir, ".overstory");
		const { mkdir } = await import("node:fs/promises");
		await mkdir(overstoryDir, { recursive: true });

		const prompt = await buildInitialPrompt(config, overstoryDir);

		expect(prompt).toContain("[OVERSTORY] test-builder (builder)");
		expect(prompt).toContain("task:task-1");
		expect(prompt).toContain("Depth: 2 | Parent: lead-1");
	});

	test("includes beacon header with 'none' when no parent", async () => {
		const config = makeTestConfig({ parentAgent: null, projectRoot: tempDir });
		const overstoryDir = join(tempDir, ".overstory");
		const { mkdir } = await import("node:fs/promises");
		await mkdir(overstoryDir, { recursive: true });

		const prompt = await buildInitialPrompt(config, overstoryDir);

		expect(prompt).toContain("Parent: none");
	});

	test("includes identity section when identity.yaml exists", async () => {
		const config = makeTestConfig({ projectRoot: tempDir });
		const overstoryDir = join(tempDir, ".overstory");
		const agentsDir = join(overstoryDir, "agents");

		const identity: AgentIdentity = {
			name: "test-builder",
			capability: "builder",
			created: new Date().toISOString(),
			sessionsCompleted: 5,
			expertiseDomains: [],
			recentTasks: [],
		};
		await createIdentity(agentsDir, identity);

		const prompt = await buildInitialPrompt(config, overstoryDir);

		expect(prompt).toContain("Identity: 5 prior sessions");
	});

	test("omits identity section when no identity file", async () => {
		const config = makeTestConfig({ projectRoot: tempDir });
		const overstoryDir = join(tempDir, ".overstory");
		const { mkdir } = await import("node:fs/promises");
		await mkdir(overstoryDir, { recursive: true });

		const prompt = await buildInitialPrompt(config, overstoryDir);

		expect(prompt).not.toContain("Identity:");
	});

	test("includes checkpoint recovery section when checkpoint exists", async () => {
		const config = makeTestConfig({ projectRoot: tempDir });
		const overstoryDir = join(tempDir, ".overstory");
		const agentsDir = join(overstoryDir, "agents");

		await saveCheckpoint(agentsDir, {
			agentName: "test-builder",
			beadId: "task-1",
			sessionId: "sess-old",
			timestamp: new Date().toISOString(),
			progressSummary: "Implemented half the feature",
			filesModified: ["src/foo.ts", "src/bar.ts"],
			currentBranch: "overstory/test-builder/task-1",
			pendingWork: "Finish tests",
			mulchDomains: [],
		});

		const prompt = await buildInitialPrompt(config, overstoryDir);

		expect(prompt).toContain("## Session Recovery");
		expect(prompt).toContain("Implemented half the feature");
		expect(prompt).toContain("src/foo.ts, src/bar.ts");
		expect(prompt).toContain("Finish tests");
	});

	test("omits recovery section when no checkpoint", async () => {
		const config = makeTestConfig({ projectRoot: tempDir });
		const overstoryDir = join(tempDir, ".overstory");
		const { mkdir } = await import("node:fs/promises");
		await mkdir(overstoryDir, { recursive: true });

		const prompt = await buildInitialPrompt(config, overstoryDir);

		expect(prompt).not.toContain("Session Recovery");
	});

	test("includes pending mail section when messages exist", async () => {
		const config = makeTestConfig({ projectRoot: tempDir });
		const overstoryDir = join(tempDir, ".overstory");
		const { mkdir } = await import("node:fs/promises");
		await mkdir(overstoryDir, { recursive: true });

		// Insert a message addressed to our agent
		const mailStore = createMailStore(join(overstoryDir, "mail.db"));
		const mailClient = createMailClient(mailStore);
		mailClient.send({
			from: "lead-1",
			to: "test-builder",
			subject: "Instructions",
			body: "Please build the feature now",
			type: "status",
			priority: "normal",
		});
		// Do NOT check (mark as read) — the messages should be found as unread
		mailClient.close();

		const prompt = await buildInitialPrompt(config, overstoryDir);

		expect(prompt).toContain("## Pending Messages");
		expect(prompt).toContain("[lead-1] Instructions");
		expect(prompt).toContain("Please build the feature now");
	});

	test("omits mail section when no pending messages", async () => {
		const config = makeTestConfig({ projectRoot: tempDir });
		const overstoryDir = join(tempDir, ".overstory");
		const { mkdir } = await import("node:fs/promises");
		await mkdir(overstoryDir, { recursive: true });

		const prompt = await buildInitialPrompt(config, overstoryDir);

		expect(prompt).not.toContain("Pending Messages");
	});

	test("always includes activation section", async () => {
		const config = makeTestConfig({ projectRoot: tempDir });
		const overstoryDir = join(tempDir, ".overstory");
		const { mkdir } = await import("node:fs/promises");
		await mkdir(overstoryDir, { recursive: true });

		const prompt = await buildInitialPrompt(config, overstoryDir);

		expect(prompt).toContain("You have a bound task: **task-1**");
		expect(prompt).toContain("Read your AGENTS.md overlay");
		expect(prompt).toContain("Do not wait for dispatch mail");
	});

	test("gracefully degrades when all optional sections are missing", async () => {
		const config = makeTestConfig({ parentAgent: null, projectRoot: tempDir });
		const overstoryDir = join(tempDir, ".overstory");
		const { mkdir } = await import("node:fs/promises");
		await mkdir(overstoryDir, { recursive: true });

		const prompt = await buildInitialPrompt(config, overstoryDir);

		// Should not crash, should contain at least the beacon and activation
		expect(prompt).toContain("[OVERSTORY]");
		expect(prompt).toContain("You have a bound task:");
		expect(prompt).not.toContain("Identity:");
		expect(prompt).not.toContain("Session Recovery");
		expect(prompt).not.toContain("Pending Messages");
	});
});

// ========================================
// matchesEscalationReply
// ========================================

describe("matchesEscalationReply", () => {
	const marker = "[item-abc]";
	const parent = "lead-1";

	test("returns null when sender is not parent", () => {
		const result = matchesEscalationReply(
			{ from: "other-agent", subject: "Approved", type: "result" },
			marker,
			parent,
		);
		expect(result).toBeNull();
	});

	test("returns 'approve' when subject contains 'approve'", () => {
		const result = matchesEscalationReply(
			{ from: parent, subject: "I approve this command", type: "status" },
			marker,
			parent,
		);
		expect(result).toBe("approve");
	});

	test("returns 'approve' when subject contains 'accept'", () => {
		const result = matchesEscalationReply(
			{ from: parent, subject: "Accept the change", type: "status" },
			marker,
			parent,
		);
		expect(result).toBe("approve");
	});

	test("returns 'reject' when subject contains 'decline'", () => {
		const result = matchesEscalationReply(
			{ from: parent, subject: "I decline this", type: "status" },
			marker,
			parent,
		);
		expect(result).toBe("reject");
	});

	test("returns 'reject' when subject contains 'reject'", () => {
		const result = matchesEscalationReply(
			{ from: parent, subject: "Reject that command", type: "result" },
			marker,
			parent,
		);
		expect(result).toBe("reject");
	});

	test("is case-insensitive for keywords", () => {
		expect(
			matchesEscalationReply({ from: parent, subject: "APPROVED", type: "status" }, marker, parent),
		).toBe("approve");

		expect(
			matchesEscalationReply({ from: parent, subject: "REJECTED", type: "status" }, marker, parent),
		).toBe("reject");
	});

	test("returns 'approve' when marker correlates with result type", () => {
		const result = matchesEscalationReply(
			{ from: parent, subject: `Re: ${marker} something`, type: "result" },
			marker,
			parent,
		);
		expect(result).toBe("approve");
	});

	test("returns 'approve' when marker correlates with status type", () => {
		const result = matchesEscalationReply(
			{ from: parent, subject: `${marker} ok`, type: "status" },
			marker,
			parent,
		);
		expect(result).toBe("approve");
	});

	test("returns 'reject' when marker correlates with error type", () => {
		const result = matchesEscalationReply(
			{ from: parent, subject: `${marker} failed`, type: "error" },
			marker,
			parent,
		);
		expect(result).toBe("reject");
	});

	test("returns null when marker present but type is unrecognized", () => {
		const result = matchesEscalationReply(
			{ from: parent, subject: `${marker} something`, type: "question" },
			marker,
			parent,
		);
		expect(result).toBeNull();
	});

	test("returns null for unrelated message from parent", () => {
		const result = matchesEscalationReply(
			{ from: parent, subject: "Status update on other thing", type: "status" },
			marker,
			parent,
		);
		expect(result).toBeNull();
	});

	test("returns null when type is undefined and no keyword match", () => {
		const result = matchesEscalationReply(
			{ from: parent, subject: `${marker} response` },
			marker,
			parent,
		);
		expect(result).toBeNull();
	});

	test("keyword takes precedence over marker-based matching", () => {
		// Subject contains both "approve" keyword AND marker with error type.
		// Keywords are checked first, so "approve" wins.
		const result = matchesEscalationReply(
			{ from: parent, subject: `${marker} approve`, type: "error" },
			marker,
			parent,
		);
		expect(result).toBe("approve");
	});
});

// ========================================
// shouldSaveCheckpoint
// ========================================

describe("shouldSaveCheckpoint", () => {
	const threshold = 0.8;
	const debounceMs = 30_000;

	test("returns false when below threshold", () => {
		// 70% usage, well below 80% threshold
		expect(shouldSaveCheckpoint(7000, 10000, threshold, 0, debounceMs, 100_000)).toBe(false);
	});

	test("returns true at threshold with past debounce", () => {
		// Exactly at 80% threshold, debounce long expired
		expect(shouldSaveCheckpoint(8000, 10000, threshold, 0, debounceMs, 100_000)).toBe(true);
	});

	test("returns true above threshold with past debounce", () => {
		// 90% usage
		expect(shouldSaveCheckpoint(9000, 10000, threshold, 0, debounceMs, 100_000)).toBe(true);
	});

	test("returns false at threshold within debounce window", () => {
		// At threshold but last save was only 10 seconds ago (debounce is 30s)
		const lastSave = 90_000;
		const now = 100_000;
		expect(shouldSaveCheckpoint(8000, 10000, threshold, lastSave, debounceMs, now)).toBe(false);
	});

	test("returns false when contextWindowSize is zero", () => {
		// Avoids division by zero
		expect(shouldSaveCheckpoint(8000, 0, threshold, 0, debounceMs, 100_000)).toBe(false);
	});

	test("returns false when contextWindowSize is negative", () => {
		expect(shouldSaveCheckpoint(8000, -1, threshold, 0, debounceMs, 100_000)).toBe(false);
	});

	test("returns true at exactly 100% usage", () => {
		expect(shouldSaveCheckpoint(10000, 10000, threshold, 0, debounceMs, 100_000)).toBe(true);
	});

	test("returns true above 100% usage", () => {
		// Token count can exceed context window in some edge cases
		expect(shouldSaveCheckpoint(12000, 10000, threshold, 0, debounceMs, 100_000)).toBe(true);
	});

	test("handles various ratio values near threshold", () => {
		// 0.79 -> below 0.8 threshold
		expect(shouldSaveCheckpoint(79, 100, threshold, 0, debounceMs, 100_000)).toBe(false);
		// 0.80 -> at threshold
		expect(shouldSaveCheckpoint(80, 100, threshold, 0, debounceMs, 100_000)).toBe(true);
		// 0.81 -> above threshold
		expect(shouldSaveCheckpoint(81, 100, threshold, 0, debounceMs, 100_000)).toBe(true);
	});

	test("respects custom threshold of 0.7", () => {
		// 70% with 0.7 threshold -> at threshold
		expect(shouldSaveCheckpoint(7000, 10000, 0.7, 0, debounceMs, 100_000)).toBe(true);
		// 69% with 0.7 threshold -> below
		expect(shouldSaveCheckpoint(6900, 10000, 0.7, 0, debounceMs, 100_000)).toBe(false);
	});

	test("uses Date.now() when nowMs is not provided", () => {
		// With lastSaveMs of 0, the debounce should be expired since Date.now() >> 30000
		expect(shouldSaveCheckpoint(8000, 10000, threshold, 0, debounceMs)).toBe(true);
	});

	test("returns true when debounce exactly expired", () => {
		const lastSave = 70_000;
		const now = 100_000; // 30_000ms after lastSave, exactly at debounce boundary
		expect(shouldSaveCheckpoint(8000, 10000, threshold, lastSave, debounceMs, now)).toBe(true);
	});
});

// ========================================
// performShutdownBookkeeping
// ========================================

describe("performShutdownBookkeeping", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "bridge-shutdown-test-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	/** Helper: set up a real .overstory dir with needed subdirectories */
	async function setupOverstoryDir(): Promise<string> {
		const overstoryDir = join(tempDir, ".overstory");
		const { mkdir } = await import("node:fs/promises");
		await mkdir(join(overstoryDir, "agents", "test-builder"), { recursive: true });
		return overstoryDir;
	}

	/** Helper: create a real identity file for the agent */
	async function createTestIdentity(overstoryDir: string): Promise<void> {
		const agentsDir = join(overstoryDir, "agents");
		await createIdentity(agentsDir, {
			name: "test-builder",
			capability: "builder",
			created: new Date().toISOString(),
			sessionsCompleted: 3,
			expertiseDomains: [],
			recentTasks: [],
		});
	}

	/** Helper: create a session record in the SessionStore */
	function createTestSession(overstoryDir: string): void {
		const store = createSessionStore(join(overstoryDir, "sessions.db"));
		store.upsert({
			id: "sess-1",
			agentName: "test-builder",
			capability: "builder",
			worktreePath: "/tmp/test-worktree",
			branchName: "overstory/test-builder/task-1",
			beadId: "task-1",
			tmuxSession: "overstory-test-fake",
			state: "working",
			pid: null,
			parentAgent: "lead-1",
			depth: 2,
			runId: "run-1",
			startedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
			runtime: "codex",
		});
		store.close();
	}

	/** Helper: build ShutdownDeps using real SQLite stores at a temp path */
	async function makeRealDeps(
		overstoryDir: string,
		overrides: Partial<ShutdownDeps> = {},
	): Promise<ShutdownDeps> {
		const { updateIdentity: realUpdateIdentity } = await import("../agents/identity");
		const eventStore = createEventStore(join(overstoryDir, "events.db"));
		const mailStore = createMailStore(join(overstoryDir, "mail.db"));
		const mailClient = createMailClient(mailStore);

		return {
			eventStore,
			mailClient,
			openSessionStore,
			updateIdentity: realUpdateIdentity,
			createRunStore,
			...overrides,
		};
	}

	test("records session_end event in EventStore", async () => {
		const overstoryDir = await setupOverstoryDir();
		const config = makeTestConfig({ projectRoot: tempDir });
		const deps = await makeRealDeps(overstoryDir);

		await performShutdownBookkeeping(config, overstoryDir, deps);

		const events = deps.eventStore.getByAgent("test-builder");
		const sessionEnd = events.find((e) => e.eventType === "session_end");
		expect(sessionEnd).toBeDefined();
		expect(sessionEnd?.agentName).toBe("test-builder");
		expect(sessionEnd?.level).toBe("info");
		const data = JSON.parse(sessionEnd?.data ?? "{}") as Record<string, unknown>;
		expect(data.reason).toBe("turn_completed");
		expect(data.runtime).toBe("codex");

		deps.eventStore.close();
		deps.mailClient.close();
	});

	test("updates SessionStore state to completed", async () => {
		const overstoryDir = await setupOverstoryDir();
		createTestSession(overstoryDir);
		const config = makeTestConfig({ projectRoot: tempDir });
		const deps = await makeRealDeps(overstoryDir);

		await performShutdownBookkeeping(config, overstoryDir, deps);

		// Verify session state is now "completed"
		const { store } = openSessionStore(overstoryDir);
		const session = store.getByName("test-builder");
		expect(session?.state).toBe("completed");
		store.close();

		deps.eventStore.close();
		deps.mailClient.close();
	});

	test("increments identity.sessionsCompleted", async () => {
		const overstoryDir = await setupOverstoryDir();
		await createTestIdentity(overstoryDir);
		const config = makeTestConfig({ projectRoot: tempDir });
		const deps = await makeRealDeps(overstoryDir);

		await performShutdownBookkeeping(config, overstoryDir, deps);

		// Check identity was updated
		const { loadIdentity } = await import("../agents/identity");
		const identity = await loadIdentity(join(overstoryDir, "agents"), "test-builder");
		expect(identity?.sessionsCompleted).toBe(4); // was 3, incremented by 1

		deps.eventStore.close();
		deps.mailClient.close();
	});

	test("sends worker_done mail to parent when parentAgent exists", async () => {
		const overstoryDir = await setupOverstoryDir();
		const config = makeTestConfig({ parentAgent: "lead-1", projectRoot: tempDir });
		const deps = await makeRealDeps(overstoryDir);

		await performShutdownBookkeeping(config, overstoryDir, deps);

		// Check that a worker_done message was sent
		const mailStore = createMailStore(join(overstoryDir, "mail.db"));
		const messages = mailStore.getAll({ to: "lead-1" });
		const workerDone = messages.find((m) => m.type === "worker_done");
		expect(workerDone).toBeDefined();
		expect(workerDone?.from).toBe("test-builder");
		expect(workerDone?.subject).toContain("Worker done: task-1");
		mailStore.close();

		deps.eventStore.close();
		deps.mailClient.close();
	});

	test("does NOT send worker_done mail when no parentAgent", async () => {
		const overstoryDir = await setupOverstoryDir();
		const config = makeTestConfig({ parentAgent: null, projectRoot: tempDir });
		const deps = await makeRealDeps(overstoryDir);

		await performShutdownBookkeeping(config, overstoryDir, deps);

		// Check no messages exist
		const mailStore = createMailStore(join(overstoryDir, "mail.db"));
		const allMessages = mailStore.getAll();
		expect(allMessages.length).toBe(0);
		mailStore.close();

		deps.eventStore.close();
		deps.mailClient.close();
	});

	test("writes auto-nudge marker when capability is 'lead'", async () => {
		const overstoryDir = await setupOverstoryDir();
		const config = makeTestConfig({
			capability: "lead",
			agentName: "test-lead",
			parentAgent: "coordinator",
			projectRoot: tempDir,
		});
		const deps = await makeRealDeps(overstoryDir);

		await performShutdownBookkeeping(config, overstoryDir, deps);

		const markerPath = join(overstoryDir, "pending-nudges", "coordinator.json");
		const markerFile = Bun.file(markerPath);
		expect(await markerFile.exists()).toBe(true);
		const marker = JSON.parse(await markerFile.text()) as Record<string, unknown>;
		expect(marker.from).toBe("test-lead");
		expect(marker.reason).toBe("lead_completed");

		deps.eventStore.close();
		deps.mailClient.close();
	});

	test("does NOT write nudge marker when capability is not 'lead'", async () => {
		const overstoryDir = await setupOverstoryDir();
		const config = makeTestConfig({ capability: "builder", projectRoot: tempDir });
		const deps = await makeRealDeps(overstoryDir);

		await performShutdownBookkeeping(config, overstoryDir, deps);

		const markerPath = join(overstoryDir, "pending-nudges", "coordinator.json");
		const markerFile = Bun.file(markerPath);
		expect(await markerFile.exists()).toBe(false);

		deps.eventStore.close();
		deps.mailClient.close();
	});

	test("completes run when capability is 'coordinator' and current-run.txt exists", async () => {
		const overstoryDir = await setupOverstoryDir();
		const config = makeTestConfig({
			capability: "coordinator",
			agentName: "coordinator",
			parentAgent: null,
			projectRoot: tempDir,
		});

		// Create a run in the store and write current-run.txt
		const runStore = createRunStore(join(overstoryDir, "sessions.db"));
		runStore.createRun({
			id: "run-test-1",
			startedAt: new Date().toISOString(),
			coordinatorSessionId: "sess-1",
			status: "active",
		});
		runStore.close();
		await Bun.write(join(overstoryDir, "current-run.txt"), "run-test-1\n");

		const deps = await makeRealDeps(overstoryDir);

		await performShutdownBookkeeping(config, overstoryDir, deps);

		// Verify run was completed
		const checkStore = createRunStore(join(overstoryDir, "sessions.db"));
		const run = checkStore.getRun("run-test-1");
		expect(run?.status).toBe("completed");
		expect(run?.completedAt).not.toBeNull();
		checkStore.close();

		// current-run.txt should be deleted
		const runFile = Bun.file(join(overstoryDir, "current-run.txt"));
		expect(await runFile.exists()).toBe(false);

		deps.eventStore.close();
		deps.mailClient.close();
	});

	test("does NOT complete run when capability is not 'coordinator'", async () => {
		const overstoryDir = await setupOverstoryDir();
		const config = makeTestConfig({ capability: "builder", projectRoot: tempDir });

		// Create a run and current-run.txt that should NOT be touched
		const runStore = createRunStore(join(overstoryDir, "sessions.db"));
		runStore.createRun({
			id: "run-untouched",
			startedAt: new Date().toISOString(),
			coordinatorSessionId: "sess-1",
			status: "active",
		});
		runStore.close();
		await Bun.write(join(overstoryDir, "current-run.txt"), "run-untouched\n");

		const deps = await makeRealDeps(overstoryDir);

		await performShutdownBookkeeping(config, overstoryDir, deps);

		// Run should still be active
		const checkStore = createRunStore(join(overstoryDir, "sessions.db"));
		const run = checkStore.getRun("run-untouched");
		expect(run?.status).toBe("active");
		checkStore.close();

		deps.eventStore.close();
		deps.mailClient.close();
	});

	test("each step is non-fatal: throwing eventStore does not prevent mail send", async () => {
		const overstoryDir = await setupOverstoryDir();
		const config = makeTestConfig({ parentAgent: "lead-1", projectRoot: tempDir });

		// Create a real mail client but a throwing event store
		const mailStore = createMailStore(join(overstoryDir, "mail.db"));
		const mailClient = createMailClient(mailStore);
		const { updateIdentity: realUpdateIdentity } = await import("../agents/identity");

		const throwingEventStore = {
			insert() {
				throw new Error("Event store broken");
			},
			correlateToolEnd() {
				return null;
			},
			getByAgent() {
				return [];
			},
			getByRun() {
				return [];
			},
			getErrors() {
				return [];
			},
			getTimeline() {
				return [];
			},
			getToolStats() {
				return [];
			},
			purge() {
				return 0;
			},
			close() {},
		} satisfies import("../types").EventStore;

		const deps: ShutdownDeps = {
			eventStore: throwingEventStore,
			mailClient,
			openSessionStore,
			updateIdentity: realUpdateIdentity,
			createRunStore,
		};

		// Should NOT throw even though eventStore.insert throws
		await performShutdownBookkeeping(config, overstoryDir, deps);

		// Mail should still have been sent despite event store failure
		const checkStore = createMailStore(join(overstoryDir, "mail.db"));
		const messages = checkStore.getAll({ to: "lead-1" });
		const workerDone = messages.find((m) => m.type === "worker_done");
		expect(workerDone).toBeDefined();
		checkStore.close();
		mailClient.close();
	});

	test("each step is non-fatal: throwing openSessionStore does not block identity update", async () => {
		const overstoryDir = await setupOverstoryDir();
		await createTestIdentity(overstoryDir);
		const config = makeTestConfig({ projectRoot: tempDir });
		const { updateIdentity: realUpdateIdentity } = await import("../agents/identity");

		const eventStore = createEventStore(join(overstoryDir, "events.db"));
		const mailStore = createMailStore(join(overstoryDir, "mail.db"));
		const mailClient = createMailClient(mailStore);

		const throwingOpenSessionStore = () => {
			throw new Error("Session store broken");
		};

		const deps: ShutdownDeps = {
			eventStore,
			mailClient,
			openSessionStore: throwingOpenSessionStore as unknown as typeof openSessionStore,
			updateIdentity: realUpdateIdentity,
			createRunStore,
		};

		await performShutdownBookkeeping(config, overstoryDir, deps);

		// Identity should still have been updated
		const { loadIdentity } = await import("../agents/identity");
		const identity = await loadIdentity(join(overstoryDir, "agents"), "test-builder");
		expect(identity?.sessionsCompleted).toBe(4);

		eventStore.close();
		mailClient.close();
	});

	test("calls runMulchLearn when provided", async () => {
		const overstoryDir = await setupOverstoryDir();
		const config = makeTestConfig({ projectRoot: tempDir });

		let mulchCalled = false;
		let mulchCwd = "";
		const deps = await makeRealDeps(overstoryDir, {
			runMulchLearn: async (cwd: string) => {
				mulchCalled = true;
				mulchCwd = cwd;
			},
		});

		await performShutdownBookkeeping(config, overstoryDir, deps);

		expect(mulchCalled).toBe(true);
		expect(mulchCwd).toBe("/tmp/test-worktree");

		deps.eventStore.close();
		deps.mailClient.close();
	});

	test("survives runMulchLearn throwing", async () => {
		const overstoryDir = await setupOverstoryDir();
		const config = makeTestConfig({ parentAgent: "lead-1", projectRoot: tempDir });

		const deps = await makeRealDeps(overstoryDir, {
			runMulchLearn: async () => {
				throw new Error("mulch not installed");
			},
		});

		// Should not throw
		await performShutdownBookkeeping(config, overstoryDir, deps);

		// Subsequent steps should still have run (mail sent)
		const checkStore = createMailStore(join(overstoryDir, "mail.db"));
		const messages = checkStore.getAll({ to: "lead-1" });
		expect(messages.length).toBeGreaterThan(0);
		checkStore.close();

		deps.eventStore.close();
		deps.mailClient.close();
	});

	// ---- Step 8: server auto-cleanup ----

	test("calls stopServer when this is the last codex agent", async () => {
		const overstoryDir = await setupOverstoryDir();
		// Create a codex session for the current agent (will be "completed" by step 2)
		createTestSession(overstoryDir);
		const config = makeTestConfig({ projectRoot: tempDir });

		let stopServerCalled = false;
		const deps = await makeRealDeps(overstoryDir, {
			stopServer: async () => {
				stopServerCalled = true;
				return true;
			},
		});

		await performShutdownBookkeeping(config, overstoryDir, deps);

		// No other codex agents — server should have been stopped
		expect(stopServerCalled).toBe(true);

		deps.eventStore.close();
		deps.mailClient.close();
	});

	test("does NOT call stopServer when another codex agent is still active", async () => {
		const overstoryDir = await setupOverstoryDir();
		// Create session for the current agent
		createTestSession(overstoryDir);

		// Create a second active codex session
		const store = createSessionStore(join(overstoryDir, "sessions.db"));
		store.upsert({
			id: "sess-other",
			agentName: "other-codex-agent",
			capability: "builder",
			worktreePath: "/tmp/other-worktree",
			branchName: "overstory/other-codex-agent/task-2",
			beadId: "task-2",
			tmuxSession: "overstory-test-fake",
			state: "working",
			pid: null,
			parentAgent: "lead-1",
			depth: 2,
			runId: "run-1",
			startedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
			runtime: "codex",
		});
		store.close();

		const config = makeTestConfig({ projectRoot: tempDir });

		let stopServerCalled = false;
		const deps = await makeRealDeps(overstoryDir, {
			stopServer: async () => {
				stopServerCalled = true;
				return true;
			},
		});

		await performShutdownBookkeeping(config, overstoryDir, deps);

		// Another codex agent is still active — server should NOT be stopped
		expect(stopServerCalled).toBe(false);

		deps.eventStore.close();
		deps.mailClient.close();
	});

	test("does NOT call stopServer when stopServer is not provided", async () => {
		const overstoryDir = await setupOverstoryDir();
		createTestSession(overstoryDir);
		const config = makeTestConfig({ projectRoot: tempDir });

		// No stopServer in deps
		const deps = await makeRealDeps(overstoryDir);

		// Should not throw and should complete normally
		await performShutdownBookkeeping(config, overstoryDir, deps);

		deps.eventStore.close();
		deps.mailClient.close();
	});

	test("step 8 is non-fatal: stopServer throwing does not block shutdown", async () => {
		const overstoryDir = await setupOverstoryDir();
		const config = makeTestConfig({ parentAgent: "lead-1", projectRoot: tempDir });

		const deps = await makeRealDeps(overstoryDir, {
			stopServer: async () => {
				throw new Error("server stop failed");
			},
		});

		// Should not throw
		await performShutdownBookkeeping(config, overstoryDir, deps);

		// Previous steps still ran (mail sent to parent)
		const checkStore = createMailStore(join(overstoryDir, "mail.db"));
		const messages = checkStore.getAll({ to: "lead-1" });
		const workerDone = messages.find((m) => m.type === "worker_done");
		expect(workerDone).toBeDefined();
		checkStore.close();

		deps.eventStore.close();
		deps.mailClient.close();
	});
});

// ========================================
// shouldAttemptReconnect
// ========================================

describe("shouldAttemptReconnect", () => {
	test("returns true when attempt is within limit and shutdown not requested", () => {
		expect(shouldAttemptReconnect(false, 1, 3)).toBe(true);
		expect(shouldAttemptReconnect(false, 2, 3)).toBe(true);
		expect(shouldAttemptReconnect(false, 3, 3)).toBe(true); // at limit
	});

	test("returns false when attempt exceeds max", () => {
		expect(shouldAttemptReconnect(false, 4, 3)).toBe(false);
		expect(shouldAttemptReconnect(false, 10, 3)).toBe(false);
	});

	test("returns false when shutdownRequested is true regardless of attempt", () => {
		expect(shouldAttemptReconnect(true, 1, 3)).toBe(false);
		expect(shouldAttemptReconnect(true, 0, 10)).toBe(false);
	});

	test("returns false when maxAttempts is 0 and attempt is 1", () => {
		expect(shouldAttemptReconnect(false, 1, 0)).toBe(false);
	});

	test("returns true for attempt 0 with any maxAttempts >= 0", () => {
		// attempt=0 means still on the first connect, always within limit
		expect(shouldAttemptReconnect(false, 0, 0)).toBe(true);
		expect(shouldAttemptReconnect(false, 0, 3)).toBe(true);
	});

	test("works with maxAttempts=1: allows exactly one reconnect", () => {
		expect(shouldAttemptReconnect(false, 1, 1)).toBe(true); // first reconnect allowed
		expect(shouldAttemptReconnect(false, 2, 1)).toBe(false); // second blocked
	});
});

// ========================================
// buildReconnectPrompt
// ========================================

describe("buildReconnectPrompt", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "bridge-reconnect-prompt-test-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("includes OVERSTORY RECONNECT header with agent name and task", async () => {
		const config = makeTestConfig({ projectRoot: tempDir });
		const overstoryDir = join(tempDir, ".overstory");
		const { mkdir } = await import("node:fs/promises");
		await mkdir(overstoryDir, { recursive: true });

		const prompt = await buildReconnectPrompt(config, overstoryDir, "");

		expect(prompt).toContain("[OVERSTORY RECONNECT] test-builder (builder)");
		expect(prompt).toContain("task:task-1");
		expect(prompt).toContain("Codex App Server was restarted");
	});

	test("includes checkpoint data when checkpoint exists", async () => {
		const config = makeTestConfig({ projectRoot: tempDir });
		const overstoryDir = join(tempDir, ".overstory");
		const agentsDir = join(overstoryDir, "agents");
		const { mkdir } = await import("node:fs/promises");
		await mkdir(agentsDir, { recursive: true });

		await saveCheckpoint(agentsDir, {
			agentName: "test-builder",
			beadId: "task-1",
			sessionId: "sess-old",
			timestamp: new Date().toISOString(),
			progressSummary: "Halfway through the implementation",
			filesModified: ["src/foo.ts"],
			currentBranch: "overstory/test-builder/task-1",
			pendingWork: "Write tests",
			mulchDomains: [],
		});

		const prompt = await buildReconnectPrompt(config, overstoryDir, "");

		expect(prompt).toContain("## Session Recovery");
		expect(prompt).toContain("Halfway through the implementation");
		expect(prompt).toContain("src/foo.ts");
		expect(prompt).toContain("Write tests");
	});

	test("falls back to prevProgressSummary when no checkpoint", async () => {
		const config = makeTestConfig({ projectRoot: tempDir });
		const overstoryDir = join(tempDir, ".overstory");
		const { mkdir } = await import("node:fs/promises");
		await mkdir(overstoryDir, { recursive: true });

		const prompt = await buildReconnectPrompt(config, overstoryDir, "Last wrote src/foo.ts");

		expect(prompt).toContain("Last wrote src/foo.ts");
		expect(prompt).toContain("Continue working on task task-1");
	});

	test("falls back to minimal resume prompt when no checkpoint and no progress summary", async () => {
		const config = makeTestConfig({ projectRoot: tempDir });
		const overstoryDir = join(tempDir, ".overstory");
		const { mkdir } = await import("node:fs/promises");
		await mkdir(overstoryDir, { recursive: true });

		const prompt = await buildReconnectPrompt(config, overstoryDir, "");

		expect(prompt).toContain("Resume task task-1");
		expect(prompt).toContain("continue from where you left off");
	});

	test("includes pending mail accumulated during disconnect", async () => {
		const config = makeTestConfig({ projectRoot: tempDir });
		const overstoryDir = join(tempDir, ".overstory");
		const { mkdir } = await import("node:fs/promises");
		await mkdir(overstoryDir, { recursive: true });

		const mailStore = createMailStore(join(overstoryDir, "mail.db"));
		const tempMail = createMailClient(mailStore);
		tempMail.send({
			from: "lead-1",
			to: "test-builder",
			subject: "Reconnect instructions",
			body: "Continue the implementation",
			type: "status",
			priority: "normal",
		});
		tempMail.close();

		const prompt = await buildReconnectPrompt(config, overstoryDir, "");

		expect(prompt).toContain("## Pending Messages");
		expect(prompt).toContain("[lead-1] Reconnect instructions");
	});

	test("omits mail section when no pending messages", async () => {
		const config = makeTestConfig({ projectRoot: tempDir });
		const overstoryDir = join(tempDir, ".overstory");
		const { mkdir } = await import("node:fs/promises");
		await mkdir(overstoryDir, { recursive: true });

		const prompt = await buildReconnectPrompt(config, overstoryDir, "");

		expect(prompt).not.toContain("Pending Messages");
	});

	test("checkpoint takes precedence over prevProgressSummary", async () => {
		const config = makeTestConfig({ projectRoot: tempDir });
		const overstoryDir = join(tempDir, ".overstory");
		const agentsDir = join(overstoryDir, "agents");
		const { mkdir } = await import("node:fs/promises");
		await mkdir(agentsDir, { recursive: true });

		await saveCheckpoint(agentsDir, {
			agentName: "test-builder",
			beadId: "task-1",
			sessionId: "sess-old",
			timestamp: new Date().toISOString(),
			progressSummary: "From checkpoint",
			filesModified: [],
			currentBranch: "overstory/test-builder/task-1",
			pendingWork: "Checkpoint work",
			mulchDomains: [],
		});

		const prompt = await buildReconnectPrompt(config, overstoryDir, "From prevProgress");

		// Checkpoint should win
		expect(prompt).toContain("From checkpoint");
		expect(prompt).toContain("## Session Recovery");
		// prevProgressSummary fallback should NOT appear
		expect(prompt).not.toContain("From prevProgress");
	});
});
