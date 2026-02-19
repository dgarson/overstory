/**
 * Workflow engine — orchestration layer for the state machine.
 *
 * Validates transitions, enforces review cycle limits, updates store,
 * records audit history, and syncs ticket status (fire-and-forget).
 */

import { WorkflowError } from "../errors.ts";
import type {
	WorkflowRole,
	WorkflowSignal,
	WorkflowState,
	WorkflowTask,
	WorkflowTransition,
} from "../types.ts";
import { isTerminalState, validateTransition } from "./states.ts";
import type { WorkflowStore } from "./store.ts";

/** Maximum review cycles before a task is blocked. */
const MAX_REVIEW_CYCLES = 3;

/** Options for advancing a task's state. */
export interface AdvanceOptions {
	taskId: string;
	projectId: string;
	signal: WorkflowSignal;
	triggeredBy: string;
	role: WorkflowRole;
	assignAgent?: string;
	metadata?: Record<string, unknown>;
}

/** Result of an advance operation. */
export interface AdvanceResult {
	task: WorkflowTask;
	fromState: WorkflowState;
	toState: WorkflowState;
}

/** Ticket sync callback — fire-and-forget. */
export type TicketSyncFn = (
	taskId: string,
	ticketId: string | null,
	newState: WorkflowState,
) => void;

/** Options for creating a WorkflowEngine. */
export interface WorkflowEngineOptions {
	store: WorkflowStore;
	ticketSync?: TicketSyncFn;
}

export interface WorkflowEngine {
	/** Create a new task at the 'created' state. */
	createTask(options: {
		id: string;
		projectId: string;
		ticketId?: string;
		ticketProvider?: string;
	}): WorkflowTask;

	/** Advance a task's state. Validates transition, enforces rules, records history. */
	advance(options: AdvanceOptions): AdvanceResult;

	/** Get pending work for a given project and role. */
	getPendingWork(projectId: string, role: WorkflowRole): WorkflowTask[];

	/** Get a task by ID. */
	getTask(taskId: string, projectId: string): WorkflowTask | null;

	/** Get the transition history for a task. */
	getHistory(taskId: string, projectId: string): WorkflowTransition[];
}

/**
 * Create a WorkflowEngine.
 */
export function createWorkflowEngine(options: WorkflowEngineOptions): WorkflowEngine {
	const { store, ticketSync } = options;

	return {
		createTask(opts) {
			return store.createTask(opts);
		},

		advance(opts) {
			const task = store.getTask(opts.taskId, opts.projectId);
			if (!task) {
				throw new WorkflowError(`Task not found: ${opts.taskId}`, {
					taskId: opts.taskId,
				});
			}

			if (isTerminalState(task.currentState)) {
				throw new WorkflowError(
					`Task '${opts.taskId}' is in terminal state '${task.currentState}'`,
					{ taskId: opts.taskId, currentState: task.currentState },
				);
			}

			// Validate the transition
			const result = validateTransition(task.currentState, opts.signal, opts.role);
			if (!result.valid) {
				throw new WorkflowError(result.reason, {
					taskId: opts.taskId,
					currentState: task.currentState,
				});
			}

			const toState = result.rule.to;

			// Enforce review cycle limit.
			// Increment when entering revision_needed; block when trying to leave it
			// back to building after the max has been reached.
			if (toState === "revision_needed") {
				store.incrementReviewCycle(opts.taskId, opts.projectId);
			} else if (task.currentState === "revision_needed" && toState === "building") {
				// Reload the updated count after any prior increment
				const refreshed = store.getTask(opts.taskId, opts.projectId);
				const cycleCount = refreshed?.reviewCycleCount ?? task.reviewCycleCount;
				if (cycleCount >= MAX_REVIEW_CYCLES) {
					throw new WorkflowError(
						`Task '${opts.taskId}' has exceeded max review cycles (${MAX_REVIEW_CYCLES})`,
						{ taskId: opts.taskId, currentState: task.currentState },
					);
				}
			}

			// Update state
			store.updateState(opts.taskId, opts.projectId, toState, opts.assignAgent ?? null);

			// Record transition history
			store.recordTransition({
				taskId: opts.taskId,
				projectId: opts.projectId,
				fromState: task.currentState,
				toState,
				signal: opts.signal,
				triggeredBy: opts.triggeredBy,
				role: opts.role,
				metadata: opts.metadata,
			});

			// Fire-and-forget ticket sync
			if (ticketSync) {
				try {
					ticketSync(opts.taskId, task.ticketId, toState);
				} catch {
					// Ticket sync is non-critical
				}
			}

			const updatedTask = store.getTask(opts.taskId, opts.projectId);
			if (!updatedTask) {
				throw new WorkflowError(`Task disappeared after update: ${opts.taskId}`, {
					taskId: opts.taskId,
				});
			}

			return {
				task: updatedTask,
				fromState: task.currentState,
				toState,
			};
		},

		getPendingWork(projectId, role) {
			// Map roles to states where they need to take action
			const statesByRole: Record<WorkflowRole, WorkflowState[]> = {
				coordinator: ["created"],
				supervisor: ["created"],
				lead: ["created", "scouting", "revision_needed", "review_passed", "merge_blocked"],
				scout: ["assigned"],
				builder: ["assigned", "building"],
				reviewer: ["review_needed"],
				merger: ["merge_queued"],
			};

			const states = statesByRole[role];
			if (!states || states.length === 0) return [];

			const tasks: WorkflowTask[] = [];
			for (const state of states) {
				const found = store.listTasks({ projectId, state });
				tasks.push(...found);
			}
			return tasks;
		},

		getTask(taskId, projectId) {
			return store.getTask(taskId, projectId);
		},

		getHistory(taskId, projectId) {
			return store.getHistory(taskId, projectId);
		},
	};
}
