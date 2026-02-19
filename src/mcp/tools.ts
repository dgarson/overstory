/**
 * MCP tool definitions and handler dispatch.
 *
 * Implements the MCP tool protocol: each tool corresponds to a JSON-RPC method
 * named "tools/call" with params.name identifying the tool.
 *
 * Tools:
 * - await_work        — block until messages/transitions arrive (or timeout)
 * - advance_task      — atomically update workflow state + notify parent
 * - get_pending_work  — query tasks needing action by this role
 * - claim_task        — claim a task for execution
 * - send_message      — send a mail message
 * - get_task          — get workflow task details
 * - check_messages    — check unread mail
 * - report_activity   — heartbeat to prevent idle detection
 */

import type { MailStore } from "../mail/store.ts";
import type { MailMessage, WorkflowRole, WorkflowSignal } from "../types.ts";
import type { WorkflowEngine } from "../workflow/engine.ts";
import type { TransportState } from "./transport.ts";
import type {
	AdvanceTaskResponse,
	AwaitWorkMessage,
	AwaitWorkResponse,
	AwaitWorkTransition,
	ClaimTaskResponse,
	GetPendingWorkResponse,
	GetTaskResponse,
	McpSession,
	SendMessageResponse,
} from "./types.ts";

export interface ToolDependencies {
	workflowEngine: WorkflowEngine;
	mailStore: MailStore;
	transport: TransportState;
	config: {
		awaitWorkMaxMs: number;
	};
}

/**
 * Handle the await_work tool.
 *
 * Registers a resolver and blocks until:
 * - Work arrives (coordinator loop calls the resolver), or
 * - The timeout expires
 *
 * The coordinator loop polls mail.db and workflow.db and calls the resolver
 * when pending work is found for the agent.
 */
async function handleAwaitWork(
	params: Record<string, unknown>,
	session: McpSession,
	deps: ToolDependencies,
): Promise<AwaitWorkResponse> {
	const agentName = typeof params.agentName === "string" ? params.agentName : session.agentName;
	const timeoutMs =
		typeof params.timeoutMs === "number"
			? Math.min(params.timeoutMs, deps.config.awaitWorkMaxMs)
			: 30_000;

	return new Promise<AwaitWorkResponse>((resolve) => {
		const timer = setTimeout(() => {
			deps.transport.awaitWorkResolvers.delete(agentName);
			resolve({
				timedOut: true,
				messages: [],
				transitions: [],
				instruction: "No work arrived within timeout. Call await_work again if still waiting.",
			});
		}, timeoutMs);

		// Register resolver — coordinator loop will call this when work arrives
		deps.transport.awaitWorkResolvers.set(agentName, (work: unknown) => {
			clearTimeout(timer);
			deps.transport.awaitWorkResolvers.delete(agentName);
			resolve(work as AwaitWorkResponse);
		});
	});
}

/**
 * Handle the advance_task tool.
 *
 * Atomically advances the workflow state machine and optionally sends
 * a worker_done mail to the parent agent.
 */
