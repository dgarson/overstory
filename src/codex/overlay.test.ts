import { describe, test, expect } from "bun:test";
import { generateAgentsOverlay } from "./overlay";
import type { OverlayConfig } from "../types";

const baseConfig: OverlayConfig = {
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

test("generates AGENTS.md with agent name", async () => {
	const content = await generateAgentsOverlay(baseConfig);
	expect(content).toContain("builder-1");
	expect(content).toContain("task-123");
	expect(content).toContain("src/foo.ts");
});

test("does not reference CLAUDE.md or Claude Code tools", async () => {
	const content = await generateAgentsOverlay(baseConfig);
	expect(content).not.toContain(".claude/CLAUDE.md");
	expect(content).not.toContain("--dangerously-skip-permissions");
});

test("includes worktree path in constraints", async () => {
	const content = await generateAgentsOverlay(baseConfig);
	expect(content).toContain("/repo/.overstory/worktrees/builder-1");
});
