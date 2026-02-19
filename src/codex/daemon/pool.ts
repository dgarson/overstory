// src/codex/daemon/pool.ts
// AgentPool: manages a collection of daemon-side Codex agent RPC connections.
import { randomUUID } from "node:crypto";
import { AgentError } from "../../errors.ts";
import type { RpcClient } from "../rpc-client.ts";
import type { BridgeConfig } from "../types.ts";

export interface ManagedAgent {
	config: BridgeConfig;
	rpc: RpcClient;
	threadId: string;
	activeTurnId: string | null;
	state: "booting" | "working" | "completed" | "failed";
}

export interface AgentPoolDeps {
	createRpcClient: (url: string) => Promise<RpcClient>;
}

export interface AgentPool {
	add(config: BridgeConfig): Promise<void>;
	get(name: string): ManagedAgent | undefined;
	steer(name: string, input: string): Promise<boolean>;
	nudge(
		name: string,
		message: string,
		force?: boolean,
	): Promise<{ delivered: boolean; reason?: string }>;
	remove(name: string): Promise<void>;
	names(): string[];
	drain(): Promise<void>;
}

export function createAgentPool(deps: AgentPoolDeps): AgentPool {
	const agents = new Map<string, ManagedAgent>();

	return {
		async add(config: BridgeConfig): Promise<void> {
			if (agents.has(config.agentName)) {
				throw new AgentError(`Agent already registered in pool: ${config.agentName}`, {
					agentName: config.agentName,
				});
			}
			const rpc = await deps.createRpcClient(config.serverUrl);
			agents.set(config.agentName, {
				config,
				rpc,
				threadId: randomUUID(),
				activeTurnId: null,
				state: "booting",
			});
		},

		get(name: string): ManagedAgent | undefined {
			return agents.get(name);
		},

		async steer(name: string, input: string): Promise<boolean> {
			const agent = agents.get(name);
			if (agent === undefined || agent.activeTurnId === null) {
				return false;
			}
			await agent.rpc.request("agent/steer", { input, turnId: agent.activeTurnId });
			return true;
		},

		async nudge(
			name: string,
			message: string,
			force?: boolean,
		): Promise<{ delivered: boolean; reason?: string }> {
			const agent = agents.get(name);
			if (agent === undefined) {
				return { delivered: false, reason: "agent not found" };
			}
			if (agent.activeTurnId === null) {
				return { delivered: false, reason: "no active turn" };
			}
			try {
				await agent.rpc.request("agent/nudge", {
					message,
					turnId: agent.activeTurnId,
					force: force ?? false,
				});
				return { delivered: true };
			} catch (err) {
				const reason = err instanceof Error ? err.message : String(err);
				return { delivered: false, reason };
			}
		},

		async remove(name: string): Promise<void> {
			const agent = agents.get(name);
			if (agent === undefined) {
				return;
			}
			agent.rpc.close();
			agents.delete(name);
		},

		names(): string[] {
			return Array.from(agents.keys());
		},

		async drain(): Promise<void> {
			const namesToRemove = Array.from(agents.keys());
			await Promise.all(
				namesToRemove.map(async (name) => {
					const agent = agents.get(name);
					if (agent !== undefined) {
						agent.rpc.close();
						agents.delete(name);
					}
				}),
			);
		},
	};
}
