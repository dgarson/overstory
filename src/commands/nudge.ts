/**
 * CLI command: overstory nudge <agent-name> [message]
 *
 * Sends a text nudge to an agent's interactive Claude Code session via
 * tmux send-keys. Used to notify agents of new mail or relay urgent
 * instructions mid-conversation.
 *
 * For Codex agents (runtime === "codex"), sends a high-priority mail
 * message and wakes the bridge process via SIGUSR1 instead of tmux.
 *
 * Includes retry logic (3 attempts) and debounce (500ms) to prevent
 * rapid-fire nudges to the same agent.
 */

import { join } from "node:path";
import { AgentError, ValidationError } from "../errors.ts";
import { createEventStore } from "../events/store.ts";
import { createMailClient } from "../mail/client.ts";
import { createMailStore } from "../mail/store.ts";
import { openSessionStore } from "../sessions/compat.ts";
import type { AgentRuntime, EventStore } from "../types.ts";
import { isSessionAlive, sendKeys } from "../worktree/tmux.ts";

const DEFAULT_MESSAGE = "Check your mail inbox for new messages.";
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;
const DEBOUNCE_MS = 500;

/**
 * Parse a named flag value from args.
 */
function getFlag(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	if (idx === -1 || idx + 1 >= args.length) {
		return undefined;
	}
	return args[idx + 1];
}

/** Boolean flags that do NOT consume the next arg. */
const BOOLEAN_FLAGS = new Set(["--json", "--force", "--help", "-h"]);

/**
 * Extract positional arguments, skipping flag-value pairs.
 */
function getPositionalArgs(args: string[]): string[] {
	const positional: string[] = [];
	let i = 0;
	while (i < args.length) {
		const arg = args[i];
		if (arg?.startsWith("-")) {
			if (BOOLEAN_FLAGS.has(arg)) {
				i += 1;
			} else {
				i += 2;
			}
		} else {
			if (arg !== undefined) {
				positional.push(arg);
			}
			i += 1;
		}
	}
	return positional;
}

/**
 * Load the orchestrator's registered tmux session name.
 *
 * Written by `overstory prime` at SessionStart when the orchestrator
 * is running inside tmux. Enables agents to nudge the orchestrator
 * even though it's not tracked in the SessionStore.
 */
async function loadOrchestratorTmuxSession(projectRoot: string): Promise<string | null> {
	const regPath = join(projectRoot, ".overstory", "orchestrator-tmux.json");
	const file = Bun.file(regPath);
	if (!(await file.exists())) {
		return null;
	}
	try {
		const text = await file.text();
		const reg = JSON.parse(text) as { tmuxSession?: string };
		return reg.tmuxSession ?? null;
	} catch {
		return null;
	}
}

/** Resolved information about a target agent for nudge delivery. */
interface ResolvedTarget {
	tmuxSession: string;
	runtime: AgentRuntime;
	bridgePid: number | null;
}

/**
 * Resolve the target session info for an agent.
 *
 * For regular agents, looks up the SessionStore.
 * For "orchestrator", falls back to the orchestrator-tmux.json registration
 * file written by `overstory prime`.
 *
 * Returns null if no active session is found.
 */
async function resolveTargetSession(
	projectRoot: string,
	agentName: string,
): Promise<ResolvedTarget | null> {
	const overstoryDir = join(projectRoot, ".overstory");
	const { store } = openSessionStore(overstoryDir);
	try {
		const session = store.getByName(agentName);
		if (session && session.state !== "zombie" && session.state !== "completed") {
			return {
				tmuxSession: session.tmuxSession,
				runtime: session.runtime ?? "claude",
				bridgePid: session.pid,
			};
		}
	} finally {
		store.close();
	}

	// Fallback for orchestrator: check orchestrator-tmux.json
	if (agentName === "orchestrator") {
		const tmuxSession = await loadOrchestratorTmuxSession(projectRoot);
		if (tmuxSession !== null) {
			return { tmuxSession, runtime: "claude", bridgePid: null };
		}
	}

	return null;
}

/**
 * Check debounce state for an agent. Returns true if a nudge was sent
 * within the debounce window and should be skipped.
 */
async function isDebounced(statePath: string, agentName: string): Promise<boolean> {
	const file = Bun.file(statePath);
	if (!(await file.exists())) {
		return false;
	}
	try {
		const text = await file.text();
		const state = JSON.parse(text) as Record<string, number>;
		const lastNudge = state[agentName];
		if (lastNudge === undefined) {
			return false;
		}
		return Date.now() - lastNudge < DEBOUNCE_MS;
	} catch {
		return false;
	}
}

