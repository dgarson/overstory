/**
 * BeadsProvider — wraps the existing BeadsClient to implement TicketProvider.
 *
 * Maps beads statuses to normalized TicketStatus values and delegates
 * all operations to the bd CLI via BeadsClient.
 */

import type { BeadIssue, BeadsClient } from "../beads/client.ts";
import { createBeadsClient } from "../beads/client.ts";
import type {
	CreateTicketOptions,
	ListTicketOptions,
	Ticket,
	TicketProvider,
	TicketStatus,
} from "./provider.ts";

/**
 * Map a beads status string to a normalized TicketStatus.
 */
function beadsStatusToTicketStatus(status: string): TicketStatus {
	switch (status.toLowerCase()) {
		case "open":
			return "open";
		case "in_progress":
		case "in-progress":
			return "in_progress";
		case "closed":
		case "done":
		case "complete":
		case "completed":
			return "closed";
		case "cancelled":
		case "canceled":
			return "cancelled";
		default:
			return "open";
	}
}

/**
 * Normalize a BeadIssue into a Ticket.
 */
function normalizeBeadIssue(issue: BeadIssue): Ticket {
	return {
		id: issue.id,
		externalId: issue.id,
		title: issue.title,
		status: beadsStatusToTicketStatus(issue.status),
		priority: issue.priority,
		type: issue.type,
		assignee: issue.assignee ?? null,
		description: issue.description ?? null,
		blocks: issue.blocks ?? [],
		blockedBy: issue.blockedBy ?? [],
		providerName: "beads",
		metadata: {},
	};
}

/**
 * Create a BeadsProvider instance.
 *
 * @param cwd - Working directory where bd commands should run
 * @returns A TicketProvider backed by the beads CLI
 */
export function createBeadsProvider(cwd: string): TicketProvider {
	const client: BeadsClient = createBeadsClient(cwd);

	return {
		name: "beads",

		async create(options: CreateTicketOptions): Promise<string> {
			return client.create(options.title, {
				type: options.type,
				priority: options.priority,
				description: options.description,
			});
		},

		async get(id: string): Promise<Ticket> {
			const issue = await client.show(id);
			return normalizeBeadIssue(issue);
		},

		async updateStatus(id: string, status: TicketStatus): Promise<void> {
			// Map TicketStatus back to beads status string
			const beadsStatus =
				status === "in_progress"
					? "in_progress"
					: status === "closed"
						? "closed"
						: status === "cancelled"
							? "cancelled"
							: "open";

			if (beadsStatus === "closed") {
				await client.close(id);
			} else if (beadsStatus === "in_progress") {
				await client.claim(id);
			}
			// "open" and "cancelled" have no direct bd CLI equivalent beyond close
		},

		async claim(id: string, _agentName: string): Promise<void> {
			await client.claim(id);
		},

		async close(id: string, reason?: string): Promise<void> {
			await client.close(id, reason);
		},

		async list(options?: ListTicketOptions): Promise<Ticket[]> {
			const issues = await client.list({
				status: options?.status,
				limit: options?.limit,
			});
			return issues.map(normalizeBeadIssue);
		},

		async ready(): Promise<Ticket[]> {
			const issues = await client.ready();
			return issues.map(normalizeBeadIssue);
		},

		async isAvailable(): Promise<boolean> {
			const proc = Bun.spawn(["bd", "--version"], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const exitCode = await proc.exited;
			return exitCode === 0;
		},
	};
}
