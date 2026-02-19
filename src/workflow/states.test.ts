import { describe, expect, test } from "bun:test";
import {
	getNextState,
	getValidSignals,
	isTerminalState,
	TRANSITIONS,
	validateTransition,
} from "./states.ts";

describe("TRANSITIONS", () => {
	test("has entries for all non-terminal states", () => {
		const fromStates = new Set(TRANSITIONS.map((t) => t.from));
		// created, assigned, scouting, building, review_needed, reviewing,
		// review_passed, revision_needed, merge_queued, merging, merge_blocked
		expect(fromStates.size).toBeGreaterThanOrEqual(11);
	});

	test("has no transitions from terminal states", () => {
		const fromStates = new Set(TRANSITIONS.map((t) => t.from));
		expect(fromStates.has("completed")).toBe(false);
		expect(fromStates.has("cancelled")).toBe(false);
	});
});

describe("validateTransition", () => {
	test("allows coordinator to dispatch from created", () => {
		const result = validateTransition("created", "dispatch", "coordinator");
		expect(result.valid).toBe(true);
		if (result.valid) {
			expect(result.rule.to).toBe("assigned");
		}
	});

	test("allows builder to claim from assigned", () => {
		const result = validateTransition("assigned", "claim", "builder");
		expect(result.valid).toBe(true);
		if (result.valid) {
			expect(result.rule.to).toBe("building");
		}
	});

	test("allows scout to claim from assigned", () => {
		const result = validateTransition("assigned", "claim", "scout");
		expect(result.valid).toBe(true);
		if (result.valid) {
			expect(result.rule.to).toBe("scouting");
		}
	});

	test("rejects builder dispatching from created", () => {
		const result = validateTransition("created", "dispatch", "builder");
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.reason).toContain("builder");
		}
	});

	test("rejects invalid signal for state", () => {
		const result = validateTransition("created", "merged", "coordinator");
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.reason).toContain("No transition");
		}
	});

	test("full happy path: created → completed", () => {
		const steps: Array<{
			signal: Parameters<typeof validateTransition>[1];
			role: Parameters<typeof validateTransition>[2];
			expectedTo: Parameters<typeof validateTransition>[0];
		}> = [
			{ signal: "dispatch", role: "coordinator", expectedTo: "assigned" },
			{ signal: "claim", role: "builder", expectedTo: "building" },
			{ signal: "worker_done", role: "builder", expectedTo: "review_needed" },
			{ signal: "claim", role: "reviewer", expectedTo: "reviewing" },
			{ signal: "review_passed", role: "reviewer", expectedTo: "review_passed" },
			{ signal: "merge_ready", role: "lead", expectedTo: "merge_queued" },
			{ signal: "claim", role: "merger", expectedTo: "merging" },
			{ signal: "merged", role: "merger", expectedTo: "completed" },
		];

		let currentState = "created" as Parameters<typeof validateTransition>[0];
		for (const step of steps) {
			const result = validateTransition(currentState, step.signal, step.role);
			expect(result.valid).toBe(true);
			if (result.valid) {
				expect(result.rule.to).toBe(step.expectedTo);
				currentState = result.rule.to;
			}
		}
	});

	test("scouting path: created → scouting → building", () => {
		let result = validateTransition("created", "dispatch", "lead");
		expect(result.valid).toBe(true);

		result = validateTransition("assigned", "claim", "scout");
		expect(result.valid).toBe(true);
		if (result.valid) {
			expect(result.rule.to).toBe("scouting");
		}

		result = validateTransition("scouting", "scout_done", "lead");
		expect(result.valid).toBe(true);
		if (result.valid) {
			expect(result.rule.to).toBe("building");
		}
	});

	test("revision cycle: reviewing → revision_needed → building", () => {
		const result1 = validateTransition("reviewing", "review_failed", "reviewer");
		expect(result1.valid).toBe(true);
		if (result1.valid) {
			expect(result1.rule.to).toBe("revision_needed");
		}

		const result2 = validateTransition("revision_needed", "assign", "lead");
		expect(result2.valid).toBe(true);
		if (result2.valid) {
			expect(result2.rule.to).toBe("building");
		}
	});

	test("merge blocked → merge_queued retry", () => {
		const result = validateTransition("merge_blocked", "assign", "coordinator");
		expect(result.valid).toBe(true);
		if (result.valid) {
			expect(result.rule.to).toBe("merge_queued");
		}
	});
});

describe("cancel transition", () => {
	test("coordinator can cancel from any non-terminal state", () => {
		const nonTerminalStates: Array<Parameters<typeof validateTransition>[0]> = [
			"created",
			"assigned",
			"scouting",
			"building",
			"review_needed",
			"reviewing",
			"review_passed",
			"revision_needed",
			"merge_queued",
			"merging",
			"merge_blocked",
		];

		for (const state of nonTerminalStates) {
			const result = validateTransition(state, "cancel", "coordinator");
			expect(result.valid).toBe(true);
			if (result.valid) {
				expect(result.rule.to).toBe("cancelled");
			}
		}
	});

	test("supervisor can cancel", () => {
		const result = validateTransition("building", "cancel", "supervisor");
		expect(result.valid).toBe(true);
	});

	test("builder cannot cancel", () => {
		const result = validateTransition("building", "cancel", "builder");
		expect(result.valid).toBe(false);
	});

	test("cannot cancel from terminal states", () => {
		const result1 = validateTransition("completed", "cancel", "coordinator");
		expect(result1.valid).toBe(false);

		const result2 = validateTransition("cancelled", "cancel", "coordinator");
		expect(result2.valid).toBe(false);
	});
});

describe("getNextState", () => {
	test("returns target state for valid transition", () => {
		expect(getNextState("created", "dispatch", "coordinator")).toBe("assigned");
	});

	test("returns null for invalid transition", () => {
		expect(getNextState("created", "merged", "builder")).toBeNull();
	});
});

describe("isTerminalState", () => {
	test("completed is terminal", () => {
		expect(isTerminalState("completed")).toBe(true);
	});

	test("cancelled is terminal", () => {
		expect(isTerminalState("cancelled")).toBe(true);
	});

	test("building is not terminal", () => {
		expect(isTerminalState("building")).toBe(false);
	});
});

describe("getValidSignals", () => {
	test("returns signals for non-terminal state", () => {
		const signals = getValidSignals("created");
		expect(signals).toContain("dispatch");
		expect(signals).toContain("cancel");
	});

	test("returns empty for terminal state", () => {
		expect(getValidSignals("completed")).toEqual([]);
		expect(getValidSignals("cancelled")).toEqual([]);
	});

	test("assigned has claim + cancel", () => {
		const signals = getValidSignals("assigned");
		expect(signals).toContain("claim");
		expect(signals).toContain("cancel");
	});
});
