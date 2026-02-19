/**
 * Coordinator loop — 5s setInterval inside the MCP server process.
 *
 * Responsibilities:
 * 1. Resolve blocked await_work calls when work arrives
 * 2. Detect idle agents (>idleThresholdMs since last MCP call) and tmux nudge
 * 3. Stale SSE session cleanup
 *
 * Non-agentic, non-AI. Pure mechanical coordination.
 */

import type { MailStore } from "../mail/store.ts";
import type { WorkflowEngine } from "../workflow/engine.ts";
import type { TransportState } from "./transport.ts";
import type {
	AwaitWorkMessage,
	AwaitWorkResponse,
	AwaitWorkTransition,
	McpSession,
} from "./types.ts";

export interface CoordinatorLoopConfig {
	intervalMs: number;
	idleThresholdMs: number;
	projectId: string;
}

export interface CoordinatorLoopDeps {
	mailStore: MailStore;
	workflowEngine: WorkflowEngine;
	transport: TransportState;
	config: CoordinatorLoopConfig;
	/** Injected for testing — avoids real tmux calls. */
	_tmux?: {
		sendKeys(session: string, text: string): Promise<void>;
	};
}

/**
 * Check if an agent has pending work (unread mail OR workflow transitions).
 */
function checkPendingWork(
	agentName: string,
	projectId: string,
	deps: CoordinatorLoopDeps,
): { messages: AwaitWorkMessage[]; transitions: AwaitWorkTransition[] } {
	const rawMessages = deps.mailStore.getUnread(agentName).slice(0, 50);
	const messages: AwaitWorkMessage[] = rawMessages.map((m) => ({
		id: m.id,
		from: m.from,
		subject: m.subject,
		body: m.body,
		type: m.type,
		priority: m.priority,
		createdAt: m.createdAt,
	}));

	const transitions: AwaitWorkTransition[] = [];
	try {
		// Check for tasks assigned to this agent in actionable states
		const roles = [
			"coordinator",
			"supervisor",
			"lead",
			"builder",
			"reviewer",
			"merger",
			"scout",
		] as const;
		for (const role of roles) {
			const tasks = deps.workflowEngine.getPendingWork(projectId, role);
			for (const task of tasks) {
				if (task.assignedAgent === agentName) {
					const history = deps.workflowEngine.getHistory(task.id, projectId);
					const last = history[history.length - 1];
					if (last) {
						transitions.push({
							taskId: task.id,
							fromState: last.fromState,
							toState: last.toState,
							signal: last.signal,
							triggeredBy: last.triggeredBy,
						});
					}
				}
			}
		}
	} catch {
		// Non-critical
	}

	return { messages, transitions };
}

/**
 * Send a tmux nudge to an idle agent.
 *
 * Uses the real tmux via subprocess by default.
 * Injected _tmux is used in tests.
 */
async function nudgeAgent(session: McpSession, deps: CoordinatorLoopDeps): Promise<void> {
	const tmuxSession = `overstory-${session.projectId}-${session.agentName}`;

	if (deps._tmux) {
		await deps._tmux.sendKeys(tmuxSession, "");
		return;
	}

	// Real tmux: send empty key to wake the agent
	const proc = Bun.spawn(["tmux", "send-keys", "-t", tmuxSession, "", ""], {
		stdout: "pipe",
		stderr: "pipe",
	});
	await proc.exited;
}

/**
 * Run one tick of the coordinator loop.
 *
 * Exported for testing — the daemon calls this on each interval.
 */
export async function tick(deps: CoordinatorLoopDeps): Promise<void> {
	const { transport, config } = deps;
	const now = Date.now();

	for (const [agentName, session] of transport.sessions) {
		// Skip sessions with no agent identity
		if (agentName === "unknown") continue;

		const { messages, transitions } = checkPendingWork(agentName, config.projectId, deps);

		const hasPendingWork = messages.length > 0 || transitions.length > 0;

		// 1. Resolve blocked await_work if this agent is waiting
		const resolver = transport.awaitWorkResolvers.get(agentName);
		if (resolver && hasPendingWork) {
			const response: AwaitWorkResponse = {
				timedOut: false,
				messages,
				transitions,
				instruction: "Process these items, then call await_work again if more work expected.",
			};
			resolver(response);
			// Mark messages as read after delivering via await_work
			for (const msg of messages) {
				try {
					deps.mailStore.markRead(msg.id);
				} catch {
					// Non-critical
				}
			}
			continue;
		}

		// 2. Detect idle agents with pending work and nudge via tmux
		if (hasPendingWork) {
			const lastCallMs = new Date(session.lastMcpCallAt).getTime();
			const idleMs = now - lastCallMs;

			if (idleMs > config.idleThresholdMs) {
				try {
					await nudgeAgent(session, deps);
				} catch {
					// Tmux nudge failures are non-critical
				}
			}
		}
	}

	// 3. Clean up stale sessions (no SSE + no recent MCP call + > 5min idle)
	const staleThresholdMs = 5 * 60 * 1_000;
	for (const [sessionId, session] of transport.sessions) {
		if (!session.sseController) {
			const lastCallMs = new Date(session.lastMcpCallAt).getTime();
			if (now - lastCallMs > staleThresholdMs) {
				transport.sessions.delete(sessionId);
			}
		}
	}
}

/**
 * Start the coordinator loop.
 *
 * @returns A stop function that clears the interval.
 */
export function startCoordinatorLoop(deps: CoordinatorLoopDeps): () => void {
	const timer = setInterval(() => {
		tick(deps).catch(() => {
			// Coordinator loop errors are non-critical — log and continue
		});
	}, deps.config.intervalMs);

	return () => clearInterval(timer);
}
