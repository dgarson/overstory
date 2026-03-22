import type { AgentDriverKind, AgentRuntime, MailMessage } from "../types.ts";

export type ControlNotificationStatus = "pending" | "leased" | "acked";

export interface ControlAgentRegistration {
	agentName: string;
	sessionId: string | null;
	runtime: AgentRuntime;
	driverKind: AgentDriverKind;
	tmuxSession: string | null;
	pid: number | null;
}

export interface ControlAgent {
	agentName: string;
	sessionId: string | null;
	runtime: AgentRuntime;
	driverKind: AgentDriverKind;
	tmuxSession: string | null;
	pid: number | null;
	registeredAt: string;
	lastSeenAt: string;
	lastToolAt: string | null;
	toolDepth: number;
	ioEpoch: number;
	lastNudgeAt: string | null;
	nudgeLockToken: string | null;
	nudgeLockExpiresAt: string | null;
}

export interface ControlNotification {
	id: string;
	messageId: string | null;
	toAgent: string;
	fromAgent: string;
	kind: string;
	subject: string;
	body: string;
	priority: MailMessage["priority"];
	payload: string | null;
	createdAt: string;
	status: ControlNotificationStatus;
	leasedBy: string | null;
	leaseExpiresAt: string | null;
	ackedAt: string | null;
	nudgeCount: number;
	lastNudgedAt: string | null;
	lastError: string | null;
}

export interface EnqueueNotificationInput {
	messageId?: string | null;
	toAgent: string;
	fromAgent: string;
	kind: string;
	subject: string;
	body: string;
	priority: MailMessage["priority"];
	payload?: string | null;
}

export interface AwaitWorkResult {
	timedOut: boolean;
	notifications: ControlNotification[];
}

export interface ControlServerState {
	pid: number;
	port: number;
	url: string;
	token: string;
	startedAt: string;
}
