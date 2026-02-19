/**
 * MCP Streamable HTTP transport.
 *
 * Handles:
 * - POST /mcp — JSON-RPC tool calls from agents
 * - GET /mcp  — SSE streams for server-pushed notifications
 *
 * Session identity is passed via X-Session-Id header or generated on first call.
 * Agent identity is passed as a tool parameter (agentName), not transport headers.
 */

import type { JsonRpcRequest, JsonRpcResponse, McpSession } from "./types.ts";
import { INTERNAL_ERROR, INVALID_REQUEST, METHOD_NOT_FOUND, PARSE_ERROR } from "./types.ts";

/** Tool handler function signature. */
export type ToolHandler = (
	params: Record<string, unknown>,
	session: McpSession,
) => Promise<unknown>;

/** In-memory state for active SSE sessions. */
export interface TransportState {
	sessions: Map<string, McpSession>;
	awaitWorkResolvers: Map<string, (work: unknown) => void>;
}

export function createTransportState(): TransportState {
	return {
		sessions: new Map(),
		awaitWorkResolvers: new Map(),
	};
}

/**
 * Generate a simple session ID.
 */
function generateSessionId(): string {
	return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Build a JSON-RPC success response.
 */
function successResponse(id: string | number | null, result: unknown): JsonRpcResponse {
	return { jsonrpc: "2.0", id, result };
}

/**
 * Build a JSON-RPC error response.
 */
function errorResponse(
	id: string | number | null,
	code: number,
	message: string,
	data?: unknown,
): JsonRpcResponse {
	return { jsonrpc: "2.0", id, error: { code, message, data } };
}

/**
 * Handle an incoming POST /mcp request.
 *
 * @param req - The incoming HTTP request
 * @param state - Transport state (sessions, resolvers)
 * @param handlers - Map of tool names to handler functions
 * @param projectId - The project ID for this server instance
 */
export async function handlePost(
	req: Request,
	state: TransportState,
	handlers: Map<string, ToolHandler>,
	projectId: string,
): Promise<Response> {
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return Response.json(errorResponse(null, PARSE_ERROR, "Parse error: invalid JSON"), {
			status: 400,
		});
	}

	const rpc = body as Partial<JsonRpcRequest>;
	if (!rpc || rpc.jsonrpc !== "2.0" || !rpc.method) {
		return Response.json(errorResponse(rpc?.id ?? null, INVALID_REQUEST, "Invalid Request"), {
			status: 400,
		});
	}

	// Resolve or create session
	const sessionId = req.headers.get("x-session-id") ?? generateSessionId();
	let session = state.sessions.get(sessionId);

	// Extract agent name from params for session registration
	const params = (rpc.params ?? {}) as Record<string, unknown>;
	const agentName = typeof params.agentName === "string" ? params.agentName : "unknown";
	const capability = typeof params.capability === "string" ? params.capability : null;

	if (!session) {
		session = {
			sessionId,
			agentName,
			capability,
			projectId,
			connectedAt: new Date().toISOString(),
			lastMcpCallAt: new Date().toISOString(),
			sseController: null,
		};
		state.sessions.set(sessionId, session);
	} else {
		// Update last call time and agent info
		session.lastMcpCallAt = new Date().toISOString();
		if (agentName !== "unknown") session.agentName = agentName;
		if (capability) session.capability = capability;
	}

	// Route to handler
	const method = rpc.method;
	const handler = handlers.get(method);
	if (!handler) {
		return Response.json(
			errorResponse(rpc.id ?? null, METHOD_NOT_FOUND, `Method not found: ${method}`),
			{ status: 404 },
		);
	}

	try {
		const result = await handler(params, session);
		return Response.json(successResponse(rpc.id ?? null, result), {
			headers: {
				"x-session-id": sessionId,
				"content-type": "application/json",
			},
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return Response.json(errorResponse(rpc.id ?? null, INTERNAL_ERROR, message), { status: 500 });
	}
}

/**
 * Handle an incoming GET /mcp request (SSE stream).
 *
 * Opens a Server-Sent Events stream for the agent. The coordinator loop
 * can push notifications through this stream to wake idle agents.
 */
export function handleSse(req: Request, state: TransportState, projectId: string): Response {
	const sessionId = req.headers.get("x-session-id") ?? generateSessionId();

	let session = state.sessions.get(sessionId);
	if (!session) {
		const agentName = req.headers.get("x-agent-name") ?? "unknown";
		session = {
			sessionId,
			agentName,
			capability: null,
			projectId,
			connectedAt: new Date().toISOString(),
			lastMcpCallAt: new Date().toISOString(),
			sseController: null,
		};
		state.sessions.set(sessionId, session);
	}

	const capturedSession = session;

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			capturedSession.sseController = controller;
			// Send initial ping
			const ping = `data: ${JSON.stringify({ type: "connected", sessionId })}\n\n`;
			controller.enqueue(new TextEncoder().encode(ping));
		},
		cancel() {
			capturedSession.sseController = null;
			state.sessions.delete(sessionId);
		},
	});

	return new Response(stream, {
		headers: {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			"x-session-id": sessionId,
		},
	});
}

/**
 * Push a notification to an agent's SSE stream.
 *
 * @param session - The target session
 * @param event - Event type
 * @param data - Event data
 * @returns true if delivered, false if no SSE connection
 */
export function pushNotification(session: McpSession, event: string, data: unknown): boolean {
	if (!session.sseController) return false;
	try {
		const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
		session.sseController.enqueue(new TextEncoder().encode(payload));
		return true;
	} catch {
		session.sseController = null;
		return false;
	}
}

/**
 * Build the MCP request handler for Bun.serve.
 *
 * Routes POST and GET requests to the appropriate transport handler.
 */
export function buildFetchHandler(
	state: TransportState,
	handlers: Map<string, ToolHandler>,
	projectId: string,
) {
	return async function fetch(req: Request): Promise<Response> {
		const url = new URL(req.url);

		if (url.pathname !== "/mcp") {
			return new Response("Not Found", { status: 404 });
		}

		if (req.method === "POST") {
			return handlePost(req, state, handlers, projectId);
		}

		if (req.method === "GET") {
			return handleSse(req, state, projectId);
		}

		return new Response("Method Not Allowed", { status: 405 });
	};
}