async function handleAdvanceTask(
	params: Record<string, unknown>,
	session: McpSession,
	deps: ToolDependencies,
): Promise<AdvanceTaskResponse> {
	const taskId = typeof params.taskId === "string" ? params.taskId : null;
	const signal = typeof params.signal === "string" ? (params.signal as WorkflowSignal) : null;
	const role = typeof params.role === "string" ? (params.role as WorkflowRole) : null;
	const agentName = typeof params.agentName === "string" ? params.agentName : session.agentName;

	if (!taskId || !signal || !role) {
		throw new Error("advance_task requires taskId, signal, and role");
	}

	const result = deps.workflowEngine.advance({
		taskId,
		projectId: session.projectId,
		signal,
		triggeredBy: agentName,
		role,
		assignAgent: typeof params.assignAgent === "string" ? params.assignAgent : undefined,
		metadata:
			params.metadata && typeof params.metadata === "object"
				? (params.metadata as Record<string, unknown>)
				: undefined,
	});

	// Send worker_done mail if parentAgent is provided
	if (typeof params.parentAgent === "string" && params.parentAgent) {
		const summary =
			typeof params.summary === "string"
				? params.summary
				: `Task ${taskId} advanced to ${result.toState}`;

		deps.mailStore.insert({
			id: "",
			from: agentName,
			to: params.parentAgent,
			subject: `Worker done: ${taskId}`,
			body: summary,
			priority: "normal",
			type: "worker_done",
			threadId: null,
			payload: JSON.stringify({ beadId: taskId, branch: "", exitCode: 0, filesModified: [] }),
		});
	}

	return {
		success: true,
		taskId,
		fromState: result.fromState,
		toState: result.toState,
		message: `Task ${taskId} advanced from ${result.fromState} to ${result.toState}`,
	};
}

/**
 * Handle the get_pending_work tool.
 */
function handleGetPendingWork(
	params: Record<string, unknown>,
	session: McpSession,
	deps: ToolDependencies,
): GetPendingWorkResponse {
	const role = typeof params.role === "string" ? (params.role as WorkflowRole) : null;
	if (!role) throw new Error("get_pending_work requires role");

	const tasks = deps.workflowEngine.getPendingWork(session.projectId, role);
	return {
		tasks: tasks.map((t) => ({
			id: t.id,
			currentState: t.currentState,
			ticketId: t.ticketId,
			updatedAt: t.updatedAt,
		})),
	};
}

/**
 * Handle the claim_task tool.
 */
async function handleClaimTask(
	params: Record<string, unknown>,
	session: McpSession,
	deps: ToolDependencies,
): Promise<ClaimTaskResponse> {
	const taskId = typeof params.taskId === "string" ? params.taskId : null;
	const role = typeof params.role === "string" ? (params.role as WorkflowRole) : null;
	const agentName = typeof params.agentName === "string" ? params.agentName : session.agentName;

	if (!taskId || !role) throw new Error("claim_task requires taskId and role");

	const result = deps.workflowEngine.advance({
		taskId,
		projectId: session.projectId,
		signal: "claim",
		triggeredBy: agentName,
		role,
		assignAgent: agentName,
	});

	return {
		success: true,
		taskId,
		newState: result.toState,
	};
}

/**
 * Handle the send_message tool.
 */
function handleSendMessage(
	params: Record<string, unknown>,
	session: McpSession,
	deps: ToolDependencies,
): SendMessageResponse {
	const to = typeof params.to === "string" ? params.to : null;
	const subject = typeof params.subject === "string" ? params.subject : "";
	const body = typeof params.body === "string" ? params.body : "";
	const from = typeof params.from === "string" ? params.from : session.agentName;
	const type = typeof params.type === "string" ? params.type : "status";
	const priority = typeof params.priority === "string" ? params.priority : "normal";

	if (!to) throw new Error("send_message requires 'to'");

	const msg = deps.mailStore.insert({
		id: "",
		from,
		to,
		subject,
		body,
		priority: priority as MailMessage["priority"],
		type: type as MailMessage["type"],
		threadId: typeof params.threadId === "string" ? params.threadId : null,
		payload: params.payload ? JSON.stringify(params.payload) : null,
	});

	return { messageId: msg.id, delivered: true };
}

/**
 * Handle the get_task tool.
 */
function handleGetTask(
	params: Record<string, unknown>,
	session: McpSession,
	deps: ToolDependencies,
): GetTaskResponse {
	const taskId = typeof params.taskId === "string" ? params.taskId : null;
	if (!taskId) throw new Error("get_task requires taskId");

	const task = deps.workflowEngine.getTask(taskId, session.projectId);
	if (!task) throw new Error(`Task not found: ${taskId}`);

	return {
		task: {
			id: task.id,
			currentState: task.currentState,
			assignedAgent: task.assignedAgent,
			reviewCycleCount: task.reviewCycleCount,
			ticketId: task.ticketId,
			updatedAt: task.updatedAt,
		},
	};
}

