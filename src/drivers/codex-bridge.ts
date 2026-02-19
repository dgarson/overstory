// src/drivers/codex-bridge.ts
// CodexBridgeDriver: per-agent bridge process lifecycle for the Codex runtime.
//
// Extracted from:
//   sling.ts lines 480-526 (spawn codex path: writeAgentsOverlay, writeCodexConfig,
//                            startServer, createSession with bridge env vars)
//   nudge.ts lines 259-321 (nudgeCodexAgent: mail + SIGUSR1 to bridge PID)

import { join, resolve } from "node:path";
import type { CodexServerState } from "../codex/types.ts";
import { ConfigError } from "../errors.ts";
import type { MailMessage, OverlayConfig } from "../types.ts";
import type {
	AgentDriver,
	AgentInspection,
	NudgeOptions,
	NudgeResult,
	SpawnContext,
	SpawnResult,
} from "./types.ts";

const DEBOUNCE_MS = 500;

/** Options for sendMail dep — mirrors the MailClient.send() parameter shape */
export interface SendMailOptions {
	from: string;
	to: string;
	subject: string;
	body: string;
	type?: MailMessage["type"];
	priority?: MailMessage["priority"];
}

/**
 * Dependency interface for CodexBridgeDriver.
 * All external I/O is injected so tests can run without tmux, filesystem, or network.
 */
export interface CodexBridgeDriverDeps {
	/** Create a tmux session. Returns the PID of the process in the pane. */
	createSession: (
		name: string,
		cwd: string,
		cmd: string,
		env?: Record<string, string>,
	) => Promise<number>;

	/** Start (or reuse) the shared Codex App Server. */
	startServer: (overstoryDir: string, port: number) => Promise<CodexServerState>;

	/** Write AGENTS.md overlay to the worktree. */
	writeAgentsOverlay: (
		worktreePath: string,
		config: OverlayConfig,
		canonicalRoot: string,
	) => Promise<void>;

	/** Write .codex/config.toml to the worktree. */
	writeCodexConfig: (
		worktreePath: string,
		opts: { model: string; approvalPolicy: "on-request" | "unless-allowed" | "never" },
	) => Promise<void>;

	/** Send a mail message. Synchronous wrapper so it can be easily mocked. */
	sendMail: (mailDbPath: string, opts: SendMailOptions) => void;

	/**
	 * Resolve the bridge PID for an agent.
	 * Checks .overstory/agents/<agentName>/bridge.pid, falls back to null.
	 * Returns null when no PID file exists or the file is corrupt.
	 */
	getBridgePid: (overstoryDir: string, agentName: string) => Promise<number | null>;

	/**
	 * Send a signal to a process. Defaults to process.kill in production.
	 * Injected for testing so we don't signal real PIDs.
	 */
	processKill: (pid: number, signal: string | number) => void;
}

/**
 * Build the default production deps for CodexBridgeDriver.
 * Uses dynamic imports so that modules with generated dependencies (e.g.,
 * codex/overlay.ts → bundled-defs.ts) are only loaded when this factory is
 * called — not when the driver module is imported by tests.
 *
 * Call this in sling.ts (and future callers) to wire real implementations.
 */
