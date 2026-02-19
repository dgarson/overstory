/**
 * SQLite-backed workflow store for task state tracking.
 *
 * Uses bun:sqlite with WAL mode for concurrent access from multiple agents.
 * Composite PK (id, project_id) enables cross-project support.
 */

import { Database } from "bun:sqlite";
import type {
	WorkflowRole,
	WorkflowSignal,
	WorkflowState,
	WorkflowTask,
	WorkflowTransition,
} from "../types.ts";

/** Options for querying workflow tasks. */
export interface WorkflowTaskQuery {
	projectId: string;
	state?: WorkflowState;
	assignedAgent?: string;
	limit?: number;
}

/** Input for creating a new workflow task. */
export interface CreateWorkflowTask {
	id: string;
	projectId: string;
	ticketId?: string;
	ticketProvider?: string;
}

/** Input for recording a state transition. */
export interface RecordTransition {
	taskId: string;
	projectId: string;
	fromState: WorkflowState;
	toState: WorkflowState;
	signal: WorkflowSignal;
	triggeredBy: string;
	role: string;
	metadata?: Record<string, unknown>;
}

export interface WorkflowStore {
	createTask(input: CreateWorkflowTask): WorkflowTask;
	getTask(id: string, projectId: string): WorkflowTask | null;
	updateState(
		id: string,
		projectId: string,
		newState: WorkflowState,
		assignedAgent?: string | null,
	): void;
	incrementReviewCycle(id: string, projectId: string): void;
	listTasks(query: WorkflowTaskQuery): WorkflowTask[];
	recordTransition(input: RecordTransition): void;
	getHistory(taskId: string, projectId: string): WorkflowTransition[];
	close(): void;
}

/**
 * Create a WorkflowStore backed by SQLite.
 *
 * @param dbPath - Path to the SQLite database file, or ":memory:" for testing
 */
export function createWorkflowStore(dbPath: string): WorkflowStore {
	const db = new Database(dbPath);
	db.exec("PRAGMA journal_mode=WAL");
	db.exec("PRAGMA busy_timeout=5000");

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

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_workflow_transitions_task
		ON workflow_transitions (task_id, project_id)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_workflow_tasks_state
		ON workflow_tasks (project_id, current_state)
	`);

	const insertTaskStmt = db.prepare(`
		INSERT INTO workflow_tasks (id, project_id, current_state, ticket_id, ticket_provider, created_at, updated_at)
		VALUES (?, ?, 'created', ?, ?, ?, ?)
	`);

	const getTaskStmt = db.prepare(`
		SELECT id, project_id, current_state, assigned_agent, branch_name,
			review_cycle_count, ticket_id, ticket_provider, created_at, updated_at
		FROM workflow_tasks WHERE id = ? AND project_id = ?
	`);

	const updateStateStmt = db.prepare(`
		UPDATE workflow_tasks SET current_state = ?, assigned_agent = ?, updated_at = ?
		WHERE id = ? AND project_id = ?
	`);

	const incrementReviewStmt = db.prepare(`
		UPDATE workflow_tasks SET review_cycle_count = review_cycle_count + 1, updated_at = ?
		WHERE id = ? AND project_id = ?
	`);

	const insertTransitionStmt = db.prepare(`
		INSERT INTO workflow_transitions (task_id, project_id, from_state, to_state, signal, triggered_by, role, metadata, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);

	const getHistoryStmt = db.prepare(`
		SELECT id, task_id, project_id, from_state, to_state, signal, triggered_by, role, metadata, created_at
		FROM workflow_transitions WHERE task_id = ? AND project_id = ?
		ORDER BY id ASC
	`);

	function rowToTask(row: Record<string, unknown>): WorkflowTask {
		return {
			id: row.id as string,
			projectId: row.project_id as string,
			currentState: row.current_state as WorkflowState,
			assignedAgent: (row.assigned_agent as string) ?? null,
			branchName: (row.branch_name as string) ?? null,
			reviewCycleCount: row.review_cycle_count as number,
			ticketId: (row.ticket_id as string) ?? null,
			ticketProvider: row.ticket_provider as string,
			createdAt: row.created_at as string,
			updatedAt: row.updated_at as string,
		};
	}

	function rowToTransition(row: Record<string, unknown>): WorkflowTransition {
		return {
			id: row.id as number,
			taskId: row.task_id as string,
			projectId: row.project_id as string,
			fromState: row.from_state as WorkflowState,
			toState: row.to_state as WorkflowState,
			signal: row.signal as WorkflowSignal,
			triggeredBy: row.triggered_by as string,
			role: row.role as WorkflowRole,
			metadata: (row.metadata as string) ?? null,
			createdAt: row.created_at as string,
		};
	}

	return {
		createTask(input) {
			const now = new Date().toISOString();
			insertTaskStmt.run(
				input.id,
				input.projectId,
				input.ticketId ?? null,
				input.ticketProvider ?? "beads",
				now,
				now,
			);
			const task = getTaskStmt.get(input.id, input.projectId) as Record<string, unknown> | null;
			if (!task) {
				throw new Error(`Failed to create workflow task: ${input.id}`);
			}
			return rowToTask(task);
		},

		getTask(id, projectId) {
			const row = getTaskStmt.get(id, projectId) as Record<string, unknown> | null;
			return row ? rowToTask(row) : null;
		},

		updateState(id, projectId, newState, assignedAgent) {
			const now = new Date().toISOString();
			updateStateStmt.run(
				newState,
				assignedAgent === undefined ? null : assignedAgent,
				now,
				id,
				projectId,
			);
		},

		incrementReviewCycle(id, projectId) {
			const now = new Date().toISOString();
			incrementReviewStmt.run(now, id, projectId);
		},

		listTasks(query) {
			const conditions = ["project_id = ?"];
			const params: string[] = [query.projectId];

			if (query.state) {
				conditions.push("current_state = ?");
				params.push(query.state);
			}
			if (query.assignedAgent) {
				conditions.push("assigned_agent = ?");
				params.push(query.assignedAgent);
			}

			let sql = `SELECT id, project_id, current_state, assigned_agent, branch_name,
				review_cycle_count, ticket_id, ticket_provider, created_at, updated_at
				FROM workflow_tasks WHERE ${conditions.join(" AND ")}
				ORDER BY created_at DESC`;

			if (query.limit) {
				sql += ` LIMIT ${query.limit}`;
			}

			const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
			return rows.map(rowToTask);
		},

		recordTransition(input) {
			const now = new Date().toISOString();
			insertTransitionStmt.run(
				input.taskId,
				input.projectId,
				input.fromState,
				input.toState,
				input.signal,
				input.triggeredBy,
				input.role,
				input.metadata ? JSON.stringify(input.metadata) : null,
				now,
			);
		},

		getHistory(taskId, projectId) {
			const rows = getHistoryStmt.all(taskId, projectId) as Record<string, unknown>[];
			return rows.map(rowToTransition);
		},

		close() {
			db.close();
		},
	};
}
