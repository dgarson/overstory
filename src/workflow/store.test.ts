import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WorkflowStore } from "./store.ts";
import { createWorkflowStore } from "./store.ts";

describe("WorkflowStore", () => {
	let store: WorkflowStore;

	beforeEach(() => {
		store = createWorkflowStore(":memory:");
	});

	afterEach(() => {
		store.close();
	});

	describe("createTask", () => {
		test("creates a task in 'created' state", () => {
			const task = store.createTask({ id: "task-1", projectId: "proj-1" });
			expect(task.id).toBe("task-1");
			expect(task.projectId).toBe("proj-1");
			expect(task.currentState).toBe("created");
			expect(task.assignedAgent).toBeNull();
			expect(task.branchName).toBeNull();
			expect(task.reviewCycleCount).toBe(0);
			expect(task.ticketProvider).toBe("beads");
			expect(task.createdAt).toBeTruthy();
			expect(task.updatedAt).toBeTruthy();
		});

		test("creates a task with custom ticket provider", () => {
			const task = store.createTask({
				id: "task-2",
				projectId: "proj-1",
				ticketId: "GH-123",
				ticketProvider: "github",
			});
			expect(task.ticketId).toBe("GH-123");
			expect(task.ticketProvider).toBe("github");
		});

		test("allows same ID in different projects", () => {
			store.createTask({ id: "task-1", projectId: "proj-a" });
			store.createTask({ id: "task-1", projectId: "proj-b" });

			const a = store.getTask("task-1", "proj-a");
			const b = store.getTask("task-1", "proj-b");
			expect(a).not.toBeNull();
			expect(b).not.toBeNull();
			expect(a?.projectId).toBe("proj-a");
			expect(b?.projectId).toBe("proj-b");
		});
	});

	describe("getTask", () => {
		test("returns null for non-existent task", () => {
			expect(store.getTask("nope", "proj-1")).toBeNull();
		});

		test("returns task by id and project", () => {
			store.createTask({ id: "task-1", projectId: "proj-1" });
			const task = store.getTask("task-1", "proj-1");
			expect(task).not.toBeNull();
			expect(task?.id).toBe("task-1");
		});
	});

	describe("updateState", () => {
		test("updates state and agent", () => {
			store.createTask({ id: "task-1", projectId: "proj-1" });
			store.updateState("task-1", "proj-1", "assigned", "builder-1");

			const task = store.getTask("task-1", "proj-1");
			expect(task?.currentState).toBe("assigned");
			expect(task?.assignedAgent).toBe("builder-1");
		});

		test("clears agent when passed null", () => {
			store.createTask({ id: "task-1", projectId: "proj-1" });
			store.updateState("task-1", "proj-1", "assigned", "builder-1");
			store.updateState("task-1", "proj-1", "building", null);

			const task = store.getTask("task-1", "proj-1");
			expect(task?.assignedAgent).toBeNull();
		});
	});

	describe("incrementReviewCycle", () => {
		test("increments review count", () => {
			store.createTask({ id: "task-1", projectId: "proj-1" });
			expect(store.getTask("task-1", "proj-1")?.reviewCycleCount).toBe(0);

			store.incrementReviewCycle("task-1", "proj-1");
			expect(store.getTask("task-1", "proj-1")?.reviewCycleCount).toBe(1);

			store.incrementReviewCycle("task-1", "proj-1");
			expect(store.getTask("task-1", "proj-1")?.reviewCycleCount).toBe(2);
		});
	});

	describe("listTasks", () => {
		test("lists tasks by project", () => {
			store.createTask({ id: "t1", projectId: "proj-1" });
			store.createTask({ id: "t2", projectId: "proj-1" });
			store.createTask({ id: "t3", projectId: "proj-2" });

			const proj1 = store.listTasks({ projectId: "proj-1" });
			expect(proj1.length).toBe(2);

			const proj2 = store.listTasks({ projectId: "proj-2" });
			expect(proj2.length).toBe(1);
		});

		test("filters by state", () => {
			store.createTask({ id: "t1", projectId: "proj-1" });
			store.createTask({ id: "t2", projectId: "proj-1" });
			store.updateState("t1", "proj-1", "assigned", "agent-1");

			const assigned = store.listTasks({ projectId: "proj-1", state: "assigned" });
			expect(assigned.length).toBe(1);
			expect(assigned[0]?.id).toBe("t1");
		});

		test("filters by assigned agent", () => {
			store.createTask({ id: "t1", projectId: "proj-1" });
			store.createTask({ id: "t2", projectId: "proj-1" });
			store.updateState("t1", "proj-1", "building", "builder-1");
			store.updateState("t2", "proj-1", "building", "builder-2");

			const agent1 = store.listTasks({
				projectId: "proj-1",
				assignedAgent: "builder-1",
			});
			expect(agent1.length).toBe(1);
			expect(agent1[0]?.id).toBe("t1");
		});

		test("respects limit", () => {
			for (let i = 0; i < 5; i++) {
				store.createTask({ id: `t${i}`, projectId: "proj-1" });
			}
			const limited = store.listTasks({ projectId: "proj-1", limit: 3 });
			expect(limited.length).toBe(3);
		});
	});

	describe("transitions", () => {
		test("records and retrieves transition history", () => {
			store.createTask({ id: "task-1", projectId: "proj-1" });

			store.recordTransition({
				taskId: "task-1",
				projectId: "proj-1",
				fromState: "created",
				toState: "assigned",
				signal: "dispatch",
				triggeredBy: "coordinator-1",
				role: "coordinator",
			});

			store.recordTransition({
				taskId: "task-1",
				projectId: "proj-1",
				fromState: "assigned",
				toState: "building",
				signal: "claim",
				triggeredBy: "builder-1",
				role: "builder",
			});

			const history = store.getHistory("task-1", "proj-1");
			expect(history.length).toBe(2);
			expect(history[0]?.fromState).toBe("created");
			expect(history[0]?.toState).toBe("assigned");
			expect(history[1]?.fromState).toBe("assigned");
			expect(history[1]?.toState).toBe("building");
		});

		test("records transition with metadata", () => {
			store.createTask({ id: "task-1", projectId: "proj-1" });

			store.recordTransition({
				taskId: "task-1",
				projectId: "proj-1",
				fromState: "created",
				toState: "assigned",
				signal: "dispatch",
				triggeredBy: "coordinator-1",
				role: "coordinator",
				metadata: { specPath: "/specs/task-1.md" },
			});

			const history = store.getHistory("task-1", "proj-1");
			expect(history[0]?.metadata).toBeTruthy();
			const parsed = JSON.parse(history[0]?.metadata ?? "{}") as Record<string, unknown>;
			expect(parsed.specPath).toBe("/specs/task-1.md");
		});

		test("returns empty history for unknown task", () => {
			const history = store.getHistory("nope", "proj-1");
			expect(history).toEqual([]);
		});
	});
});