/**
 * Record a nudge timestamp for debounce tracking.
 */
async function recordNudge(statePath: string, agentName: string): Promise<void> {
	let state: Record<string, number> = {};
	const file = Bun.file(statePath);
	if (await file.exists()) {
		try {
			const text = await file.text();
			state = JSON.parse(text) as Record<string, number>;
		} catch {
			// Corrupt state file — start fresh
		}
	}
	state[agentName] = Date.now();
	await Bun.write(statePath, `${JSON.stringify(state, null, "\t")}\n`);
}

/**
 * Send a nudge to an agent's tmux session with retry logic.
 *
 * @param tmuxSession - The tmux session name
 * @param message - The text to send
 * @returns true if the nudge was delivered, false if all retries failed
 */
async function sendNudgeWithRetry(tmuxSession: string, message: string): Promise<boolean> {
	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		try {
			await sendKeys(tmuxSession, message);
			// Follow-up Enter after a short delay to ensure submission.
			// Claude Code's TUI may consume the first Enter during re-render/focus
			// events, leaving text visible but unsubmitted (overstory-t62v).
			// Same workaround as sling.ts and coordinator.ts.
			await Bun.sleep(500);
			await sendKeys(tmuxSession, "");
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
 * Read the current run ID from current-run.txt, or null if no active run.
 */
async function readCurrentRunId(overstoryDir: string): Promise<string | null> {
	const path = join(overstoryDir, "current-run.txt");
	const file = Bun.file(path);
	if (!(await file.exists())) {
		return null;
	}
	try {
		const text = await file.text();
		const trimmed = text.trim();
		return trimmed.length > 0 ? trimmed : null;
	} catch {
		return null;
	}
}

/**
 * Fire-and-forget: record a nudge event to EventStore. Never throws.
 */
function recordNudgeEvent(
	eventStore: EventStore,
	opts: {
		runId: string | null;
		agentName: string;
		from: string;
		message: string;
		delivered: boolean;
	},
): void {
	try {
		eventStore.insert({
			runId: opts.runId,
			agentName: opts.agentName,
			sessionId: null,
			eventType: "custom",
			toolName: null,
			toolArgs: null,
			toolDurationMs: null,
			level: "info",
			data: JSON.stringify({
				type: "nudge",
				from: opts.from,
				message: opts.message,
				delivered: opts.delivered,
			}),
		});
	} catch {
		// Fire-and-forget: event recording must never break nudge delivery
	}
}

/**
 * Core nudge function. Exported for use by mail send auto-nudge.
 *
 * @param projectRoot - Absolute path to the project root
 * @param agentName - Name of the agent to nudge
 * @param message - Text to send (defaults to mail check prompt)
 * @param force - Skip debounce check
 * @returns Object with delivery status
 */
export async function nudgeAgent(
	projectRoot: string,
	agentName: string,
	message: string = DEFAULT_MESSAGE,
	force = false,
): Promise<{ delivered: boolean; reason?: string }> {
	let result: { delivered: boolean; reason?: string };

	// Resolve target session (SessionStore for agents, orchestrator-tmux.json for orchestrator)
	const target = await resolveTargetSession(projectRoot, agentName);

	if (!target) {
		result = { delivered: false, reason: `No active session for agent "${agentName}"` };
	} else {
		// Check debounce (unless forced)
		let debounced = false;
		if (!force) {
			const statePath = join(projectRoot, ".overstory", "nudge-state.json");
			debounced = await isDebounced(statePath, agentName);
		}

		if (debounced) {
			result = { delivered: false, reason: "Debounced: nudge sent too recently" };
		} else if (target.runtime === "codex") {
			// Codex agents don't have an interactive tmux session.
			// Send a high-priority mail message and wake the bridge via SIGUSR1.
			const overstoryDir = join(projectRoot, ".overstory");
			const mailDbPath = join(overstoryDir, "mail.db");
			const mailStore = createMailStore(mailDbPath);
			const mailClient = createMailClient(mailStore);
			try {
				mailClient.send({
					from: "orchestrator",
					to: agentName,
					subject: "nudge",
					body: message,
					type: "status",
					priority: "high",
				});
			} finally {
				mailClient.close();
			}
			// Wake bridge process so it picks up the mail immediately.
			// Read the bridge PID file (written by bridge.ts at startup) for the
			// actual bun process PID. Fall back to session PID if file doesn't exist.
			let bridgePid = target.bridgePid;
			try {
				const pidFile = Bun.file(join(overstoryDir, "agents", agentName, "bridge.pid"));
				if (await pidFile.exists()) {
					const pidFromFile = Number.parseInt((await pidFile.text()).trim(), 10);
					if (!Number.isNaN(pidFromFile)) {
						bridgePid = pidFromFile;
					}
				}
			} catch {
				// Fall back to session PID
			}
			// Validate PID is still alive before sending SIGUSR1 (C1: stale bridge PID).
			// process.kill(pid, 0) checks existence without sending a signal; it throws
			// ESRCH if the process doesn't exist, preventing us from signaling an
			// unrelated process that reused the PID.
			if (bridgePid !== null) {
				try {
					process.kill(bridgePid, 0);
				} catch {
					// Stale PID — fall back to session PID if it differs
					bridgePid =
						target.bridgePid !== null && target.bridgePid !== bridgePid ? target.bridgePid : null;
				}
			}
			if (bridgePid !== null) {
				try {
					process.kill(bridgePid, "SIGUSR1");
				} catch {
					// Bridge process may have already exited — not fatal
				}
			}
			// Record nudge for debounce tracking
			const statePath = join(projectRoot, ".overstory", "nudge-state.json");
			await recordNudge(statePath, agentName);
			result = { delivered: true };
		} else {
			// Claude agents: use tmux send-keys path
			const alive = await isSessionAlive(target.tmuxSession);
			if (!alive) {
				result = {
					delivered: false,
					reason: `Tmux session "${target.tmuxSession}" is not alive`,
				};
			} else {
				// Send with retry
				const delivered = await sendNudgeWithRetry(target.tmuxSession, message);

				if (delivered) {
					// Record nudge for debounce tracking
					const statePath = join(projectRoot, ".overstory", "nudge-state.json");
					await recordNudge(statePath, agentName);
					result = { delivered: true };
				} else {
					result = {
						delivered: false,
						reason: `Failed to send after ${MAX_RETRIES} attempts`,
					};
				}
			}
		}
	}

	// Record event to EventStore (fire-and-forget)
	try {
		const overstoryDir = join(projectRoot, ".overstory");
		const eventsDbPath = join(overstoryDir, "events.db");
		const eventStore = createEventStore(eventsDbPath);
		try {
			const runId = await readCurrentRunId(overstoryDir);
			recordNudgeEvent(eventStore, {
				runId,
				agentName,
				from: "orchestrator",
				message,
				delivered: result.delivered,
			});
		} finally {
			eventStore.close();
		}
	} catch {
		// Event recording failure is non-fatal
	}

	return result;
}

/**
 * Entry point for `overstory nudge <agent-name> [message]`.
 */
const NUDGE_HELP = `overstory nudge — Send a text nudge to an agent

Usage: overstory nudge <agent-name> [message]

Arguments:
  <agent-name>           Name of the agent to nudge
  [message]              Text to send (default: "${DEFAULT_MESSAGE}")

Options:
  --from <name>          Sender name for the nudge prefix (default: orchestrator)
  --force                Skip debounce check
  --json                 Output result as JSON
  --help, -h             Show this help`;

export async function nudgeCommand(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(`${NUDGE_HELP}\n`);
		return;
	}

	const positional = getPositionalArgs(args);
	const agentName = positional[0];
	if (!agentName || agentName.trim().length === 0) {
		throw new ValidationError("Agent name is required: overstory nudge <agent-name> [message]", {
			field: "agentName",
		});
	}

	const from = getFlag(args, "--from") ?? "orchestrator";
	const force = args.includes("--force");
	const json = args.includes("--json");

	// Build the nudge message: prefix with sender, use custom or default text
	const customMessage = positional.slice(1).join(" ");
	const rawMessage = customMessage.length > 0 ? customMessage : DEFAULT_MESSAGE;
	const message = `[NUDGE from ${from}] ${rawMessage}`;

	// Resolve project root
	const { resolveProjectRoot } = await import("../config.ts");
	const projectRoot = await resolveProjectRoot(process.cwd());

	const result = await nudgeAgent(projectRoot, agentName, message, force);

	if (json) {
		process.stdout.write(
			`${JSON.stringify({ agentName, delivered: result.delivered, reason: result.reason })}\n`,
		);
	} else if (result.delivered) {
		process.stdout.write(`📢 Nudged "${agentName}"\n`);
	} else {
		throw new AgentError(`Nudge failed: ${result.reason}`, { agentName });
	}
}
