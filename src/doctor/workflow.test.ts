/**
 * Tests for workflow doctor checks.
 *
 * Uses real SQLite databases and temp directories.
 * No mocks required — all operations are local.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OverstoryConfig } from "../types.ts";
import type { DoctorCheck } from "./types.ts";
import { checkWorkflow } from "./workflow.ts";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeConfig(mcpEnabled: boolean, root: string): OverstoryConfig {
	return {
		project: { name: "test-project", root, canonicalBranch: "main" },
		agents: {
			manifestPath: ".overstory/agent-manifest.json",
			baseDir: ".overstory/agent-defs",
			maxConcurrent: 5,
			staggerDelayMs: 1000,
			maxDepth: 2,
		},
		worktrees: { baseDir: ".overstory/worktrees" },
		beads: { enabled: true },
		mulch: { enabled: false, domains: [], primeFormat: "markdown" },
		merge: { aiResolveEnabled: false, reimagineEnabled: false },
		watchdog: {
			tier0Enabled: false,
			tier0IntervalMs: 30000,
			tier1Enabled: false,
			tier2Enabled: false,
			staleThresholdMs: 300000,
			zombieThresholdMs: 600000,
			nudgeIntervalMs: 60000,
		},
		models: {},
		logging: { verbose: false, redactSecrets: true },
		codex: {
			enabled: false,
			defaultRuntime: {},
			serverPort: 21816,
			model: "codex-mini-latest",
			compactionThreshold: 0.8,
			maxDeltaBufferBytes: 1_048_576,
			approvalTimeoutMs: 60_000,
		},
		mcp: {
			enabled: mcpEnabled,
			port: 21817,
			coordinatorIntervalMs: 5_000,
			idleThresholdMs: 60_000,
			awaitWorkMaxMs: 300_000,
		},
		tickets: { provider: "beads" },
	};
}

function createWorkflowDb(dbPath: string): void {
	const db = new Database(dbPath);
	db.exec("PRAGMA journal_mode=WAL");
	db.exec(`
		CREATE TABLE IF NOT EXISTS workflow_tasks (
			id TEXT NOT NULL,
			project_id TEXT NOT NULL,
			current_state TEXT NOT NULL DEFAULT 'created',
			assigned_agent TEXT,
			branch_name TEXT,
			review_cycle_count INTEGER NOT NULL DEFAULT 0,
			ticket_id TEXT,
			ticket_provider TEXT NOT NULL DEFAULT 'beads',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (id, project_id)
		)
	`);
	db.exec(`
		CREATE TABLE IF NOT EXISTS workflow_transitions (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			task_id TEXT NOT NULL,
			project_id TEXT NOT NULL,
			from_state TEXT NOT NULL,
			to_state TEXT NOT NULL,
			signal TEXT NOT NULL,
			triggered_by TEXT NOT NULL,
			role TEXT NOT NULL,
			metadata TEXT,
			created_at TEXT NOT NULL
		)
	`);
	db.close();
}

// ─── fixtures ───────────────────────────────────────────────────────────────

let tempDir: string;
let overstoryDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "workflow-doctor-test-"));
	overstoryDir = join(tempDir, ".overstory");
	await mkdir(overstoryDir, { recursive: true });
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

// ─── tests ──────────────────────────────────────────────────────────────────

describe("checkWorkflow — MCP disabled", () => {
	test("returns a single pass check when MCP is disabled", async () => {
		const config = makeConfig(false, tempDir);
		const checks = await checkWorkflow(config, overstoryDir);
		expect(checks).toHaveLength(1);
		expect(checks[0]?.name).toBe("workflow-mcp-disabled");
		expect(checks[0]?.status).toBe("pass");
	});
});

describe("checkWorkflow — no workflow.db", () => {
	test("returns a warn when workflow.db is missing but MCP enabled", async () => {
		const config = makeConfig(true, tempDir);
		const checks = await checkWorkflow(config, overstoryDir);
		const dbCheck = checks.find((c: DoctorCheck) => c.name === "workflow-db-exists");
		expect(dbCheck).toBeDefined();
		expect(dbCheck?.status).toBe("warn");
		expect(dbCheck?.message).toContain("not found");
	});
});

describe("checkWorkflow — valid workflow.db", () => {
	test("passes all checks on empty valid db", async () => {
		const dbPath = join(overstoryDir, "workflow.db");
		createWorkflowDb(dbPath);

		const config = makeConfig(true, tempDir);
		const checks = await checkWorkflow(config, overstoryDir);

		const dbCheck = checks.find((c: DoctorCheck) => c.name === "workflow-db-exists");
		const schemaCheck = checks.find((c: DoctorCheck) => c.name === "workflow-db-schema");

		expect(dbCheck?.status).toBe("pass");
		expect(schemaCheck?.status).toBe("pass");
	});

	test("passes revision-cycles check when all tasks are within limit", async () => {
		const dbPath = join(overstoryDir, "workflow.db");
		createWorkflowDb(dbPath);

		const db = new Database(dbPath);
		const now = new Date().toISOString();
		db.run("INSERT INTO workflow_tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
			"task-1",
			"test-project",
			"building",
			"builder-1",
			null,
			2,
			null,
			"beads",
			now,
			now,
		]);
		db.close();

		const config = makeConfig(true, tempDir);
		const checks = await checkWorkflow(config, overstoryDir);

		const cycleCheck = checks.find((c: DoctorCheck) => c.name === "workflow-revision-cycles");
		expect(cycleCheck?.status).toBe("pass");
	});

	test("warns when task exceeds 3 revision cycles", async () => {
		const dbPath = join(overstoryDir, "workflow.db");
		createWorkflowDb(dbPath);

		const db = new Database(dbPath);
		const now = new Date().toISOString();
		db.run("INSERT INTO workflow_tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
			"task-overflow",
			"test-project",
			"building",
			"builder-1",
			null,
			5,
			null,
			"beads",
			now,
			now,
		]);
		db.close();

		const config = makeConfig(true, tempDir);
		const checks = await checkWorkflow(config, overstoryDir);

		const cycleCheck = checks.find((c: DoctorCheck) => c.name === "workflow-revision-cycles");
		expect(cycleCheck?.status).toBe("warn");
		expect(cycleCheck?.message).toContain("exceed");
		expect(cycleCheck?.details?.[0]).toContain("task-overflow");
	});

	test("passes stuck-tasks check when tasks are recently updated", async () => {
		const dbPath = join(overstoryDir, "workflow.db");
		createWorkflowDb(dbPath);

		const db = new Database(dbPath);
		const now = new Date().toISOString();
		db.run("INSERT INTO workflow_tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
			"task-fresh",
			"test-project",
			"building",
			"builder-1",
			null,
			0,
			null,
			"beads",
			now,
			now,
		]);
		db.close();

		const config = makeConfig(true, tempDir);
		const checks = await checkWorkflow(config, overstoryDir);

		const stuckCheck = checks.find((c: DoctorCheck) => c.name === "workflow-stuck-tasks");
		expect(stuckCheck?.status).toBe("pass");
	});

	test("warns when task is stuck for 2+ hours", async () => {
		const dbPath = join(overstoryDir, "workflow.db");
		createWorkflowDb(dbPath);

		const db = new Database(dbPath);
		// 3 hours ago
		const oldTime = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
		db.run("INSERT INTO workflow_tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
			"task-stuck",
			"test-project",
			"review_needed",
			"builder-1",
			null,
			0,
			null,
			"beads",
			oldTime,
			oldTime,
		]);
		db.close();

		const config = makeConfig(true, tempDir);
		const checks = await checkWorkflow(config, overstoryDir);

		const stuckCheck = checks.find((c: DoctorCheck) => c.name === "workflow-stuck-tasks");
		expect(stuckCheck?.status).toBe("warn");
		expect(stuckCheck?.message).toContain("stuck");
		expect(stuckCheck?.details?.[0]).toContain("task-stuck");
	});

	test("does not flag completed tasks as stuck", async () => {
		const dbPath = join(overstoryDir, "workflow.db");
		createWorkflowDb(dbPath);

		const db = new Database(dbPath);
		// Old, but completed — should not be flagged
		const oldTime = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
		db.run("INSERT INTO workflow_tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
			"task-done",
			"test-project",
			"completed",
			"builder-1",
			null,
			0,
			null,
			"beads",
			oldTime,
			oldTime,
		]);
		db.close();

		const config = makeConfig(true, tempDir);
		const checks = await checkWorkflow(config, overstoryDir);

		const stuckCheck = checks.find((c: DoctorCheck) => c.name === "workflow-stuck-tasks");
		expect(stuckCheck?.status).toBe("pass");
	});
});

describe("checkWorkflow — corrupt db schema", () => {
	test("fails schema check when tables are missing", async () => {
		// Create a db with no tables matching the required schema
		const dbPath = join(overstoryDir, "workflow.db");
		const db = new Database(dbPath);
		db.exec("CREATE TABLE dummy (x INT)");
		db.close();

		const config = makeConfig(true, tempDir);
		const checks = await checkWorkflow(config, overstoryDir);

		const schemaCheck = checks.find((c: DoctorCheck) => c.name === "workflow-db-schema");
		expect(schemaCheck?.status).toBe("fail");
		expect(schemaCheck?.details?.some((d: string) => d.includes("workflow_tasks"))).toBe(true);
	});
});
