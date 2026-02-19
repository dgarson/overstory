/**
 * ClaudeDriver: agent lifecycle driver for Claude Code agents.
 *
 * Implements AgentDriver for the "claude" runtime. Handles:
 * - Writing overlay (CLAUDE.md) to worktree
 * - Deploying hooks config to worktree
 * - Creating a tmux session running `claude --model ... --dangerously-skip-permissions`
 * - Sending the startup beacon via tmux send-keys
 * - Nudging/steering agents via tmux send-keys
 * - Inspecting agent state (placeholder — full impl in later tasks)
 * - Shutting down agents via tmux kill-session
 *
 * Logic extracted from:
 * - sling.ts lines 445-604 (overlay write, hooks deploy, createSession, beacon send)
 * - nudge.ts lines 326-344 (nudgeClaudeAgent)
 */

import type { OverlayConfig } from "../types.ts";
import type {
	AgentDriver,
	AgentInspection,
	NudgeOptions,
	NudgeResult,
	SpawnContext,
	SpawnResult,
} from "./types.ts";

// Re-export SpawnContext so tests can import from this module directly
export type { SpawnContext } from "./types.ts";

/** Dependency interface for ClaudeDriver — all tmux ops are injectable for testing. */
export interface ClaudeDriverDeps {
	/**
	 * Create a new tmux session running the given command.
	 * @returns PID of the pane process
	 */
	createSession: (
		name: string,
		cwd: string,
		cmd: string,
		env?: Record<string, string>,
	) => Promise<number>;

	/**
	 * Send text to a tmux session via send-keys. An empty string sends Enter.
	 */
	sendKeys: (session: string, text: string) => Promise<void>;

	/**
	 * Check if a tmux session is alive.
	 * Optional — if absent, the driver assumes the session is alive.
	 */
	isSessionAlive?: (session: string) => Promise<boolean>;

	/**
	 * Write the agent overlay (CLAUDE.md) to the worktree.
	 * Signature matches agents/overlay.ts#writeOverlay.
	 */
	writeOverlay: (
		worktreePath: string,
		config: OverlayConfig,
		canonicalRoot: string,
	) => Promise<void>;

	/**
	 * Deploy hooks config (settings.local.json) to the worktree.
	 * Signature matches agents/hooks-deployer.ts#deployHooks.
	 */
	deployHooks: (worktreePath: string, agentName: string, capability?: string) => Promise<void>;
}

/**
 * Delay between createSession and sending the beacon.
 * Matches sling.ts line 589: allow Claude Code's TUI to initialize.
 */
const BEACON_PRE_DELAY_MS = 3_000;

/**
 * Delay between beacon and follow-up Enter.
 * Matches sling.ts line 603 (overstory-yhv6 workaround).
 */
const BEACON_POST_DELAY_MS = 500;

/**
 * Number of send-keys retries for nudge delivery.
 * Matches nudge.ts MAX_RETRIES = 3.
 */
const MAX_RETRIES = 3;

/**
 * Delay between nudge retry attempts.
 * Matches nudge.ts RETRY_DELAY_MS = 500.
 */
const RETRY_DELAY_MS = 500;

/**
 * Attempt to send a message to a tmux session with retry logic.
 * Extracted from nudge.ts sendNudgeWithRetry (lines 182-200).
 *
 * @returns true if delivered, false if all retries failed
 */
async function sendWithRetry(
	sendKeys: ClaudeDriverDeps["sendKeys"],
	session: string,
	message: string,
): Promise<boolean> {
	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		try {
			await sendKeys(session, message);
			// Follow-up Enter to ensure submission (overstory-t62v / overstory-yhv6).
			await Bun.sleep(BEACON_POST_DELAY_MS);
			await sendKeys(session, "");
			return true;
		} catch {
			if (attempt < MAX_RETRIES) {
				await Bun.sleep(RETRY_DELAY_MS);
			}
		}
	}
	return false;
}

/**
 * Claude Code agent lifecycle driver.
 *
 * Extracts Claude-specific spawn and nudge logic from sling.ts and nudge.ts
 * into a reusable class implementing the AgentDriver interface.
 */
export class ClaudeDriver implements AgentDriver {
	readonly name = "claude";

	constructor(private readonly deps: ClaudeDriverDeps) {}

