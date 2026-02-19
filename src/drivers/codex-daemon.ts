// src/drivers/codex-daemon.ts
// CodexDaemonDriver: HTTP client driver that communicates with the daemon sidecar
// via REST endpoints using bearer token auth.
//
// The daemon sidecar runs as a long-lived process and manages a pool of Codex agents.
// This driver translates AgentDriver calls into HTTP requests to the daemon's REST API.

import type { DaemonState } from "../codex/daemon/lifecycle.ts";
import type {
	AgentDriver,
	AgentInspection,
	NudgeOptions,
	NudgeResult,
	SpawnContext,
	SpawnResult,
} from "./types.ts";

export interface CodexDaemonDriverOpts {
	daemonUrl: string;
	token: string;
	/** Injected for testing — defaults to undefined (not used in spawn path in tests) */
	ensureDaemonRunning?: (overstoryDir: string) => Promise<DaemonState>;
}

/**
 * HTTP client driver for the daemon sidecar.
 *
 * Communicates with the daemon REST API:
 *   POST   /agents               — spawn agent
 *   POST   /agents/:name/nudge   — nudge agent
 *   POST   /agents/:name/steer   — steer agent
 *   GET    /agents/:name         — inspect agent
 *   DELETE /agents/:name         — shutdown agent
 *
 * Bearer token auth is required for all mutation endpoints.
 */
export class CodexDaemonDriver implements AgentDriver {
	readonly name = "codex-daemon" as const;

	private daemonUrl: string;
	private token: string;
	private readonly _ensureDaemonRunning:
		| ((overstoryDir: string) => Promise<DaemonState>)
		| undefined;

	constructor(opts: CodexDaemonDriverOpts) {
		this.daemonUrl = opts.daemonUrl;
		this.token = opts.token;
		this._ensureDaemonRunning = opts.ensureDaemonRunning;
	}

	private authHeaders(): Record<string, string> {
		return {
			"Content-Type": "application/json",
			Authorization: `Bearer ${this.token}`,
		};
	}

	/**
	 * Spawn an agent via the daemon.
	 *
	 * If ensureDaemonRunning is provided (e.g. production code), calls it first
	 * to start the daemon if needed and refresh the URL/token from the returned state.
	 * POSTs a BridgeConfig to /agents. The daemon returns 201 with no body (per server.ts),
	 * so pid is always 0.
	 */
	async spawn(ctx: SpawnContext): Promise<SpawnResult> {
		const overstoryDir = `${ctx.config.project.root}/.overstory`;

		if (this._ensureDaemonRunning !== undefined) {
			const state = await this._ensureDaemonRunning(overstoryDir);
			this.daemonUrl = state.url;
			this.token = state.token;
		}

		// Build the BridgeConfig from SpawnContext fields (mirrors CodexBridgeDriver.spawn)
		const bridgeConfig = {
			agentName: ctx.session.agentName,
			worktreePath: ctx.worktreePath,
			branchName: ctx.branchName,
			beadId: ctx.session.beadId,
			capability: ctx.session.capability,
			parentAgent: ctx.session.parentAgent ?? null,
			depth: ctx.session.depth,
			runId: ctx.runId,
			sessionId: ctx.session.id,
			serverUrl: "",
			model: ctx.model ?? "claude-opus-4-5",
			compactionThreshold: 0,
			maxDeltaBufferBytes: 0,
			approvalTimeoutMs: 0,
			fileScope: ctx.overlayConfig.fileScope,
			projectRoot: ctx.config.project.root,
			maxReconnectAttempts: 0,
			reconnectBaseDelayMs: 0,
		};

		const res = await fetch(`${this.daemonUrl}/agents`, {
			method: "POST",
			headers: this.authHeaders(),
			body: JSON.stringify(bridgeConfig),
		});

		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Daemon spawn failed (${res.status}): ${text}`);
		}

		return { pid: 0 };
	}

	/**
	 * Nudge an agent via the daemon.
	 * POSTs to /agents/:name/nudge with message and optional force flag.
	 * Returns the NudgeResult from the daemon, or delivered:false on HTTP error.
	 */
	async nudge(
		agentName: string,
		message: string,
		_from: string,
		opts?: NudgeOptions,
	): Promise<NudgeResult> {
		const res = await fetch(`${this.daemonUrl}/agents/${agentName}/nudge`, {
			method: "POST",
			headers: this.authHeaders(),
			body: JSON.stringify({ message, force: opts?.force }),
		});
		if (!res.ok) {
			return { delivered: false, reason: `HTTP ${res.status}` };
		}
		return (await res.json()) as NudgeResult;
	}

	/**
	 * Steer an agent by injecting input directly into its active turn.
	 * POSTs to /agents/:name/steer. Returns false on HTTP error.
	 */
	async steer(agentName: string, input: string): Promise<boolean> {
		const res = await fetch(`${this.daemonUrl}/agents/${agentName}/steer`, {
			method: "POST",
			headers: this.authHeaders(),
			body: JSON.stringify({ input }),
		});
		if (!res.ok) return false;
		const body = (await res.json()) as { delivered: boolean };
		return body.delivered;
	}

	/**
	 * Inspect an agent's runtime state via GET /agents/:name.
	 * Throws if the daemon returns an error status.
	 */
	async inspect(agentName: string): Promise<AgentInspection> {
		const res = await fetch(`${this.daemonUrl}/agents/${agentName}`, {
			headers: { Authorization: `Bearer ${this.token}` },
		});
		if (!res.ok) {
			throw new Error(`Inspect failed (${res.status}): ${agentName}`);
		}
		return (await res.json()) as AgentInspection;
	}

	/**
	 * Request graceful shutdown of an agent via DELETE /agents/:name.
	 * Best-effort: ignores HTTP errors since the agent may already be gone.
	 */
	async shutdown(agentName: string): Promise<void> {
		await fetch(`${this.daemonUrl}/agents/${agentName}`, {
			method: "DELETE",
			headers: this.authHeaders(),
		});
	}

	/**
	 * No-op. Daemon lifetime is independent of driver instances.
	 * Daemon is stopped by: overstory daemon stop, overstory clean, or self-drain.
	 */
	async close(): Promise<void> {}
}
