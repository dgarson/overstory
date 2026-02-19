/**
 * Workflow state machine — pure functions, zero side effects.
 *
 * Defines the transition table for task lifecycle states and provides
 * validation functions for state transitions.
 */

import type { WorkflowRole, WorkflowSignal, WorkflowState } from "../types.ts";

/** A single allowed transition in the state machine. */
export interface TransitionRule {
	from: WorkflowState;
	to: WorkflowState;
	signal: WorkflowSignal;
	allowedRoles: readonly WorkflowRole[];
}

/**
 * Authoritative transition table for the workflow state machine.
 *
 * Each entry defines: source state → target state, the signal that triggers it,
 * and which roles are authorized to trigger the transition.
 */
export const TRANSITIONS: readonly TransitionRule[] = [
	{
		from: "created",
		to: "assigned",
		signal: "dispatch",
		allowedRoles: ["coordinator", "supervisor", "lead"],
	},
	{
		from: "assigned",
		to: "scouting",
		signal: "claim",
		allowedRoles: ["scout"],
	},
	{
		from: "assigned",
		to: "building",
		signal: "claim",
		allowedRoles: ["builder"],
	},
	{
		from: "scouting",
		to: "building",
		signal: "scout_done",
		allowedRoles: ["lead"],
	},
	{
		from: "building",
		to: "review_needed",
		signal: "worker_done",
		allowedRoles: ["builder"],
	},
	{
		from: "review_needed",
		to: "reviewing",
		signal: "claim",
		allowedRoles: ["reviewer"],
	},
	{
		from: "reviewing",
		to: "review_passed",
		signal: "review_passed",
		allowedRoles: ["reviewer"],
	},
	{
		from: "reviewing",
		to: "revision_needed",
		signal: "review_failed",
		allowedRoles: ["reviewer"],
	},
	{
		from: "revision_needed",
		to: "building",
		signal: "assign",
		allowedRoles: ["lead"],
	},
	{
		from: "review_passed",
		to: "merge_queued",
		signal: "merge_ready",
		allowedRoles: ["lead"],
	},
	{
		from: "merge_queued",
		to: "merging",
		signal: "claim",
		allowedRoles: ["merger"],
	},
	{
		from: "merging",
		to: "completed",
		signal: "merged",
		allowedRoles: ["merger"],
	},
	{
		from: "merging",
		to: "merge_blocked",
		signal: "merge_failed",
		allowedRoles: ["merger"],
	},
	{
		from: "merge_blocked",
		to: "merge_queued",
		signal: "assign",
		allowedRoles: ["lead", "coordinator"],
	},
] as const;

/** Result of a transition validation. */
export type TransitionResult =
	| { valid: true; rule: TransitionRule }
	| { valid: false; reason: string };

/**
 * Validate whether a transition is allowed.
 *
 * @param currentState - The task's current state
 * @param signal - The signal being applied
 * @param role - The role attempting the transition
 * @returns A TransitionResult indicating validity or rejection reason
 */
export function validateTransition(
	currentState: WorkflowState,
	signal: WorkflowSignal,
	role: WorkflowRole,
): TransitionResult {
	// Special case: cancel from any non-terminal state
	if (signal === "cancel") {
		if (currentState === "completed" || currentState === "cancelled") {
			return {
				valid: false,
				reason: `Cannot cancel task in terminal state '${currentState}'`,
			};
		}
		if (role !== "coordinator" && role !== "supervisor") {
			return {
				valid: false,
				reason: `Only coordinator or supervisor can cancel tasks, got '${role}'`,
			};
		}
		return {
			valid: true,
			rule: {
				from: currentState,
				to: "cancelled",
				signal: "cancel",
				allowedRoles: ["coordinator", "supervisor"],
			},
		};
	}

	// Find matching transition rules
	const matching = TRANSITIONS.filter((t) => t.from === currentState && t.signal === signal);

	if (matching.length === 0) {
		return {
			valid: false,
			reason: `No transition from '${currentState}' with signal '${signal}'`,
		};
	}

	// Check if any matching rule allows this role
	const authorized = matching.find((t) => t.allowedRoles.includes(role));

	if (!authorized) {
		const allowedRoles = [...new Set(matching.flatMap((t) => [...t.allowedRoles]))];
		return {
			valid: false,
			reason: `Role '${role}' cannot trigger '${signal}' from '${currentState}'. Allowed: ${allowedRoles.join(", ")}`,
		};
	}

	return { valid: true, rule: authorized };
}

/**
 * Get the target state for a transition, if valid.
 * Convenience wrapper around validateTransition.
 */
export function getNextState(
	currentState: WorkflowState,
	signal: WorkflowSignal,
	role: WorkflowRole,
): WorkflowState | null {
	const result = validateTransition(currentState, signal, role);
	return result.valid ? result.rule.to : null;
}

/**
 * Check if a state is terminal (no outgoing transitions except cancel).
 */
export function isTerminalState(state: WorkflowState): boolean {
	return state === "completed" || state === "cancelled";
}

/**
 * Get all valid signals for a given state.
 */
export function getValidSignals(state: WorkflowState): WorkflowSignal[] {
	if (isTerminalState(state)) return [];
	const signals = TRANSITIONS.filter((t) => t.from === state).map((t) => t.signal);
	// Always include cancel for non-terminal states
	return [...new Set([...signals, "cancel" as WorkflowSignal])];
}
