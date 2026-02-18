// src/codex/types.ts
// All Codex App Server protocol types. Zero runtime code — types only.

/** JSON-RPC 2.0 base types */
export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: number | string;
	method: string;
	params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: number | string;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: Record<string, unknown>;
}

/** Thread lifecycle */
export interface ThreadStartParams {
	instructions?: string;
	model?: string;
	cwd?: string;
	sandboxPolicy?: SandboxPolicy;
	approvalPolicy?: "on-request" | "unless-allowed" | "never";
}

export interface ThreadStartResult {
	thread: { id: string };
}

export interface SandboxPolicy {
	type: "dangerFullAccess" | "readOnly" | "workspaceWrite";
	writableRoots?: string[];
	networkAccess?: boolean;
}

/** Turn lifecycle */
export interface TurnStartParams {
	threadId: string;
	input: string;
}

export interface TurnSteerParams {
	threadId: string;
	turnId: string;
	input: string;
}

export interface TurnCompletedParams {
	threadId: string;
	turnId: string;
	status: "completed" | "failed" | "interrupted" | "cancelled";
	error?: string;
}

/** Approval workflow */
export type ApprovalItemType = "commandExecution" | "fileChange";

export interface ApprovalRequest {
	threadId: string;
	turnId: string;
	itemId: string;
	type: ApprovalItemType;
	command?: string;
	changes?: FileChange[];
}

export interface FileChange {
	path: string;
	kind: "add" | "update" | "delete";
	content?: string;
}

export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export interface ApprovalResponse {
	decision: ApprovalDecision;
	reason?: string;
}

/** Item events */
export type CodexItemType =
	| "commandExecution"
	| "fileChange"
	| "agentMessage"
	| "reasoning"
	| "mcpToolCall"
	| "webSearch"
	| "contextCompaction";

export interface ItemStartedParams {
	threadId: string;
	turnId: string;
	itemId: string;
	itemType: CodexItemType;
	data?: Record<string, unknown>;
}

export interface ItemCompletedParams {
	threadId: string;
	turnId: string;
	itemId: string;
	itemType: CodexItemType;
	status: "completed" | "failed" | "cancelled";
	data?: Record<string, unknown>;
}

export interface OutputDeltaParams {
	threadId: string;
	turnId: string;
	itemId: string;
	delta: string;
}

/** Token usage */
export interface TokenUsageParams {
	threadId: string;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	contextWindowSize: number;
}

/** Delta buffering */
export interface DeltaBuffer {
	itemId: string;
	itemType: CodexItemType;
	startedAt: string;
	outputChunks: string[];
	totalBytes: number;
}

/** Bridge configuration (passed as env vars) */
export interface BridgeConfig {
	agentName: string;
	worktreePath: string;
	branchName: string;
	beadId: string;
	capability: string;
	parentAgent: string | null;
	depth: number;
	runId: string | null;
	sessionId: string;
	serverUrl: string;
	model: string;
	compactionThreshold: number;
	maxDeltaBufferBytes: number;
	approvalTimeoutMs: number;
	fileScope: string[];
	projectRoot: string;
}

/** Server state file (.overstory/codex-server.json) */
export interface CodexServerState {
	pid: number;
	port: number;
	startedAt: string;
	url: string;
}
