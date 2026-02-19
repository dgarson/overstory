import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { BUNDLED_AGENT_DEFS } from "../agents/bundled-defs.ts";
import { cleanupTempDir, createTempGitRepo } from "../test-helpers.ts";
import { AGENT_DEF_FILES, initCommand, OVERSTORY_GITIGNORE } from "./init.ts";

/**
 * Tests for `overstory init` -- agent definition deployment.
 *
 * Uses real temp git repos. Suppresses stdout to keep test output clean.
 * process.cwd() is saved/restored because initCommand uses it to find the project root.
 */

describe("initCommand: agent-defs deployment", () => {
	let tempDir: string;
	let originalCwd: string;
	let originalWrite: typeof process.stdout.write;

	beforeEach(async () => {
		tempDir = await createTempGitRepo();
		originalCwd = process.cwd();
		process.chdir(tempDir);

		// Suppress stdout noise from initCommand
		originalWrite = process.stdout.write;
		process.stdout.write = (() => true) as typeof process.stdout.write;
	});

	afterEach(async () => {
		process.chdir(originalCwd);
		process.stdout.write = originalWrite;
		await cleanupTempDir(tempDir);
	});

	test("creates .overstory/agent-defs/ with all 8 agent definition files", async () => {
		await initCommand([]);

		const agentDefsDir = join(tempDir, ".overstory", "agent-defs");
		const files = await readdir(agentDefsDir);
		const mdFiles = files.filter((f) => f.endsWith(".md")).sort();

		expect(mdFiles).toEqual(AGENT_DEF_FILES.slice().sort());
	});

	test("copied files match source content", async () => {
		await initCommand([]);

		for (const fileName of AGENT_DEF_FILES) {
			const sourceContent = BUNDLED_AGENT_DEFS[fileName] ?? "";
			const targetContent = await Bun.file(
				join(tempDir, ".overstory", "agent-defs", fileName),
			).text();
			expect(targetContent).toBe(sourceContent);
		}
	});

	test("--force reinit overwrites existing agent def files", async () => {
		// First init
		await initCommand([]);

		// Tamper with one of the deployed files
		const tamperPath = join(tempDir, ".overstory", "agent-defs", "scout.md");
		await Bun.write(tamperPath, "# tampered content\n");

		// Verify tamper worked
		const tampered = await Bun.file(tamperPath).text();
		expect(tampered).toBe("# tampered content\n");

		// Reinit with --force
		await initCommand(["--force"]);

		// Verify the file was overwritten with the original source
		const sourceContent = BUNDLED_AGENT_DEFS["scout.md"] ?? "";
		const restored = await Bun.file(tamperPath).text();
		expect(restored).toBe(sourceContent);
	});

	test("Stop hook includes mulch learn command", async () => {
		await initCommand([]);

		const hooksPath = join(tempDir, ".overstory", "hooks.json");
		const content = await Bun.file(hooksPath).text();
		const parsed = JSON.parse(content);
		const stopHooks = parsed.hooks.Stop[0].hooks;

		expect(stopHooks.length).toBe(2);
		expect(stopHooks[0].command).toContain("overstory log session-end");
		expect(stopHooks[1].command).toBe("mulch learn");
	});
});

describe("initCommand: .overstory/.gitignore", () => {
	let tempDir: string;
	let originalCwd: string;
	let originalWrite: typeof process.stdout.write;

	beforeEach(async () => {
		tempDir = await createTempGitRepo();
		originalCwd = process.cwd();
		process.chdir(tempDir);

		// Suppress stdout noise from initCommand
		originalWrite = process.stdout.write;
		process.stdout.write = (() => true) as typeof process.stdout.write;
	});

	afterEach(async () => {
		process.chdir(originalCwd);
		process.stdout.write = originalWrite;
		await cleanupTempDir(tempDir);
	});

	test("creates .overstory/.gitignore with wildcard+whitelist model", async () => {
		await initCommand([]);

		const gitignorePath = join(tempDir, ".overstory", ".gitignore");
		const content = await Bun.file(gitignorePath).text();

		// Verify wildcard+whitelist pattern
		expect(content).toContain("*\n");
		expect(content).toContain("!.gitignore\n");
		expect(content).toContain("!config.yaml\n");
		expect(content).toContain("!agent-manifest.json\n");
		expect(content).toContain("!hooks.json\n");
		expect(content).toContain("!groups.json\n");
		expect(content).toContain("!agent-defs/\n");

		// Verify it matches the exported constant
		expect(content).toBe(OVERSTORY_GITIGNORE);
	});

	test("gitignore is always written when init completes", async () => {
		// Init should write gitignore
		await initCommand([]);

		const gitignorePath = join(tempDir, ".overstory", ".gitignore");
		const content = await Bun.file(gitignorePath).text();

		// Verify gitignore was written with correct content
		expect(content).toBe(OVERSTORY_GITIGNORE);

		// Verify the file exists
		const exists = await Bun.file(gitignorePath).exists();
		expect(exists).toBe(true);
	});

	test("--force reinit overwrites stale .overstory/.gitignore", async () => {
		// First init
		await initCommand([]);

		const gitignorePath = join(tempDir, ".overstory", ".gitignore");

		// Tamper with the gitignore file (simulate old deny-list format)
		await Bun.write(gitignorePath, "# old format\nworktrees/\nlogs/\nmail.db\n");

		// Verify tamper worked
		const tampered = await Bun.file(gitignorePath).text();
		expect(tampered).not.toContain("*\n");
		expect(tampered).not.toContain("!.gitignore\n");

		// Reinit with --force
		await initCommand(["--force"]);

		// Verify the file was overwritten with the new wildcard+whitelist format
		const restored = await Bun.file(gitignorePath).text();
		expect(restored).toBe(OVERSTORY_GITIGNORE);
		expect(restored).toContain("*\n");
		expect(restored).toContain("!.gitignore\n");
	});

	test("subsequent init without --force does not overwrite gitignore", async () => {
		// First init
		await initCommand([]);

		const gitignorePath = join(tempDir, ".overstory", ".gitignore");

		// Tamper with the gitignore file
		await Bun.write(gitignorePath, "# custom content\n");

		// Verify tamper worked
		const tampered = await Bun.file(gitignorePath).text();
		expect(tampered).toBe("# custom content\n");

		// Second init without --force should return early (not overwrite)
		await initCommand([]);

		// Verify the file was NOT overwritten (early return prevented it)
		const afterSecondInit = await Bun.file(gitignorePath).text();
		expect(afterSecondInit).toBe("# custom content\n");
	});
});