/**
 * Handle the check_messages tool.
 */
function handleCheckMessages(
	params: Record<string, unknown>,
	session: McpSession,
	deps: ToolDependencies,
): { messages: AwaitWorkMessage[]; count: number } {
	const agentName = typeof params.agentName === "string" ? params.agentName : session.agentName;
	const limit = typeof params.limit === "number" ? params.limit : 20;

	const messages = deps.mailStore.getUnread(agentName).slice(0, limit);
	const normalized: AwaitWorkMessage[] = messages.map((m) => ({
		id: m.id,
		from: m.from,
		subject: m.subject,
		body: m.body,
		type: m.type,
		priority: m.priority,
		createdAt: m.createdAt,
	}));

	// Mark messages as read
	for (const m of messages) {
		deps.mailStore.markRead(m.id);
	}

	return { messages: normalized, count: normalized.length };
}

/**
 * Handle the report_activity tool (heartbeat).
 */
function handleReportActivity(
	_params: Record<string, unknown>,
	session: McpSession,
): { acknowledged: boolean; timestamp: string } {
	session.lastMcpCallAt = new Date().toISOString();
	return { acknowledged: true, timestamp: session.lastMcpCallAt };
}

/**
 * Build the tool handlers map for use with the transport layer.
 *
 * MCP tools are invoked via the "tools/call" JSON-RPC method, with
 * params.name identifying the specific tool.
 */
