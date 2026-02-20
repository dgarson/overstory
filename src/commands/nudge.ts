/**
 * CLI command: overstory nudge <agent-name> [message]
 *
 * Sends a text nudge to an agent's interactive Claude Code session via
 * tmux send-keys. Used to notify agents of new mail or relay urgent
 * instructions mid-conversation.
 *
 * For Codex agents (runtime === "codex"), delegates to CodexBridgeDriver.nudge()
 * which sends high-priority mail and wakes the bridge via SIGUSR1.
 *
 * Includes debounce (500ms) to prevent rapid-fire nudges to the same agent.
 * Retry logic lives inside each driver implementation.
 */

import { join } from "node:path";
import { AgentError, ValidationError } from "../errors.ts";
import { createEventStore } from "../events/store.ts";
import { openSessionStore } from "../sessions/compat.ts";
import type { AgentRuntime, EventStore } from "../types.ts";

const DEFAULT_MESSAGE = "Check your mail inbox for new messages.";
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
 * Dispatches to the appropriate driver based on the persisted session runtime.
 * For "codex" agents, CodexBridgeDriver handles debounce and recordNudge internally.
 * For "claude" agents, debounce is managed here and ClaudeDriver handles tmux delivery.
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
	const overstoryDir = join(projectRoot, ".overstory");
	const statePath = join(overstoryDir, "nudge-state.json");

	const target = await resolveTargetSession(projectRoot, agentName);
	if (!target) {
		return { delivered: false, reason: `No active session for agent "${agentName}"` };
	}

	let result: { delivered: boolean; reason?: string };

	if (target.runtime === "codex-daemon") {
		// CodexDaemonDriver.nudge() sends HTTP POST to the daemon sidecar.
		const { CodexDaemonDriver } = await import("../drivers/codex-daemon.ts");
		const { readDaemonStateSync } = await import("../codex/daemon/lifecycle.ts");
		const state = readDaemonStateSync(overstoryDir);
		if (!state) {
			return { delivered: false, reason: "Codex daemon is not running" };
		}
		const driver = new CodexDaemonDriver({ daemonUrl: state.url, token: state.token });
		result = await driver.nudge(agentName, message, "orchestrator", { force });
	} else if (target.runtime === "codex") {
		// CodexBridgeDriver.nudge() requires overstoryDir to locate mail.db and bridge.pid.
		// Construct with minimal nudge-only deps to avoid loading spawn-related modules
		// (codex/overlay.ts, etc.) that require the generated bundled-defs.ts artifact.
		// The codex driver handles debounce and recordNudge internally.
		const { CodexBridgeDriver } = await import("../drivers/codex-bridge.ts");
		const { createMailStore } = await import("../mail/store.ts");
		const { createMailClient } = await import("../mail/client.ts");
		const driver = new CodexBridgeDriver(
			{
				// Cannot use makeCodexBridgeDriverDeps() here — it transitively imports
				// codex/overlay.ts → bundled-defs.ts (a generated artifact that may not exist
				// during tests or the nudge-only code path). Construct minimal deps inline.
				sendMail: (mailDbPath, opts) => {
					const store = createMailStore(mailDbPath);
					const client = createMailClient(store);
					try {
						client.send(opts);
					} finally {
						client.close();
					}
				},
				getBridgePid: async (dir, name) => {
					try {
						const pidFile = Bun.file(join(dir, "agents", name, "bridge.pid"));
						if (await pidFile.exists()) {
							const pidFromFile = Number.parseInt((await pidFile.text()).trim(), 10);
							if (!Number.isNaN(pidFromFile)) {
								return pidFromFile;
							}
						}
					} catch {
						// Fall through
					}
					return null;
				},
				processKill: (pid, signal) => process.kill(pid, signal as NodeJS.Signals),
				// Spawn-only stubs: never called during nudge
				createSession: async () => 0,
				startServer: async () => ({ pid: 0, port: 0, startedAt: "", url: "" }),
				writeAgentsOverlay: async () => {},
				writeCodexConfig: async () => {},
			},
			overstoryDir,
		);
		result = await driver.nudge(agentName, message, "orchestrator", { force });
	} else {
		// Claude agents: debounce check lives here (ClaudeDriver does not maintain debounce state).
		if (!force && (await isDebounced(statePath, agentName))) {
			return { delivered: false, reason: "Debounced: nudge sent too recently" };
		}
		// Construct ClaudeDriver with minimal nudge-only deps to avoid loading
		// agents/overlay.ts and hooks-deployer.ts (which require bundled-defs.ts).
		// ClaudeDriver.nudge() only uses isSessionAlive and sendKeys; the spawn-related
		// deps (writeOverlay, deployHooks, createSession) are stubs that never run here.
		const { ClaudeDriver } = await import("../drivers/claude.ts");
		const { isSessionAlive, sendKeys } = await import("../worktree/tmux.ts");
		const driver = new ClaudeDriver({
			sendKeys,
			isSessionAlive,
			// Spawn-only stubs: never called during nudge
			createSession: async () => 0,
			writeOverlay: async () => {},
			deployHooks: async () => {},
		});
		// ClaudeDriver.nudge() treats its first arg as the tmux session name.
		result = await driver.nudge(target.tmuxSession, message, "orchestrator", { force });
		if (result.delivered) {
			await recordNudge(statePath, agentName);
		}
	}

	// Record event to EventStore (fire-and-forget)
	try {
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
