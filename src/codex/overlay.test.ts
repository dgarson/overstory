import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OverlayConfig } from "../types";
import { generateAgentsOverlay, writeAgentsOverlay } from "./overlay";

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

describe("writeAgentsOverlay", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		for (const dir of tempDirs) {
			await rm(dir, { recursive: true, force: true });
		}
		tempDirs.length = 0;
	});

	async function makeTempDir(): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), "overlay-test-"));
		tempDirs.push(dir);
		return dir;
	}

	function makeConfig(worktreePath: string): OverlayConfig {
		return {
			agentName: "test-builder",
			beadId: "task-456",
			specPath: "/repo/.overstory/specs/task-456.md",
			branchName: "overstory/test-builder/task-456",
			worktreePath,
			fileScope: ["src/alpha.ts", "src/beta.ts"],
			mulchDomains: ["cli"],
			parentAgent: "lead-1",
			depth: 2,
			canSpawn: false,
			capability: "builder",
			baseDefinition: "# Builder Agent\n\nYou are a builder.",
		};
	}

	test("writes AGENTS.md to worktree root", async () => {
		const worktreeDir = await makeTempDir();
		const canonicalRoot = await makeTempDir();
		const config = makeConfig(worktreeDir);

		await writeAgentsOverlay(worktreeDir, config, canonicalRoot);

		const overlayPath = join(worktreeDir, "AGENTS.md");
		const content = await readFile(overlayPath, "utf-8");

		expect(content).toContain("test-builder");
		expect(content).toContain("task-456");
	});

	test("rejects write when worktree path equals canonical root", async () => {
		const sharedDir = await makeTempDir();
		const config = makeConfig(sharedDir);

		await expect(writeAgentsOverlay(sharedDir, config, sharedDir)).rejects.toThrow(
			"Cannot write AGENTS.md overlay to canonical root",
		);
	});

	test("writes correct content with key sections", async () => {
		const worktreeDir = await makeTempDir();
		const canonicalRoot = await makeTempDir();
		const config = makeConfig(worktreeDir);

		await writeAgentsOverlay(worktreeDir, config, canonicalRoot);

		const overlayPath = join(worktreeDir, "AGENTS.md");
		const content = await readFile(overlayPath, "utf-8");

		// Key overlay sections
		expect(content).toContain("test-builder");
		expect(content).toContain("builder");
		expect(content).toContain("src/alpha.ts");
		expect(content).toContain("src/beta.ts");
		expect(content).toContain("/repo/.overstory/specs/task-456.md");

		// Must not reference Claude-specific paths
		expect(content).not.toContain(".claude/CLAUDE.md");
		expect(content).not.toContain("--dangerously-skip-permissions");
	});
});
