/**
 * MCP protocol types — JSON-RPC 2.0 structures and session management types.
 */

// === JSON-RPC 2.0 ===

export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: string | number | null;
	method: string;
	params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: string | number | null;
	result?: unknown;
	error?: JsonRpcError;
}

export interface JsonRpcError {
	code: number;
	message: string;
	data?: unknown;
}

export interface JsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: Record<string, unknown>;
}

// Standard JSON-RPC error codes
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

// === MCP Session ===

/** An active MCP client session. */
export interface McpSession {
	sessionId: string;
	agentName: string;
	capability: string | null;
	projectId: string;
	connectedAt: string;
	lastMcpCallAt: string;
	/** SSE stream controller for pushing notifications. */
	sseController: ReadableStreamDefaultController<Uint8Array> | null;
}

// === MCP Server State File ===

/** State persisted to .overstory/mcp-server.json */
export interface McpServerState {
	pid: number;
	port: number;
	startedAt: string;
	url: string;
}

// === Tool Response Types ===

/** Response from the await_work tool. */
export interface AwaitWorkResponse {
	timedOut: boolean;
	messages: AwaitWorkMessage[];
	transitions: AwaitWorkTransition[];
	instruction: string;
}

export interface AwaitWorkMessage {
	id: string;
	from: string;
	subject: string;
	body: string;
	type: string;
	priority: string;
	createdAt: string;
}

export interface AwaitWorkTransition {
	taskId: string;
	fromState: string;
	toState: string;
	signal: string;
	triggeredBy: string;
}

/** Response from advance_task. */
export interface AdvanceTaskResponse {
	success: boolean;
	taskId: string;
	fromState: string;
	toState: string;
	message: string;
}

/** Response from get_task. */
export interface GetTaskResponse {
	task: {
		id: string;
		currentState: string;
		assignedAgent: string | null;
		reviewCycleCount: number;
		ticketId: string | null;
		updatedAt: string;
	};
}

/** Response from send_message. */
export interface SendMessageResponse {
	messageId: string;
	delivered: boolean;
}

/** Response from claim_task. */
export interface ClaimTaskResponse {
	success: boolean;
	taskId: string;
	newState: string;
}

/** Response from get_pending_work. */
export interface GetPendingWorkResponse {
	tasks: Array<{
		id: string;
		currentState: string;
		ticketId: string | null;
		updatedAt: string;
	}>;
}