	/**
	 * Spawn a Claude Code agent.
	 *
	 * Extracted from sling.ts steps 8b, 9, 12e, 13b-c (lines 445-605):
	 *   - 8b: writeOverlay (line 446)
	 *   - 9:  deployHooks  (line 453)
	 *   - 12e: createSession with `claude --model ... --dangerously-skip-permissions` (lines 529-533)
	 *   - 13b: sleep + sendKeys beacon (lines 589-597)
	 *   - 13c: sleep + sendKeys follow-up Enter (lines 599-604)
	 */
	async spawn(ctx: SpawnContext): Promise<SpawnResult> {
		const { config, session, overlayConfig, worktreePath, tmuxSessionName } = ctx;
		// model and beaconText are optional in SpawnContext (CodexBridgeDriver doesn't use them)
		// but are required for ClaudeDriver's tmux launch path. Fall back to safe defaults.
		const model = ctx.model ?? "claude-opus-4-5";
		const beaconText = ctx.beaconText ?? "";

		// Step 8b: Write the Claude overlay (CLAUDE.md) to the worktree.
		// Extracted from sling.ts line 446.
		await this.deps.writeOverlay(worktreePath, overlayConfig, config.project.root);

		// Step 9: Deploy capability-specific hooks config to the worktree.
		// Extracted from sling.ts line 453.
		await this.deps.deployHooks(worktreePath, session.agentName, session.capability);

		// Step 12e: Spawn claude in interactive mode inside a tmux session.
		// Extracted from sling.ts lines 529-533.
		const claudeCmd = `claude --model ${model} --dangerously-skip-permissions`;
		const pid = await this.deps.createSession(tmuxSessionName, worktreePath, claudeCmd, {
			OVERSTORY_AGENT_NAME: session.agentName,
			OVERSTORY_WORKTREE_PATH: worktreePath,
		});

		// Step 13b: Allow Claude Code's TUI to initialize before sending input.
		// Extracted from sling.ts lines 588-597.
		await Bun.sleep(BEACON_PRE_DELAY_MS);
		await this.deps.sendKeys(tmuxSessionName, beaconText);

		// Step 13c: Follow-up Enter to ensure beacon submission.
		// Workaround for overstory-yhv6: TUI may consume the first Enter during init.
		// Extracted from sling.ts lines 599-604.
		await Bun.sleep(BEACON_POST_DELAY_MS);
		await this.deps.sendKeys(tmuxSessionName, "");

		return { pid };
	}

	/**
	 * Nudge a Claude Code agent via tmux send-keys.
	 *
	 * Extracted from nudge.ts nudgeClaudeAgent (lines 326-344):
	 * - Check if the tmux session is alive
	 * - Send the message with retry logic
	 * - Return NudgeResult with delivery status
	 *
	 * The `opts.force` flag in the AgentDriver contract is for debounce bypass.
	 * Debounce state management lives in nudge.ts; the driver doesn't maintain
	 * debounce state — it just delivers (or fails to deliver) the message.
	 * isSessionAlive is always checked regardless of force.
	 */
	async nudge(
		agentName: string,
		message: string,
		_from: string,
		_opts?: NudgeOptions,
	): Promise<NudgeResult> {
		// Resolve the tmux session name. For ClaudeDriver, the session is named
		// `overstory-{projectName}-{agentName}` but the caller is responsible
		// for knowing the session. We accept agentName and use it directly —
		// the nudge command resolves the full session name from SessionStore.
		// Here, agentName IS the tmux session name for direct driver calls.
		const tmuxSession = agentName;

		// Check session liveness — extracted from nudge.ts line 332.
		const isAlive = this.deps.isSessionAlive ? await this.deps.isSessionAlive(tmuxSession) : true; // Assume alive if not provided

		if (!isAlive) {
			return {
				delivered: false,
				reason: `Tmux session "${tmuxSession}" is not alive`,
			};
		}

		// Deliver the message with retry — extracted from nudge.ts lines 337-340.
		const delivered = await sendWithRetry(this.deps.sendKeys, tmuxSession, message);
		if (!delivered) {
			return {
				delivered: false,
				reason: `Failed to send after ${MAX_RETRIES} attempts`,
			};
		}

		return { delivered: true };
	}

	/**
	 * Steer a Claude Code agent by injecting a message into its active session.
	 *
	 * For Claude agents, steer and nudge are equivalent — both use tmux send-keys.
	 * Returns true if delivered.
	 */
	async steer(agentName: string, input: string): Promise<boolean> {
		const result = await this.nudge(agentName, input, "steer");
		return result.delivered;
	}

	/**
	 * Inspect a Claude Code agent's runtime state.
	 *
	 * Placeholder — full implementation (tmux capture-pane, event store query)
	 * will be added in later tasks.
	 */
	async inspect(_agentName: string): Promise<AgentInspection> {
		return {
			state: "working",
			lastActivity: new Date().toISOString(),
		};
	}

	/**
	 * Request graceful shutdown of a Claude Code agent by killing its tmux session.
	 *
	 * Uses tmux kill-session. No-op if the session doesn't exist.
	 */
	async shutdown(agentName: string): Promise<void> {
		try {
			const proc = Bun.spawn(["tmux", "kill-session", "-t", agentName], {
				stdout: "pipe",
				stderr: "pipe",
			});
			await proc.exited;
		} catch {
			// Best-effort: session may already be gone
		}
	}

	/**
	 * Clean up driver-level resources.
	 *
	 * ClaudeDriver has no persistent connections or handles, so this is a no-op.
	 */
	async close(): Promise<void> {
		// No-op for ClaudeDriver
	}
}

/**
 * Build a ClaudeDriver backed by real tmux operations.
 *
 * Imports real implementations from worktree/tmux.ts and agents/*.ts.
 * Use this factory in production code (sling.ts, nudge.ts).
 * Use the ClaudeDriver constructor with DI deps in tests.
 */
export async function createClaudeDriver(): Promise<ClaudeDriver> {
	const { createSession, sendKeys, isSessionAlive } = await import("../worktree/tmux.ts");
	const { writeOverlay } = await import("../agents/overlay.ts");
	const { deployHooks } = await import("../agents/hooks-deployer.ts");

	return new ClaudeDriver({
		createSession,
		sendKeys,
		isSessionAlive,
		writeOverlay,
		deployHooks,
	});
}
