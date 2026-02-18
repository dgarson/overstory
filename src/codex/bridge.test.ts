// src/codex/bridge.test.ts
import { describe, test, expect } from "bun:test";
import { parseBridgeConfig, shouldShutdown } from "./bridge";

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
