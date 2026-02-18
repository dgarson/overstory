// src/codex/approval.test.ts
import { describe, test, expect } from "bun:test";
import { evaluateCommandApproval, evaluateFileChangeApproval } from "./approval";

describe("evaluateCommandApproval", () => {
	const builderCtx = {
		capability: "builder",
		agentName: "builder-1",
		worktreePath: "/repo/.overstory/worktrees/builder-1",
		fileScope: ["src/foo.ts", "src/bar.ts"],
	};

	const scoutCtx = {
		capability: "scout",
		agentName: "scout-1",
		worktreePath: "/repo/.overstory/worktrees/scout-1",
		fileScope: [],
	};

	test("auto-approves safe prefixes", () => {
		const result = evaluateCommandApproval("overstory mail check --agent test", builderCtx);
		expect(result.decision).toBe("accept");
	});

	test("auto-approves bun test", () => {
		const result = evaluateCommandApproval("bun test src/foo.test.ts", builderCtx);
		expect(result.decision).toBe("accept");
	});

	test("declines git push", () => {
		const result = evaluateCommandApproval("git push origin main", builderCtx);
		expect(result.decision).toBe("decline");
		expect(result.reason).toContain("push");
	});

	test("declines git reset --hard", () => {
		const result = evaluateCommandApproval("git reset --hard HEAD~1", builderCtx);
		expect(result.decision).toBe("decline");
	});

	test("declines file-modifying bash for scout", () => {
		const result = evaluateCommandApproval("sed -i 's/foo/bar/' file.txt", scoutCtx);
		expect(result.decision).toBe("decline");
		expect(result.reason).toContain("scout");
	});

	test("allows overstory spec write for scout", () => {
		const result = evaluateCommandApproval("overstory spec write task-123 --body 'test'", scoutCtx);
		expect(result.decision).toBe("accept");
	});

	test("allows git add/commit for coordinator", () => {
		const coordCtx = { ...scoutCtx, capability: "coordinator" };
		expect(evaluateCommandApproval("git add .beads/", coordCtx).decision).toBe("accept");
		expect(evaluateCommandApproval("git commit -m 'sync'", coordCtx).decision).toBe("accept");
	});

	test("returns escalate for unknown commands", () => {
		const result = evaluateCommandApproval("curl https://example.com", builderCtx);
		expect(result.decision).toBe("escalate");
	});
});

describe("evaluateFileChangeApproval", () => {
	const builderCtx = {
		capability: "builder",
		agentName: "builder-1",
		worktreePath: "/repo/.overstory/worktrees/builder-1",
		fileScope: ["src/foo.ts", "src/bar.ts"],
	};

	test("approves file change within scope", () => {
		const result = evaluateFileChangeApproval(
			[{ path: "/repo/.overstory/worktrees/builder-1/src/foo.ts", kind: "update" }],
			builderCtx,
		);
		expect(result.decision).toBe("accept");
	});

	test("declines file change outside worktree", () => {
		const result = evaluateFileChangeApproval(
			[{ path: "/repo/src/foo.ts", kind: "update" }],
			builderCtx,
		);
		expect(result.decision).toBe("decline");
	});

	test("declines all file changes for non-implementation capability", () => {
		const scoutCtx = { ...builderCtx, capability: "scout" };
		const result = evaluateFileChangeApproval(
			[{ path: "/repo/.overstory/worktrees/builder-1/src/foo.ts", kind: "update" }],
			scoutCtx,
		);
		expect(result.decision).toBe("decline");
	});

	test("escalates file change within worktree but outside scope", () => {
		const result = evaluateFileChangeApproval(
			[{ path: "/repo/.overstory/worktrees/builder-1/src/other.ts", kind: "add" }],
			builderCtx,
		);
		expect(result.decision).toBe("escalate");
	});
});
