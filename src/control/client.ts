import { join } from "node:path";
import { loadConfig } from "../config.ts";
import type { ControlConfig } from "../types.ts";
import { readControlServerState, startControlServer } from "./server.ts";
import type {
	AwaitWorkResult,
	ControlAgentRegistration,
	ControlNotification,
	ControlServerState,
	EnqueueNotificationInput,
} from "./types.ts";

interface PostResult<T> {
	ok: boolean;
	data: T | null;
}

export interface ControlClient {
	available(): Promise<boolean>;
	registerAgent(reg: ControlAgentRegistration): Promise<boolean>;
	markOffline(agentName: string): Promise<boolean>;
	heartbeat(agentName: string): Promise<boolean>;
	toolLifecycle(agentName: string, event: "enter" | "exit"): Promise<boolean>;
	enqueue(input: EnqueueNotificationInput): Promise<{ notificationId: string | null }>;
	safeNudge(agentName: string, message: string): Promise<{
		delivered: boolean;
		deferred: boolean;
		reason?: string | null;
	} | null>;
	drain(agentName: string, maxItems?: number, leaseOwner?: string): Promise<{
		notifications: ControlNotification[];
		leaseOwner: string;
	} | null>;
	awaitWork(agentName: string, timeoutMs: number, maxItems?: number): Promise<{
		result: AwaitWorkResult;
		leaseOwner: string;
	} | null>;
	ack(agentName: string, leaseOwner: string, ids: string[]): Promise<boolean>;
	release(agentName: string, leaseOwner: string, ids: string[]): Promise<boolean>;
}

class HttpControlClient implements ControlClient {
	private readonly overstoryDir: string;
	private state: ControlServerState | null = null;
	private readonly ready: Promise<void>;

	constructor(overstoryDir: string) {
		this.overstoryDir = overstoryDir;
		this.ready = this.refreshState();
	}

	private async refreshState(): Promise<void> {
		this.state = await readControlServerState(this.overstoryDir);
	}

	private async post<T>(
		path: string,
		payload: Record<string, unknown>,
	): Promise<PostResult<T>> {
		await this.ready;
		if (!this.state) {
			await this.refreshState();
		}
		if (!this.state) {
			return { ok: false, data: null };
		}

		try {
			const resp = await fetch(`${this.state.url}${path}`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-overstory-control-token": this.state.token,
				},
				body: JSON.stringify(payload),
			});
			if (!resp.ok) {
				// Refresh once in case daemon restarted and token rotated.
				await this.refreshState();
				return { ok: false, data: null };
			}
			const data = (await resp.json()) as T;
			return { ok: true, data };
		} catch {
			return { ok: false, data: null };
		}
	}

	async available(): Promise<boolean> {
		await this.ready;
		if (!this.state) return false;
		try {
			const resp = await fetch(`${this.state.url}/health`, {
				method: "GET",
				headers: {
					"x-overstory-control-token": this.state.token,
				},
			});
			return resp.ok;
		} catch {
			return false;
		}
	}

	async registerAgent(reg: ControlAgentRegistration): Promise<boolean> {
		const result = await this.post<{ ok: boolean }>("/register-agent", { ...reg });
		return result.ok;
	}

	async markOffline(agentName: string): Promise<boolean> {
		const result = await this.post<{ ok: boolean }>("/mark-offline", { agentName });
		return result.ok;
	}

	async heartbeat(agentName: string): Promise<boolean> {
		const result = await this.post<{ ok: boolean }>("/heartbeat", { agentName });
		return result.ok;
	}

	async toolLifecycle(agentName: string, event: "enter" | "exit"): Promise<boolean> {
		const result = await this.post<{ ok: boolean }>("/tool-lifecycle", { agentName, event });
		return result.ok;
	}

	async enqueue(input: EnqueueNotificationInput): Promise<{ notificationId: string | null }> {
		const result = await this.post<{ notificationId?: string }>("/enqueue", {
			messageId: input.messageId ?? null,
			toAgent: input.toAgent,
			fromAgent: input.fromAgent,
			kind: input.kind,
			subject: input.subject,
			body: input.body,
			priority: input.priority,
			payload: input.payload ?? null,
		});
		if (!result.ok || !result.data) {
			return { notificationId: null };
		}
		return {
			notificationId:
				typeof result.data.notificationId === "string" ? result.data.notificationId : null,
		};
	}

	async safeNudge(agentName: string, message: string): Promise<{
		delivered: boolean;
		deferred: boolean;
		reason?: string | null;
	} | null> {
		const result = await this.post<{
			delivered?: boolean;
			deferred?: boolean;
			reason?: string | null;
		}>("/safe-nudge", { agentName, message });
		if (!result.ok || !result.data) return null;
		return {
			delivered: result.data.delivered === true,
			deferred: result.data.deferred === true,
			reason: result.data.reason ?? null,
		};
	}

	async drain(agentName: string, maxItems = 20, leaseOwner?: string): Promise<{
		notifications: ControlNotification[];
		leaseOwner: string;
	} | null> {
		const result = await this.post<{ notifications?: ControlNotification[]; leaseOwner?: string }>(
			"/drain",
			{
				agentName,
				maxItems,
				leaseOwner: leaseOwner ?? null,
			},
		);
		if (!result.ok || !result.data || typeof result.data.leaseOwner !== "string") {
			return null;
		}
		return {
			notifications: Array.isArray(result.data.notifications) ? result.data.notifications : [],
			leaseOwner: result.data.leaseOwner,
		};
	}

	async awaitWork(agentName: string, timeoutMs: number, maxItems = 20): Promise<{
		result: AwaitWorkResult;
		leaseOwner: string;
	} | null> {
		const result = await this.post<{
			timedOut?: boolean;
			notifications?: ControlNotification[];
			leaseOwner?: string;
		}>("/await-work", {
			agentName,
			timeoutMs,
			maxItems,
		});
		if (!result.ok || !result.data || typeof result.data.leaseOwner !== "string") {
			return null;
		}
		return {
			leaseOwner: result.data.leaseOwner,
			result: {
				timedOut: result.data.timedOut === true,
				notifications: Array.isArray(result.data.notifications)
					? result.data.notifications
					: [],
			},
		};
	}

	async ack(agentName: string, leaseOwner: string, ids: string[]): Promise<boolean> {
		const result = await this.post<{ ok: boolean }>("/ack", {
			agentName,
			leaseOwner,
			ids,
		});
		return result.ok;
	}

	async release(agentName: string, leaseOwner: string, ids: string[]): Promise<boolean> {
		const result = await this.post<{ ok: boolean }>("/release", {
			agentName,
			leaseOwner,
			ids,
		});
		return result.ok;
	}
}

export function createControlClient(overstoryDir: string): ControlClient {
	return new HttpControlClient(overstoryDir);
}

export async function createControlClientForProject(projectRoot: string): Promise<ControlClient | null> {
	const config = await loadConfig(projectRoot);
	if (!config.control.enabled) return null;
	return createControlClient(join(config.project.root, ".overstory"));
}

export async function ensureControlServerForProject(projectRoot: string): Promise<ControlServerState | null> {
	const config = await loadConfig(projectRoot);
	if (!config.control.enabled) return null;
	return ensureControlServer(config.project.root, join(config.project.root, ".overstory"), config.control);
}

export async function ensureControlServer(
	projectRoot: string,
	overstoryDir: string,
	control: ControlConfig,
): Promise<ControlServerState | null> {
	if (!control.enabled) return null;
	try {
		return await startControlServer(projectRoot, overstoryDir, control.port, {
			waitForHealth: false,
		});
	} catch {
		return null;
	}
}
