import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { WorkflowError } from "../errors.ts";
import type { WorkflowEngine } from "./engine.ts";
import { createWorkflowEngine } from "./engine.ts";
import type { WorkflowStore } from "./store.ts";
import { createWorkflowStore } from "./store.ts";

describe("WorkflowEngine", () => {
	let store: WorkflowStore;
	let engine: WorkflowEngine;
	const projectId = "test-project";

	beforeEach(() => {
		store = createWorkflowStore(":memory:");
		engine = createWorkflowEngine({ store });
	});

	afterEach(() => {
		store.close();
	});

	describe("createTask", () => {
		test("creates a task in created state", () => {
			const task = engine.createTask({ id: "task-1", projectId });
			expect(task.currentState).toBe("created");
			expect(task.id).toBe("task-1");
		});
	});

	describe("advance", () => {
		test("advances task from created to assigned", () => {
			engine.createTask({ id: "task-1", projectId });

			const result = engine.advance({
				taskId: "task-1",
				projectId,
				signal: "dispatch",
				triggeredBy: "coordinator-1",
				role: "coordinator",
			});

			expect(result.fromState).toBe("created");
			expect(result.toState).toBe("assigned");
			expect(result.task.currentState).toBe("assigned");
		});

		test("sets assigned agent on advance", () => {
			engine.createTask({ id: "task-1", projectId });

			engine.advance({
				taskId: "task-1",
				projectId,
				signal: "dispatch",
				triggeredBy: "coordinator-1",
				role: "coordinator",
				assignAgent: "lead-1",
			});

			const task = engine.getTask("task-1", projectId);
			expect(task?.assignedAgent).toBe("lead-1");
		});

		test("records transition history", () => {
			engine.createTask({ id: "task-1", projectId });

			engine.advance({
				taskId: "task-1",
				projectId,
				signal: "dispatch",
				triggeredBy: "coordinator-1",
				role: "coordinator",
			});

			const history = engine.getHistory("task-1", projectId);
			expect(history.length).toBe(1);
			expect(history[0]?.signal).toBe("dispatch");
			expect(history[0]?.triggeredBy).toBe("coordinator-1");
		});

		test("throws for non-existent task", () => {
			expect(() =>
				engine.advance({
					taskId: "nope",
					projectId,
					signal: "dispatch",
					triggeredBy: "coordinator-1",
					role: "coordinator",
				}),
			).toThrow(WorkflowError);
		});

		test("throws for invalid transition", () => {
			engine.createTask({ id: "task-1", projectId });

			expect(() =>
				engine.advance({
					taskId: "task-1",
					projectId,
					signal: "merged",
					triggeredBy: "merger-1",
					role: "merger",
				}),
			).toThrow(WorkflowError);
		});

		test("throws for terminal state", () => {
			engine.createTask({ id: "task-1", projectId });

			// Drive to completed
			engine.advance({
				taskId: "task-1",
				projectId,
				signal: "dispatch",
				triggeredBy: "c",
				role: "coordinator",
			});
			engine.advance({
				taskId: "task-1",
				projectId,
				signal: "claim",
				triggeredBy: "b",
				role: "builder",
			});
			engine.advance({
				taskId: "task-1",
				projectId,
				signal: "worker_done",
				triggeredBy: "b",
				role: "builder",
			});
			engine.advance({
				taskId: "task-1",
				projectId,
				signal: "claim",
				triggeredBy: "r",
				role: "reviewer",
			});
			engine.advance({
				taskId: "task-1",
				projectId,
				signal: "review_passed",
				triggeredBy: "r",
				role: "reviewer",
			});
			engine.advance({
				taskId: "task-1",
				projectId,
				signal: "merge_ready",
				triggeredBy: "l",
				role: "lead",
			});
			engine.advance({
				taskId: "task-1",
				projectId,
				signal: "claim",
				triggeredBy: "m",
				role: "merger",
			});
			engine.advance({
				taskId: "task-1",
				projectId,
				signal: "merged",
				triggeredBy: "m",
				role: "merger",
			});

			expect(() =>
				engine.advance({
					taskId: "task-1",
					projectId,
					signal: "dispatch",
					triggeredBy: "c",
					role: "coordinator",
				}),
			).toThrow(/terminal state/);
		});

		test("enforces max review cycles", () => {
			engine.createTask({ id: "task-1", projectId });

			function buildAndReview() {
				engine.advance({
					taskId: "task-1",
					projectId,
					signal: "dispatch",
					triggeredBy: "c",
					role: "coordinator",
				});
			}

			// Initial dispatch + build
			buildAndReview();
			engine.advance({
				taskId: "task-1",
				projectId,
				signal: "claim",
				triggeredBy: "b",
				role: "builder",
			});
			engine.advance({
				taskId: "task-1",
				projectId,
				signal: "worker_done",
				triggeredBy: "b",
				role: "builder",
			});

			// 3 review cycles
			for (let i = 0; i < 3; i++) {
				engine.advance({
					taskId: "task-1",
					projectId,
					signal: "claim",
					triggeredBy: "r",
					role: "reviewer",
				});
				engine.advance({
					taskId: "task-1",
					projectId,
					signal: "review_failed",
					triggeredBy: "r",
					role: "reviewer",
				});

				if (i < 2) {
					// Go back to building for next cycle
					engine.advance({
						taskId: "task-1",
						projectId,
						signal: "assign",
						triggeredBy: "l",
						role: "lead",
					});
					engine.advance({
						taskId: "task-1",
						projectId,
						signal: "worker_done",
						triggeredBy: "b",
						role: "builder",
					});
				}
			}

			// 4th review cycle should fail at revision_needed
			expect(() =>
				engine.advance({
					taskId: "task-1",
					projectId,
					signal: "assign",
					triggeredBy: "l",
					role: "lead",
				}),
			).toThrow(/exceeded max review cycles/);
		});

		test("cancel from non-terminal state", () => {
			engine.createTask({ id: "task-1", projectId });

			engine.advance({
				taskId: "task-1",
				projectId,
				signal: "dispatch",
				triggeredBy: "c",
				role: "coordinator",
			});

			const result = engine.advance({
				taskId: "task-1",
				projectId,
				signal: "cancel",
				triggeredBy: "c",
				role: "coordinator",
			});

			expect(result.toState).toBe("cancelled");
		});
	});

	describe("getPendingWork", () => {
		test("returns tasks matching role", () => {
			engine.createTask({ id: "t1", projectId });
			engine.createTask({ id: "t2", projectId });

			// Dispatch both
			engine.advance({
				taskId: "t1",
				projectId,
				signal: "dispatch",
				triggeredBy: "c",
				role: "coordinator",
			});
			engine.advance({
				taskId: "t2",
				projectId,
				signal: "dispatch",
				triggeredBy: "c",
				role: "coordinator",
			});

			const builderWork = engine.getPendingWork(projectId, "builder");
			expect(builderWork.length).toBe(2);
			expect(builderWork.every((t) => t.currentState === "assigned")).toBe(true);
		});

		test("returns empty for no matching work", () => {
			engine.createTask({ id: "t1", projectId });

			const mergerWork = engine.getPendingWork(projectId, "merger");
			expect(mergerWork).toEqual([]);
		});
	});

	describe("ticket sync", () => {
		test("calls ticket sync on advance", () => {
			const synced: Array<{ taskId: string; ticketId: string | null; state: string }> = [];
			const syncEngine = createWorkflowEngine({
				store,
				ticketSync: (taskId, ticketId, state) => {
					synced.push({ taskId, ticketId, state });
				},
			});

			syncEngine.createTask({
				id: "task-1",
				projectId,
				ticketId: "bead-123",
			});

			syncEngine.advance({
				taskId: "task-1",
				projectId,
				signal: "dispatch",
				triggeredBy: "c",
				role: "coordinator",
			});

			expect(synced.length).toBe(1);
			expect(synced[0]?.taskId).toBe("task-1");
			expect(synced[0]?.ticketId).toBe("bead-123");
			expect(synced[0]?.state).toBe("assigned");
		});

		test("swallows ticket sync errors", () => {
			const syncEngine = createWorkflowEngine({
				store,
				ticketSync: () => {
					throw new Error("sync failed");
				},
			});

			syncEngine.createTask({ id: "task-1", projectId });

			// Should not throw
			const result = syncEngine.advance({
				taskId: "task-1",
				projectId,
				signal: "dispatch",
				triggeredBy: "c",
				role: "coordinator",
			});

			expect(result.toState).toBe("assigned");
		});
	});
});
