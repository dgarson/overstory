import { Database } from "bun:sqlite";
import { join } from "node:path";
import type { DoctorCheck, DoctorCheckFn } from "./types.ts";

/**
 * Workflow state machine health checks.
 *
 * Validates that workflow.db exists (when MCP is enabled), has the correct
 * schema, and detects tasks stuck in non-terminal states with excessive
 * revision cycle counts.
 */
export const checkWorkflow: DoctorCheckFn = (config, overstoryDir): DoctorCheck[] => {
	const checks: DoctorCheck[] = [];

	// If MCP is disabled, skip all workflow checks
	if (!config.mcp.enabled) {
		checks.push({
			name: "workflow-mcp-disabled",
			category: "workflow",
			status: "pass",
			message: "MCP disabled — workflow checks skipped",
		});
		return checks;
	}

	const dbPath = join(overstoryDir, "workflow.db");

	// Check 1: workflow.db exists — try to open read-only, fail gracefully if missing
	let db: Database | null = null;
	try {
		db = new Database(dbPath, { readonly: true, create: false });
	} catch {
		checks.push({
			name: "workflow-db-exists",
			category: "workflow",
			status: "warn",
			message: "workflow.db not found — MCP server may not have started yet",
			details: [`Expected at: ${dbPath}`, "Run 'overstory mcp start' to create the database"],
			fixable: true,
		});
		return checks;
	}

	checks.push({
		name: "workflow-db-exists",
		category: "workflow",
		status: "pass",
		message: "workflow.db exists",
	});

	// Check 2: required tables present
	try {
		const tables = db
			.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
			.all();
		const tableNames = new Set(tables.map((r) => r.name));

		const requiredTables = ["workflow_tasks", "workflow_transitions"];
		const missingTables = requiredTables.filter((t) => !tableNames.has(t));

		if (missingTables.length > 0) {
			checks.push({
				name: "workflow-db-schema",
				category: "workflow",
				status: "fail",
				message: "workflow.db is missing required tables",
				details: missingTables.map((t) => `Missing table: ${t}`),
			});
		} else {
			checks.push({
				name: "workflow-db-schema",
				category: "workflow",
				status: "pass",
				message: "workflow.db schema is valid",
			});
		}
	} catch (err) {
		checks.push({
			name: "workflow-db-schema",
			category: "workflow",
			status: "fail",
			message: "Cannot query workflow.db schema",
			details: [err instanceof Error ? err.message : String(err)],
		});
		db.close();
		return checks;
	}

	// Check 3: tasks with excessive revision cycles (> 3 is the configured max)
	const MAX_REVISION_CYCLES = 3;
	try {
		const overLimit = db
			.query<{ id: string; project_id: string; review_cycle_count: number }, [number]>(
				`SELECT id, project_id, review_cycle_count
				FROM workflow_tasks
				WHERE review_cycle_count > ?
				AND current_state NOT IN ('completed', 'cancelled')`,
			)
			.all(MAX_REVISION_CYCLES);

		if (overLimit.length > 0) {
			checks.push({
				name: "workflow-revision-cycles",
				category: "workflow",
				status: "warn",
				message: `${overLimit.length} task(s) exceed max revision cycles (${MAX_REVISION_CYCLES})`,
				details: overLimit.map(
					(t) => `Task ${t.id} (project: ${t.project_id}): ${t.review_cycle_count} cycles`,
				),
			});
		} else {
			checks.push({
				name: "workflow-revision-cycles",
				category: "workflow",
				status: "pass",
				message: "No tasks exceed revision cycle limit",
			});
		}
	} catch {
		// Non-critical — table may not exist yet
	}

	// Check 4: stuck tasks (non-terminal state, no transition in > 2 hours)
	const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
	const stuckThreshold = new Date(Date.now() - TWO_HOURS_MS).toISOString();
	try {
		const stuck = db
			.query<
				{ id: string; project_id: string; current_state: string; updated_at: string },
				[string]
			>(
				`SELECT id, project_id, current_state, updated_at
				FROM workflow_tasks
				WHERE current_state NOT IN ('completed', 'cancelled')
				AND updated_at < ?`,
			)
			.all(stuckThreshold);

		if (stuck.length > 0) {
			checks.push({
				name: "workflow-stuck-tasks",
				category: "workflow",
				status: "warn",
				message: `${stuck.length} task(s) appear stuck (no progress in 2+ hours)`,
				details: stuck.map(
					(t) =>
						`Task ${t.id} (project: ${t.project_id}): state=${t.current_state}, last updated ${t.updated_at}`,
				),
			});
		} else {
			checks.push({
				name: "workflow-stuck-tasks",
				category: "workflow",
				status: "pass",
				message: "No stuck tasks detected",
			});
		}
	} catch {
		// Non-critical — table may not exist yet
	}

	db.close();
	return checks;
};
