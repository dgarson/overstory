/**
 * TicketProvider interface — abstraction layer for issue tracking systems.
 *
 * Normalizes operations across beads, GitHub Issues, Linear, etc.
 * Implementations wrap external CLI tools or APIs via subprocess.
 */

import type { WorkflowState } from "../types.ts";

/** Normalized ticket status values. */
export type TicketStatus = "open" | "in_progress" | "closed" | "cancelled";

/** Options for creating a new ticket. */
export interface CreateTicketOptions {
	title: string;
	description?: string;
	type?: string;
	priority?: number;
}

/** Options for listing tickets. */
export interface ListTicketOptions {
	status?: TicketStatus;
	limit?: number;
}

/** Normalized ticket representation. */
export interface Ticket {
	id: string;
	externalId: string; // Provider-specific ID
	title: string;
	status: TicketStatus;
	priority: number;
	type: string;
	assignee: string | null;
	description: string | null;
	blocks: string[];
	blockedBy: string[];
	providerName: string;
	metadata: Record<string, unknown>;
}

/**
 * Map a workflow state to a ticket status.
 * Used for ticket sync after state transitions.
 */
export function workflowStateToTicketStatus(state: WorkflowState): TicketStatus {
	switch (state) {
		case "created":
			return "open";
		case "assigned":
		case "scouting":
		case "building":
		case "review_needed":
		case "reviewing":
		case "review_passed":
		case "revision_needed":
		case "merge_queued":
		case "merging":
		case "merge_blocked":
			return "in_progress";
		case "completed":
			return "closed";
		case "cancelled":
			return "cancelled";
	}
}

/** Interface for ticket provider implementations. */
export interface TicketProvider {
	readonly name: string;

	/** Create a new ticket. Returns the new ticket ID. */
	create(options: CreateTicketOptions): Promise<string>;

	/** Get a ticket by ID. */
	get(id: string): Promise<Ticket>;

	/** Update ticket status. */
	updateStatus(id: string, status: TicketStatus): Promise<void>;

	/** Claim a ticket (mark as in_progress, set assignee). */
	claim(id: string, agentName: string): Promise<void>;

	/** Close a ticket with optional reason. */
	close(id: string, reason?: string): Promise<void>;

	/** List tickets with optional filters. */
	list(options?: ListTicketOptions): Promise<Ticket[]>;

	/** List tickets ready for work (open, unblocked). */
	ready(): Promise<Ticket[]>;

	/** Check if the ticket provider is available. */
	isAvailable(): Promise<boolean>;
}