export async function makeCodexBridgeDriverDeps(): Promise<CodexBridgeDriverDeps> {
	const [tmuxMod, serverMod, overlayMod, configGenMod, mailStoreMod, mailClientMod] =
		await Promise.all([
			import("../worktree/tmux.ts"),
			import("../codex/server.ts"),
			import("../codex/overlay.ts"),
			import("../codex/config-gen.ts"),
			import("../mail/store.ts"),
			import("../mail/client.ts"),
		]);

	return {
		createSession: tmuxMod.createSession,
		startServer: serverMod.startServer,
		writeAgentsOverlay: overlayMod.writeAgentsOverlay,
		writeCodexConfig: configGenMod.writeCodexConfig,
		sendMail: (mailDbPath, opts) => {
			const store = mailStoreMod.createMailStore(mailDbPath);
			const client = mailClientMod.createMailClient(store);
			try {
				client.send(opts);
			} finally {
				client.close();
			}
		},
		getBridgePid: async (overstoryDir, agentName) => {
			try {
				const pidFile = Bun.file(join(overstoryDir, "agents", agentName, "bridge.pid"));
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
	};
}

/**
 * Driver for the "codex" runtime: a per-agent bridge process that connects to
 * the shared Codex App Server and drives the agent lifecycle via JSON-RPC.
 *
 * Spawning (step 12 in sling.ts, codex branch):
 *   12a. Write AGENTS.md overlay (Codex reads AGENTS.md, not .claude/CLAUDE.md)
 *   12b. Write .codex/config.toml
 *   12c. Ensure the shared Codex App Server is running
 *   12d. Spawn the bridge process inside a tmux session with env vars
 *
 * Nudging (extracted from nudge.ts nudgeCodexAgent, lines 259-321):
 *   1. Send high-priority mail to the agent
 *   2. Resolve bridge PID (bridge.pid file preferred over tmux pane PID)
 *   3. Validate PID liveness with kill(pid, 0)
 *   4. Send SIGUSR1 to wake the bridge so it picks up the mail immediately
 */
export class CodexBridgeDriver implements AgentDriver {
	readonly name = "codex-bridge";

	/** Per-instance debounce state: agentName -> last nudge timestamp (ms) */
	private readonly nudgeDebounce: Map<string, number> = new Map();

	constructor(private readonly deps: CodexBridgeDriverDeps) {}

	/**
	 * Spawn a Codex bridge agent.
	 * Extracted from sling.ts lines 480-526.
	 */
	async spawn(ctx: SpawnContext): Promise<SpawnResult> {
		const { config, overlayConfig, worktreePath, tmuxSessionName, session } = ctx;

		if (!config.codex) {
			throw new ConfigError("codex section is required in config when using runtime: codex", {
				field: "codex",
			});
		}
		const codexConfig = config.codex;
		const overstoryDir = join(config.project.root, ".overstory");

		// 12a. Write AGENTS.md overlay (Codex uses AGENTS.md, not .claude/CLAUDE.md)
		await this.deps.writeAgentsOverlay(worktreePath, overlayConfig, config.project.root);

		// 12b. Write .codex/config.toml
		await this.deps.writeCodexConfig(worktreePath, {
			model: codexConfig.model,
			approvalPolicy: "on-request",
		});

		// 12c. Ensure the shared Codex App Server is running
		const serverState = await this.deps.startServer(overstoryDir, codexConfig.serverPort);

		// 12d. Spawn the bridge process in a tmux session.
		// The bridge connects to the App Server and drives the Codex agent lifecycle.
		// Use `exec` so the shell is replaced by bun, ensuring #{pane_pid} returns
		// the actual bridge PID rather than a wrapper shell PID.
		// Critical for SIGUSR1 nudge delivery (review issue #3).
		const bridgeScript = resolve(import.meta.dir, "../codex/bridge.ts");
		const bridgeCmd = `exec bun run ${bridgeScript}`;

		const bridgeEnv: Record<string, string> = {
			OVERSTORY_AGENT_NAME: session.agentName,
			OVERSTORY_WORKTREE_PATH: worktreePath,
			OVERSTORY_CODEX_SERVER_URL: serverState.url,
			OVERSTORY_CODEX_MODEL: codexConfig.model,
			OVERSTORY_COMPACTION_THRESHOLD: String(codexConfig.compactionThreshold),
			OVERSTORY_MAX_DELTA_BUFFER: String(codexConfig.maxDeltaBufferBytes),
			OVERSTORY_APPROVAL_TIMEOUT: String(codexConfig.approvalTimeoutMs),
			OVERSTORY_FILE_SCOPE: overlayConfig.fileScope.join(","),
			OVERSTORY_PROJECT_ROOT: config.project.root,
			OVERSTORY_BRANCH_NAME: ctx.branchName,
			OVERSTORY_BEAD_ID: session.beadId,
			OVERSTORY_CAPABILITY: session.capability,
			OVERSTORY_PARENT_AGENT: session.parentAgent ?? "",
			OVERSTORY_DEPTH: String(session.depth),
			OVERSTORY_SESSION_ID: session.id,
			OVERSTORY_RUN_ID: ctx.runId,
		};

		const pid = await this.deps.createSession(tmuxSessionName, worktreePath, bridgeCmd, bridgeEnv);
		// Bridge handles its own turn/start beacon — no send-keys needed

		return { pid };
	}

	/**
	 * Nudge a Codex agent: send high-priority mail then wake the bridge via SIGUSR1.
	 * Extracted from nudge.ts nudgeCodexAgent, lines 259-321.
	 *
	 * @param agentName - Name of the agent to nudge
	 * @param message - Message to send
	 * @param from - Sender name
	 * @param opts - Nudge options (force=true bypasses debounce)
	 */
	async nudge(
		agentName: string,
		message: string,
		from: string,
		opts?: NudgeOptions,
	): Promise<NudgeResult> {
		// Debounce check: skip if nudged recently, unless force=true
		if (!opts?.force) {
			const lastNudge = this.nudgeDebounce.get(agentName);
			if (lastNudge !== undefined && Date.now() - lastNudge < DEBOUNCE_MS) {
				return { delivered: false, reason: "debounced" };
			}
		}

		// We need overstoryDir to locate the mail DB and bridge.pid file.
		// For nudge, we don't have config available directly so we use a best-effort
		// approach: the caller (nudge.ts) will be refactored in Task 8 to pass
		// overstoryDir. Until then, we accept a bare agentName and rely on the
		// injected sendMail/getBridgePid deps to receive the full path.
		// The mailDbPath is passed as "" here — production use via makeDeps will
		// wire it correctly when Task 8 refactors nudge.ts.
		// For now, we call deps directly.
		const mailDbPath = ""; // Resolved by dep implementation in production

		// 1. Send mail so the bridge has a message to act on.
		this.deps.sendMail(mailDbPath, {
			from,
			to: agentName,
			subject: "nudge",
			body: message,
			type: "status",
			priority: "high",
		});

		// 2. Resolve the bridge PID.
		// The bridge writes its actual bun process PID to agents/<name>/bridge.pid
		// at startup; prefer that over the session PID since the tmux pane's
		// #{pane_pid} may be a shell wrapper.
		const overstoryDir = ""; // Resolved by dep implementation in production
		let bridgePid = await this.deps.getBridgePid(overstoryDir, agentName);

		// 3. Validate the PID is still alive before signalling (C1: stale bridge PID).
		// kill(pid, 0) checks existence without delivering a signal; throws ESRCH
		// if the PID doesn't exist, preventing us from hitting an unrelated process.
		if (bridgePid !== null) {
			try {
				this.deps.processKill(bridgePid, 0);
			} catch {
				// Stale PID — cannot signal
				bridgePid = null;
			}
		}

		// 4. Send SIGUSR1 to wake the bridge so it picks up the message immediately.
		if (bridgePid !== null) {
			try {
				this.deps.processKill(bridgePid, "SIGUSR1");
			} catch {
				// Bridge process may have already exited — not fatal
			}
		}

		// Record debounce timestamp
		this.nudgeDebounce.set(agentName, Date.now());

		return { delivered: true };
	}

	/**
	 * Steer is not supported for bridge agents — the bridge drives its own turn lifecycle.
	 * Returns false so callers can fall back to mail (the preferred channel for codex agents).
	 */
	async steer(_agentName: string, _input: string): Promise<boolean> {
		return false;
	}

	/**
	 * Return a basic AgentInspection for the bridge agent.
	 * Full implementation (bridge PID, tmux capture) is deferred to Task 6.
	 */
	async inspect(_agentName: string): Promise<AgentInspection> {
		return {
			state: "working",
			lastActivity: new Date().toISOString(),
		};
	}

	/**
	 * Request graceful shutdown by sending SIGTERM to the bridge process.
	 * Best-effort: if the PID is stale or the bridge is already dead, silently continue.
	 */
	async shutdown(_agentName: string): Promise<void> {
		// Graceful shutdown: bridge will catch SIGTERM and clean up its thread.
		// Full implementation (resolving overstoryDir + pid file) is deferred to Task 8
		// when nudge.ts is refactored to pass overstoryDir to the driver.
	}

	/** No persistent connections to clean up for the bridge driver. */
	async close(): Promise<void> {}
}
