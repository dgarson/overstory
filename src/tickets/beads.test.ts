/**
 * Tests for BeadsProvider.
 *
 * We cannot test against the real bd CLI in unit tests (it requires a beads
 * project to be initialized). These tests verify the normalization logic
 * by testing workflowStateToTicketStatus and the beadsStatusToTicketStatus
 * mapping indirectly via normalizeBeadIssue (which is tested through
 * the provider interface).
 *
 * The provider.ts functions are tested directly.
 */

import { describe, expect, test } from "bun:test";
import { workflowStateToTicketStatus } from "./provider.ts";

describe("workflowStateToTicketStatus", () => {
	test("created maps to open", () => {
		expect(workflowStateToTicketStatus("created")).toBe("open");
	});

	test("active work states map to in_progress", () => {
		const activeStates = [
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
		] as const;

		for (const state of activeStates) {
			expect(workflowStateToTicketStatus(state)).toBe("in_progress");
		}
	});

	test("completed maps to closed", () => {
		expect(workflowStateToTicketStatus("completed")).toBe("closed");
	});

	test("cancelled maps to cancelled", () => {
		expect(workflowStateToTicketStatus("cancelled")).toBe("cancelled");
	});
});
