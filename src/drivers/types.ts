// src/drivers/types.ts
// AgentDriver interface: pluggable strategy for agent lifecycle management.
// Three implementations: ClaudeDriver, CodexBridgeDriver, CodexDaemonDriver.

import type { AgentRuntime, AgentSession, AgentState, OverlayConfig, OverstoryConfig } from "../types";

/** Context passed to the driver at spawn time. sling owns steps 1-11; driver handles 12+. */
export interface SpawnContext {
	config: OverstoryConfig;
	session: AgentSession;
	overlayConfig: OverlayConfig;
	worktreePath: string;
	branchName: string;
	tmuxSessionName: string;
	runId: string;
}

/** Result of a successful spawn */
export interface SpawnResult {
	pid: number;
	/** Opaque handle the driver can stash per-agent metadata in */
	driverState?: Record<string, unknown>;
}

/** Real-time snapshot of a running agent */
export interface AgentInspection {
	state: AgentState;
	lastActivity: string;
	recentToolCalls?: Array<{ name: string; startedAt: string; durationMs?: number }>;
	/** Only for tmux-based drivers (ClaudeDriver, CodexBridgeDriver) */
	tmuxCapture?: string;
	/** Only for codex-based drivers */
	activeThreadId?: string;
	/** Only for codex-based drivers */
	tokenUsage?: { input: number; output: number; total: number };
}

/** Options for nudge delivery */
export interface NudgeOptions {
	/** Skip debounce check (required for watchdog escalation nudges) */
	force?: boolean;
}

/** Nudge delivery result — preserves watchdog telemetry contract */
export interface NudgeResult {
	delivered: boolean;
	reason?: string;
}

/**
 * Pluggable agent lifecycle driver.
 *
 * sling handles shared setup (config, validation, worktree, overlay, identity,
 * session recording). The driver handles runtime-specific operations: spawning
 * the agent process, nudging, steering, inspecting, and shutting down.
 */
export interface AgentDriver {
	/** Human-readable name for this driver */
	readonly name: string;

	/** Launch an agent. sling handles steps 1-11; driver handles step 12+. */
	spawn(ctx: SpawnContext): Promise<SpawnResult>;

	/** Indirect: wake agent and have it check mail.
	 *  Returns NudgeResult with delivery status for watchdog telemetry. */
	nudge(agentName: string, message: string, from: string, opts?: NudgeOptions): Promise<NudgeResult>;

	/** Direct: inject a message into the agent's active turn/session.
	 *  Returns true if delivered, false if no active turn (caller should fall back to mail). */
	steer(agentName: string, input: string): Promise<boolean>;

	/** Get detailed runtime state for inspect/dashboard */
	inspect(agentName: string): Promise<AgentInspection>;

	/** Request graceful shutdown of an agent */
	shutdown(agentName: string): Promise<void>;

	/** Clean up driver-level resources (connections, daemon handles).
	 *  For CodexDaemonDriver: no-op (daemon lifecycle is independent).
	 *  For ClaudeDriver/CodexBridgeDriver: no-op (nothing to clean up). */
	close(): Promise<void>;
}