export function buildToolHandlers(
	deps: ToolDependencies,
): Map<string, (params: Record<string, unknown>, session: McpSession) => Promise<unknown>> {
	const handlers = new Map<
		string,
		(params: Record<string, unknown>, session: McpSession) => Promise<unknown>
	>();

	// Adapter: MCP calls arrive as "tools/call" with params.name + params.arguments
	handlers.set("tools/call", async (params, session) => {
		const toolName = typeof params.name === "string" ? params.name : null;
		const args = (params.arguments ?? {}) as Record<string, unknown>;

		if (!toolName) throw new Error("tools/call requires 'name'");

		switch (toolName) {
			case "await_work":
				return handleAwaitWork(args, session, deps);
			case "advance_task":
				return handleAdvanceTask(args, session, deps);
			case "get_pending_work":
				return handleGetPendingWork(args, session, deps);
			case "claim_task":
				return handleClaimTask(args, session, deps);
			case "send_message":
				return handleSendMessage(args, session, deps);
			case "get_task":
				return handleGetTask(args, session, deps);
			case "check_messages":
				return handleCheckMessages(args, session, deps);
			case "report_activity":
				return handleReportActivity(args, session);
			default:
				throw new Error(`Unknown tool: ${toolName}`);
		}
	});

	// Also support direct method calls (tools/list for MCP negotiation)
	handlers.set("tools/list", async () => ({
		tools: [
			{
				name: "await_work",
				description:
					"Block until messages or workflow transitions arrive for this agent. Returns immediately if work is pending. Call in a loop to wait for delegated tasks to complete.",
				inputSchema: {
					type: "object",
					properties: {
						agentName: { type: "string", description: "Your agent name" },
						timeoutMs: { type: "number", description: "Max wait time in ms (default 30000)" },
					},
					required: ["agentName"],
				},
			},
			{
				name: "advance_task",
				description:
					"Advance a workflow task's state machine. Use instead of 'bd close' + 'overstory mail send' for atomic completion.",
				inputSchema: {
					type: "object",
					properties: {
						taskId: { type: "string", description: "Bead/task ID" },
						signal: {
							type: "string",
							description: "Workflow signal (worker_done, merged, review_passed, etc.)",
						},
						role: {
							type: "string",
							description: "Your role (builder, reviewer, merger, lead, coordinator)",
						},
						agentName: { type: "string", description: "Your agent name" },
						parentAgent: {
							type: "string",
							description: "Parent agent to notify (sends worker_done mail)",
						},
						summary: { type: "string", description: "Summary for the parent notification" },
					},
					required: ["taskId", "signal", "role"],
				},
			},
			{
				name: "get_pending_work",
				description: "Get tasks that need action from your role.",
				inputSchema: {
					type: "object",
					properties: {
						role: {
							type: "string",
							description: "Your role (builder, reviewer, merger, lead, etc.)",
						},
					},
					required: ["role"],
				},
			},
			{
				name: "claim_task",
				description: "Claim a task for execution (sets assigned_agent and advances state).",
				inputSchema: {
					type: "object",
					properties: {
						taskId: { type: "string", description: "Task ID to claim" },
						role: { type: "string", description: "Your role" },
						agentName: { type: "string", description: "Your agent name" },
					},
					required: ["taskId", "role"],
				},
			},
			{
				name: "send_message",
				description:
					"Send a mail message to another agent. Prefer this over overstory mail send CLI.",
				inputSchema: {
					type: "object",
					properties: {
						to: { type: "string", description: "Recipient agent name" },
						subject: { type: "string", description: "Message subject" },
						body: { type: "string", description: "Message body" },
						from: { type: "string", description: "Sender name (defaults to session agent)" },
						type: {
							type: "string",
							description: "Message type (status|result|error|worker_done|etc.)",
						},
						priority: { type: "string", description: "Priority (low|normal|high|urgent)" },
					},
					required: ["to", "subject", "body"],
				},
			},
			{
				name: "get_task",
				description: "Get workflow task details by ID.",
				inputSchema: {
					type: "object",
					properties: {
						taskId: { type: "string", description: "Task ID" },
					},
					required: ["taskId"],
				},
			},
			{
				name: "check_messages",
				description: "Check and mark-read unread messages for this agent.",
				inputSchema: {
					type: "object",
					properties: {
						agentName: { type: "string", description: "Your agent name" },
						limit: { type: "number", description: "Max messages to return (default 20)" },
					},
				},
			},
			{
				name: "report_activity",
				description: "Heartbeat — prevents idle detection. Call when doing long non-MCP work.",
				inputSchema: {
					type: "object",
					properties: {},
				},
			},
		],
	}));

	// MCP initialization
	handlers.set("initialize", async (params) => {
		const clientInfo = params.clientInfo as Record<string, unknown> | undefined;
		return {
			protocolVersion: "2024-11-05",
			capabilities: { tools: {} },
			serverInfo: {
				name: "overstory",
				version: "1.0.0",
				clientName: clientInfo?.name ?? "unknown",
			},
		};
	});

	return handlers;
}

/** Get pending work for an agent — used by the coordinator loop. */
export function getPendingWorkForAgent(
	agentName: string,
	projectId: string,
	deps: ToolDependencies,
): { messages: AwaitWorkMessage[]; transitions: AwaitWorkTransition[] } {
	const messages = deps.mailStore.getUnread(agentName).slice(0, 50);
	const normalizedMessages: AwaitWorkMessage[] = messages.map((m) => ({
		id: m.id,
		from: m.from,
		subject: m.subject,
		body: m.body,
		type: m.type,
		priority: m.priority,
		createdAt: m.createdAt,
	}));

	// Check workflow transitions for this agent
	// Look for tasks assigned to this agent that have pending work
	const transitions: AwaitWorkTransition[] = [];
	try {
		// Query tasks where assigned_agent matches — check if state changed recently
		// This is a lightweight poll; full transition tracking is in WorkflowStore
		const tasks = deps.workflowEngine.getPendingWork(projectId, "coordinator");
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
	} catch {
		// getPendingWork errors are non-critical
	}

	return { messages: normalizedMessages, transitions };
}
