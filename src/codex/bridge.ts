// src/codex/bridge.ts
// Per-worker bridge adapter process. Mediates between overstory and the shared
// Codex App Server via JSON-RPC 2.0 over WebSocket. Run via Bun.spawn from sling.ts.
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { loadCheckpoint, saveCheckpoint } from "../agents/checkpoint";
import { loadIdentity, updateIdentity } from "../agents/identity";
import { createControlClient } from "../control/client";
import { createEventStore } from "../events/store";
import { createMailClient } from "../mail/client";
import { createMailStore } from "../mail/store";
import { openSessionStore } from "../sessions/compat";
import { createRunStore } from "../sessions/store";
import type { EventLevel, EventStore, MailMessage, SessionCheckpoint } from "../types";
import type { ApprovalContext } from "./approval";
import { evaluateCommandApproval, evaluateFileChangeApproval } from "./approval";
import { createDeltaBufferManager, normalizeItemCompleted, normalizeItemStarted } from "./events";
import type { RpcClient } from "./rpc-client";
import { createRpcClient, createRpcClientWithRetry } from "./rpc-client";
import { stopServer } from "./server";
import type {
	ApprovalRequest,
	BridgeConfig,
	ItemCompletedParams,
	ItemStartedParams,
	ThreadStartResult,
	TokenUsageParams,
	TurnCompletedParams,
} from "./types";

/** Parse bridge config from environment variables */
export function parseBridgeConfig(env: Record<string, string | undefined>): BridgeConfig {
	return {
		agentName: env.OVERSTORY_AGENT_NAME ?? "",
		worktreePath: env.OVERSTORY_WORKTREE_PATH ?? "",
		branchName: env.OVERSTORY_BRANCH_NAME ?? "",
		beadId: env.OVERSTORY_BEAD_ID ?? "",
		capability: env.OVERSTORY_CAPABILITY ?? "builder",
		parentAgent: env.OVERSTORY_PARENT_AGENT || null,
		depth: Number(env.OVERSTORY_DEPTH ?? "0"),
		runId: env.OVERSTORY_RUN_ID || null,
		sessionId: env.OVERSTORY_SESSION_ID || "",
		serverUrl: env.OVERSTORY_CODEX_SERVER_URL ?? "ws://127.0.0.1:21816",
		model: env.OVERSTORY_CODEX_MODEL ?? "o3",
		compactionThreshold: Number(env.OVERSTORY_COMPACTION_THRESHOLD ?? "0.8"),
		maxDeltaBufferBytes: Number(env.OVERSTORY_MAX_DELTA_BUFFER ?? "1048576"),
		approvalTimeoutMs: Number(env.OVERSTORY_APPROVAL_TIMEOUT ?? "60000"),
		fileScope: (env.OVERSTORY_FILE_SCOPE ?? "").split(",").filter(Boolean),
		projectRoot: env.OVERSTORY_PROJECT_ROOT ?? "",
		maxReconnectAttempts: Number(env.OVERSTORY_MAX_RECONNECT_ATTEMPTS ?? "3"),
		reconnectBaseDelayMs: Number(env.OVERSTORY_RECONNECT_BASE_DELAY ?? "2000"),
	};
}

/** Determine if a turn status means the agent is done */
export function shouldShutdown(status: string): boolean {
	return status === "completed" || status === "failed" || status === "cancelled";
}

/**
 * Determine if a mail message is an approval/rejection reply to an escalation.
 * Pure function: extracts the reply-matching logic from handleApprovalRequest().
 *
 * Returns "approve" if the message grants approval, "reject" if it denies,
 * or null if the message does not match the escalation at all.
 */
export function matchesEscalationReply(
	msg: { from: string; subject: string; type?: string },
	escalationMarker: string,
	parentAgent: string,
): "approve" | "reject" | null {
	if (msg.from !== parentAgent) return null;

	const subj = msg.subject.toLowerCase();

	// Keyword-based approval/rejection (highest priority)
	if (subj.includes("approve") || subj.includes("accept")) return "approve";
	if (subj.includes("decline") || subj.includes("reject")) return "reject";

	// Marker-based correlation with type matching
	if (msg.subject.includes(escalationMarker)) {
		if (msg.type === "result" || msg.type === "status") return "approve";
		if (msg.type === "error") return "reject";
	}

	return null;
}

/**
 * Determine whether a checkpoint should be saved based on token usage.
 * Pure function: extracts the threshold + debounce logic from the
 * thread/tokenUsage/updated notification handler.
 */
export function shouldSaveCheckpoint(
	totalTokens: number,
	contextWindowSize: number,
	compactionThreshold: number,
	lastSaveMs: number,
	debounceMs: number,
	nowMs?: number,
): boolean {
	if (contextWindowSize <= 0) return false;
	const ratio = totalTokens / contextWindowSize;
	const now = nowMs ?? Date.now();
	return ratio >= compactionThreshold && now - lastSaveMs >= debounceMs;
}

/**
 * Dependency injection interface for shutdown bookkeeping.
 * Allows tests to supply real SQLite stores while faking subprocess calls.
 */
export interface ShutdownDeps {
	eventStore: EventStore;
	mailClient: {
		send(msg: {
			from: string;
			to: string;
			subject: string;
			body: string;
			type?: MailMessage["type"];
			priority?: MailMessage["priority"];
		}): void;
		close(): void;
	};
	openSessionStore: (dir: string) => {
		store: {
			updateState(agent: string, state: string): void;
			getActive(): Array<{ runtime?: string; agentName: string }>;
			close(): void;
		};
	};
	updateIdentity: typeof updateIdentity;
	saveCheckpoint?: typeof saveCheckpoint;
	runMulchLearn?: (cwd: string) => Promise<void>;
	createRunStore: (path: string) => {
		completeRun(id: string, status: string): void;
		close(): void;
	};
	/** Stop the Codex App Server. Called when this is the last codex agent. */
	stopServer?: (overstoryDir: string) => Promise<boolean>;
}

/**
 * Perform shutdown bookkeeping after a bridge session ends.
 * Extracted from the inline shutdown block in runBridge() for testability.
 *
 * Each step is wrapped in try/catch to ensure subsequent steps still run
 * even if an earlier step fails (non-fatal bookkeeping pattern).
 */
export async function performShutdownBookkeeping(
	config: BridgeConfig,
	overstoryDir: string,
	deps: ShutdownDeps,
): Promise<void> {
	// 1. Record session_end event
	try {
		deps.eventStore.insert({
			runId: config.runId,
			agentName: config.agentName,
			sessionId: config.sessionId,
			eventType: "session_end",
			toolName: null,
			toolArgs: null,
			toolDurationMs: null,
			level: "info",
			data: JSON.stringify({ reason: "turn_completed", runtime: "codex" }),
		});
	} catch {
		// Non-fatal: event recording failure shouldn't block shutdown
	}

	// 2. Update session state to "completed"
	try {
		const { store: sessionStore } = deps.openSessionStore(overstoryDir);
		try {
			sessionStore.updateState(config.agentName, "completed");
		} finally {
			sessionStore.close();
		}
	} catch {
		// Non-fatal: session state update failure shouldn't block shutdown
	}

	// 3. Increment identity.sessionsCompleted
	try {
		const identityBaseDir = join(overstoryDir, "agents");
		await deps.updateIdentity(identityBaseDir, config.agentName, {
			sessionsCompleted: 1,
			completedTask: {
				beadId: config.beadId,
				summary: `Codex ${config.capability} agent completed task ${config.beadId}`,
			},
		});
	} catch {
		// Non-fatal: identity update failure shouldn't block shutdown
	}

	// 4. Auto-record expertise (mirrors Stop hook's `mulch learn`)
	if (deps.runMulchLearn) {
		try {
			await deps.runMulchLearn(config.worktreePath);
		} catch {
			// Non-fatal: mulch may not be installed or available
		}
	}

	// 5. Send worker_done mail to parent
	if (config.parentAgent) {
		try {
			deps.mailClient.send({
				from: config.agentName,
				to: config.parentAgent,
				subject: `Worker done: ${config.beadId}`,
				body: `Completed task ${config.beadId}. Quality gates: bridge shutdown.`,
				type: "worker_done",
				priority: "normal",
			});
		} catch {
			// Non-fatal: mail send failure shouldn't block shutdown
		}
	}

	// 6. Auto-nudge coordinator when a lead completes
	if (config.capability === "lead") {
		try {
			const nudgesDir = join(overstoryDir, "pending-nudges");
			await mkdir(nudgesDir, { recursive: true });
			const markerPath = join(nudgesDir, "coordinator.json");
			const marker = {
				from: config.agentName,
				reason: "lead_completed",
				subject: `Lead ${config.agentName} completed — check mail for merge_ready/worker_done`,
				messageId: `auto-nudge-${config.agentName}-${Date.now()}`,
				createdAt: new Date().toISOString(),
			};
			await Bun.write(markerPath, `${JSON.stringify(marker, null, "\t")}\n`);
		} catch {
			// Non-fatal: nudge failure should not break session-end
		}
	}

	// 7. Auto-complete run when coordinator exits
	if (config.capability === "coordinator") {
		try {
			const currentRunPath = join(overstoryDir, "current-run.txt");
			const currentRunFile = Bun.file(currentRunPath);
			if (await currentRunFile.exists()) {
				const runId = (await currentRunFile.text()).trim();
				if (runId.length > 0) {
					const runStore = deps.createRunStore(join(overstoryDir, "sessions.db"));
					try {
						runStore.completeRun(runId, "completed");
					} finally {
						runStore.close();
					}
					const { unlink: unlinkFile } = await import("node:fs/promises");
					try {
						await unlinkFile(currentRunPath);
					} catch {
						// File may already be gone
					}
				}
			}
		} catch {
			// Non-fatal: run completion should not break session-end handling
		}
	}

	// 8. Stop Codex App Server when this is the last codex agent
	if (deps.stopServer) {
		try {
			const { store: sessionStore } = deps.openSessionStore(overstoryDir);
			try {
				const active = sessionStore.getActive();
				const otherCodex = active.filter(
					(s) => s.runtime === "codex" && s.agentName !== config.agentName,
				);
				if (otherCodex.length === 0) {
					await deps.stopServer(overstoryDir);
				}
			} finally {
				sessionStore.close();
			}
		} catch {
			// Non-fatal: server cleanup failure should not block shutdown
		}
	}
}

/** Safely insert an event into the event store (fire-and-forget) */
function tryInsertEvent(eventStore: EventStore, event: Parameters<EventStore["insert"]>[0]): void {
	try {
		eventStore.insert(event);
	} catch {
		// Fire-and-forget: event recording errors are non-fatal
	}
}

/** Valid EventStore level values for runtime validation */
const VALID_LEVELS: ReadonlySet<string> = new Set(["debug", "info", "warn", "error"]);

/**
 * Build a rich priming prompt for the initial turn, mirroring the Claude path's
 * beacon + SessionStart hook (`overstory prime --agent`). Includes:
 * - Agent identity (name, capability, sessions completed)
 * - Task activation (bead ID, AGENTS.md reference)
 * - Pending mail (if any messages arrived before the first turn)
 * - Checkpoint recovery (if resuming after compaction/crash)
 */
export async function buildInitialPrompt(
	config: BridgeConfig,
	overstoryDir: string,
): Promise<string> {
	const sections: string[] = [];
	const timestamp = new Date().toISOString();
	const parent = config.parentAgent ?? "none";

	// Beacon-equivalent header
	sections.push(
		`[OVERSTORY] ${config.agentName} (${config.capability}) ${timestamp} task:${config.beadId}`,
	);
	sections.push(`Depth: ${config.depth} | Parent: ${parent}`);

	// Identity section (mirrors prime.ts outputAgentContext)
	const identityBaseDir = join(overstoryDir, "agents");
	try {
		const identity = await loadIdentity(identityBaseDir, config.agentName);
		if (identity) {
			sections.push(`\nIdentity: ${identity.sessionsCompleted} prior sessions`);
		}
	} catch {
		// Non-fatal: identity may not exist yet
	}

	// Activation
	sections.push(`\nYou have a bound task: **${config.beadId}**`);
	sections.push("Read your AGENTS.md overlay and begin working immediately.");
	sections.push("Do not wait for dispatch mail. Your assignment was bound at spawn time.");

	// Checkpoint recovery (if resuming from a previous compacted session)
	try {
		const checkpoint = await loadCheckpoint(identityBaseDir, config.agentName);
		if (checkpoint) {
			sections.push("\n## Session Recovery");
			sections.push("You are resuming from a previous session that was compacted.");
			sections.push(`**Progress so far:** ${checkpoint.progressSummary}`);
			sections.push(`**Files modified:** ${checkpoint.filesModified.join(", ") || "none"}`);
			sections.push(`**Pending work:** ${checkpoint.pendingWork}`);
			sections.push(`**Branch:** ${checkpoint.currentBranch}`);
		}
	} catch {
		// Non-fatal: checkpoint may not exist
	}

	// Initial mail check — if lead sent instructions before the turn started
	try {
		const mailStore = createMailStore(join(overstoryDir, "mail.db"));
		const mailClient = createMailClient(mailStore);
		try {
			const messages = mailClient.check(config.agentName);
			if (messages.length > 0) {
				sections.push("\n## Pending Messages");
				for (const m of messages) {
					sections.push(`- [${m.from}] ${m.subject}: ${m.body.slice(0, 300)}`);
				}
			}
		} finally {
			mailClient.close();
		}
	} catch {
		// Non-fatal: mail check failure shouldn't block startup
	}

	return sections.join("\n");
}

/** Mutable refs shared between the outer reconnect loop and each bridge session. */
interface BridgeSessionRefs {
	rpc: RpcClient | null;
	threadId: string | null;
	activeTurnId: string | null;
}

/**
 * Determine whether to attempt a server reconnect after an unexpected disconnect.
 * Pure function: makes the reconnect decision testable without side effects.
 *
 * @param shutdownRequested - Whether shutdown was explicitly requested (prevents reconnect)
 * @param attempt - Current reconnect attempt number (1-indexed)
 * @param maxAttempts - Maximum number of reconnect attempts allowed
 */
export function shouldAttemptReconnect(
	shutdownRequested: boolean,
	attempt: number,
	maxAttempts: number,
): boolean {
	if (shutdownRequested) return false;
	return attempt <= maxAttempts;
}

/**
 * Build a recovery prompt for a reconnected session.
 * Called instead of buildInitialPrompt when the bridge reconnects after a server restart.
 * Loads checkpoint data and pending mail to give the model full context.
 */
export async function buildReconnectPrompt(
	config: BridgeConfig,
	overstoryDir: string,
	prevProgressSummary: string,
): Promise<string> {
	const sections: string[] = [];
	const timestamp = new Date().toISOString();
	sections.push(
		`[OVERSTORY RECONNECT] ${config.agentName} (${config.capability}) ${timestamp} task:${config.beadId}`,
	);
	sections.push("The Codex App Server was restarted. You are continuing your previous session.");

	// Try to load checkpoint for richer recovery context
	const identityBaseDir = join(overstoryDir, "agents");
	try {
		const checkpoint = await loadCheckpoint(identityBaseDir, config.agentName);
		if (checkpoint) {
			sections.push("\n## Session Recovery");
			sections.push(`**Progress so far:** ${checkpoint.progressSummary}`);
			sections.push(`**Files modified:** ${checkpoint.filesModified.join(", ") || "none"}`);
			sections.push(`**Pending work:** ${checkpoint.pendingWork}`);
			sections.push(`**Branch:** ${checkpoint.currentBranch}`);
		} else if (prevProgressSummary) {
			sections.push(`\n**Last known progress:** ${prevProgressSummary}`);
			sections.push(`Continue working on task ${config.beadId}.`);
		} else {
			sections.push(`\nResume task ${config.beadId} and continue working.`);
			sections.push("Re-read your AGENTS.md overlay and continue from where you left off.");
		}
	} catch {
		sections.push(`\nResume task ${config.beadId}. Continue working.`);
	}

	// Check for pending mail (accumulated during the disconnect)
	try {
		const mailStore = createMailStore(join(overstoryDir, "mail.db"));
		const tempMailClient = createMailClient(mailStore);
		try {
			const messages = tempMailClient.check(config.agentName);
			if (messages.length > 0) {
				sections.push("\n## Pending Messages");
				for (const m of messages) {
					sections.push(`- [${m.from}] ${m.subject}: ${m.body.slice(0, 300)}`);
				}
			}
		} finally {
			tempMailClient.close();
		}
	} catch {
		// Non-fatal: mail check failure shouldn't block reconnect
	}

	return sections.join("\n");
}

/**
 * Run a single bridge session: connect, initialize, start thread+turn, handle events,
 * and return whether the session ended normally (turn completed) or unexpectedly (socket closed).
 *
 * On reconnect (isReconnect=true), uses createRpcClientWithRetry and builds a recovery
 * prompt instead of the full initial prompt.
 */
async function runBridgeSession(
	config: BridgeConfig,
	overstoryDir: string,
	eventStore: EventStore,
	mailClient: ReturnType<typeof createMailClient>,
	controlClient: ReturnType<typeof createControlClient>,
	modifiedFiles: Set<string>,
	refs: BridgeSessionRefs,
	isReconnect: boolean,
	prevProgressSummary: string,
): Promise<{ normalShutdown: boolean; lastProgressSummary: string }> {
	// Connect — use retry on reconnect to give the server time to restart.
	const rpc = isReconnect
		? await createRpcClientWithRetry(config.serverUrl, {
				maxAttempts: config.maxReconnectAttempts,
				baseDelayMs: config.reconnectBaseDelayMs,
			})
		: await createRpcClient(config.serverUrl);

	refs.rpc = rpc;

	// Initialize the server session (clientInfo is required by Codex App Server)
	await rpc.request("initialize", {
		clientInfo: {
			name: "overstory-bridge",
			title: `Overstory Bridge (${config.agentName})`,
			version: "0.1.0",
		},
		capabilities: null,
	});

	// Load system instructions from AGENTS.md in the worktree.
	// The Codex App Server needs these as the `instructions` parameter so the model
	// knows its role, tools, and constraints. Without them, the model responds with
	// plain text and never uses tools.
	let instructions: string | undefined;
	const agentsMdPath = join(config.worktreePath, "AGENTS.md");
	if (existsSync(agentsMdPath)) {
		instructions = readFileSync(agentsMdPath, "utf-8");
	}

	// Start a new thread for this agent
	const threadResult = (await rpc.request("thread/start", {
		cwd: config.worktreePath,
		model: config.model,
		instructions: instructions ?? "",
		sandbox: "danger-full-access",
		approvalPolicy: "on-request",
		experimentalRawEvents: false,
	})) as ThreadStartResult;

	const threadId = threadResult.thread.id;
	refs.threadId = threadId;

	// Delta buffer manager for accumulating streamed output per item
	const deltaManager = createDeltaBufferManager(config.maxDeltaBufferBytes);

	// Track item start times for duration calculation
	const itemStartTimes = new Map<string, number>();

	// Track the active turn ID so we can steer it on mail arrival
	let activeTurnId: string | null = null;

	// Shutdown signal: Promise-based instead of polling
	let shutdownRequested = false;
	let shutdownResolve: ((normal: boolean) => void) | null = null;

	// Compaction tracking: inherit progress summary from previous session
	let lastProgressSummary = prevProgressSummary;
	let lastCheckpointSaveMs = 0;
	const CHECKPOINT_DEBOUNCE_MS = 30_000;

	// Approval context for this agent
	const approvalCtx: ApprovalContext = {
		capability: config.capability,
		agentName: config.agentName,
		worktreePath: config.worktreePath,
		fileScope: config.fileScope,
	};

	/**
	 * Handle an approval request: evaluate locally, escalate to parent if needed.
	 * Returns the approval response object (decision + optional reason).
	 */
	async function handleApprovalRequest(req: ApprovalRequest): Promise<Record<string, unknown>> {
		let decision: string;
		let reason: string | undefined;

		if (req.type === "fileChange" && req.changes) {
			const result = evaluateFileChangeApproval(req.changes, approvalCtx);
			decision = result.decision;
			reason = result.decision !== "accept" ? result.reason : undefined;
		} else {
			const command = req.command ?? "";
			const result = evaluateCommandApproval(command, approvalCtx);
			decision = result.decision;
			reason = result.decision !== "accept" ? result.reason : undefined;
		}

		// Escalation: send mail to parent and wait for reply with timeout
		if (decision === "escalate" && config.parentAgent) {
			// Include itemId in subject for thread correlation
			const escalationMarker = `[${req.itemId}]`;
			const escalationSubject =
				req.type === "fileChange"
					? `Approval needed ${escalationMarker}: file change outside scope`
					: `Approval needed ${escalationMarker}: ${(req.command ?? "unknown command").slice(0, 60)}`;

			mailClient.send({
				from: config.agentName,
				to: config.parentAgent,
				subject: escalationSubject,
				body: reason ?? "Unknown command requires approval",
				type: "question",
				priority: "high",
			});

			// Wait for parent response up to approvalTimeoutMs
			const deadline = Date.now() + config.approvalTimeoutMs;
			const MAX_POLL_ITERATIONS = 120;
			let parentApproved = false;
			let iterations = 0;
			while (Date.now() < deadline && iterations < MAX_POLL_ITERATIONS) {
				iterations++;
				await Bun.sleep(2000);
				const messages = mailClient.check(config.agentName);
				let foundReject = false;
				for (const m of messages) {
					const result = matchesEscalationReply(m, escalationMarker, config.parentAgent ?? "");
					if (result === "approve") {
						parentApproved = true;
						break;
					}
					if (result === "reject") {
						foundReject = true;
						break;
					}
				}
				if (parentApproved || foundReject) {
					break;
				}
			}

			if (parentApproved) {
				decision = "accept";
				reason = undefined;
			} else {
				decision = "decline";
				reason = reason ?? "Escalation timed out or was rejected by parent";
			}
		} else if (decision === "escalate") {
			// No parent agent to escalate to — decline
			decision = "decline";
			reason = reason ?? "No parent agent available for escalation";
		}

		const response: Record<string, unknown> = {
			threadId: req.threadId,
			itemId: req.itemId,
			decision,
		};
		if (reason !== undefined) {
			response.reason = reason;
		}
		return response;
	}

	// Register handler for server-initiated approval requests (JSON-RPC requests with id)
	rpc.onRequest(async (method: string, params: unknown) => {
		if (method === "requestApproval" || method === "approval/request") {
			const req = params as ApprovalRequest | undefined;
			if (!req) return null;
			return handleApprovalRequest(req);
		}
		return null;
	});

	// Debounced mail check: runs after item/completed events, limited to once per 5s
	let lastMailCheck = 0;
	const MAIL_CHECK_DEBOUNCE_MS = 5000;

	function debouncedMailCheck(): void {
		const now = Date.now();
		if (now - lastMailCheck < MAIL_CHECK_DEBOUNCE_MS) return;
		lastMailCheck = now;

		try {
			const messages = mailClient.check(config.agentName);
			const summaryParts: string[] = messages.map(
				(m) => `[${m.from}] ${m.subject}: ${m.body.slice(0, 200)}`,
			);

			// Check for pending-nudge markers addressed to this agent
			try {
				const nudgePath = join(overstoryDir, "pending-nudges", `${config.agentName}.json`);
				if (existsSync(nudgePath)) {
					const nudgeText = readFileSync(nudgePath, "utf-8");
					const nudge = JSON.parse(nudgeText) as {
						from?: string;
						reason?: string;
						subject?: string;
					};
					summaryParts.push(
						`[nudge:${nudge.from ?? "unknown"}] ${nudge.subject ?? nudge.reason ?? "pending nudge"}`,
					);
					unlinkSync(nudgePath);
				}
			} catch {
				// Non-fatal: nudge marker read/delete failure is ignorable
			}

			if (summaryParts.length === 0 || activeTurnId === null) return;

			const summary = summaryParts.join("\n");
			rpc
				.request("turn/steer", {
					threadId,
					expectedTurnId: activeTurnId,
					input: [{ type: "text", text: `New messages:\n${summary}`, text_elements: [] }],
				} as Record<string, unknown>)
				.catch((err: unknown) => {
					console.error("[bridge] debounced mail steer failed:", err);
					tryInsertEvent(eventStore, {
						runId: config.runId,
						agentName: config.agentName,
						sessionId: config.sessionId,
						eventType: "tool_end",
						toolName: "MailSteer",
						toolArgs: null,
						toolDurationMs: null,
						level: "warn",
						data: JSON.stringify({ error: String(err) }),
					});
				});
		} catch {
			// Non-fatal: mail check errors shouldn't affect the event loop
		}
	}

	rpc.onNotification((method: string, params: unknown) => {
		const p = params as Record<string, unknown> | undefined;

		// turn/completed — check if we should shut down.
		// MUST be checked before item/completed's endsWith("/completed") wildcard,
		// which would otherwise swallow turn/completed notifications.
		// v2 format: { threadId, turn: { id, status, ... } }
		if (method === "turn/completed") {
			if (!p) return;

			activeTurnId = null;
			refs.activeTurnId = null;

			// Extract status from v2 nested structure or flat v1 structure
			const turnObj = p.turn as { status?: string } | undefined;
			const status = turnObj?.status ?? (p as unknown as TurnCompletedParams).status;
			if (status && shouldShutdown(status)) {
				shutdownRequested = true;
				shutdownResolve?.(true);
			}
		}

		// turn/started — track the active turn ID and check for pending messages.
		// MUST be checked before item/started's endsWith("/started") wildcard,
		// which would otherwise swallow turn/started notifications.
		// v2 format: { threadId, turn: { id, status, ... } }
		else if (method === "turn/started") {
			if (!p) return;
			const turnObj = p.turn as { id?: string } | undefined;
			const turnId = turnObj?.id ?? (p.turnId as string | undefined);
			if (turnId) {
				activeTurnId = turnId;
				refs.activeTurnId = turnId;
				// Check for messages that arrived between turns
				debouncedMailCheck();
			}
		}

		// item/started — record tool_start event
		// v2 format: { item: { type, id, ... }, threadId, turnId }
		else if (method === "item/started" || method.endsWith("/started")) {
			if (!p) return;
			// Extract from v2 nested structure or flat v1 structure
			const v2Item = (p as Record<string, unknown>).item as Record<string, unknown> | undefined;
			const itemId = (v2Item?.id ?? (p as unknown as ItemStartedParams).itemId) as
				| string
				| undefined;
			const itemType = (v2Item?.type ?? (p as unknown as ItemStartedParams).itemType) as
				| string
				| undefined;
			if (!itemId || !itemType) return;

			itemStartTimes.set(itemId, Date.now());
			void controlClient.toolLifecycle(config.agentName, "enter");
			deltaManager.start(
				itemId,
				itemType as ItemStartedParams["itemType"],
				new Date().toISOString(),
			);

			const record = normalizeItemStarted({
				agentName: config.agentName,
				sessionId: config.sessionId,
				runId: config.runId,
				itemId,
				itemType: itemType as ItemStartedParams["itemType"],
				data: v2Item ?? (p as unknown as ItemStartedParams).data,
			});

			const startLevel = VALID_LEVELS.has(record.level) ? (record.level as EventLevel) : "info";
			tryInsertEvent(eventStore, {
				runId: record.runId,
				agentName: record.agentName,
				sessionId: record.sessionId,
				eventType: "tool_start",
				toolName: record.toolName,
				toolArgs: record.toolArgs,
				toolDurationMs: null,
				level: startLevel,
				data: record.data,
			});
		}

		// outputDelta — accumulate streamed output per item.
		// Matches: outputDelta, item/outputDelta, item/agentMessage/delta,
		// item/reasoning/summaryTextDelta, and any /delta suffix.
		else if (
			method === "outputDelta" ||
			method.endsWith("/outputDelta") ||
			method.endsWith("/delta") ||
			method.endsWith("/summaryTextDelta")
		) {
			if (!p) return;
			// v2 delta notifications may use different field names
			const raw = p as Record<string, unknown>;
			const itemId = (raw.itemId ?? raw.id) as string | undefined;
			const delta = (raw.delta ?? raw.text) as string | undefined;
			if (itemId && delta) {
				deltaManager.appendDelta(itemId, delta);
			}
		}

		// item/completed — flush buffer, record tool_end event
		// v2 format: { item: { type, id, ... }, threadId, turnId }
		else if (method === "item/completed" || method.endsWith("/completed")) {
			if (!p) return;
			// Extract from v2 nested structure or flat v1 structure
			const v2Item = (p as Record<string, unknown>).item as Record<string, unknown> | undefined;
			const itemId = (v2Item?.id ?? (p as unknown as ItemCompletedParams).itemId) as
				| string
				| undefined;
			const itemType = (v2Item?.type ?? (p as unknown as ItemCompletedParams).itemType) as
				| string
				| undefined;
			// v2 items have a 'status' field per item type (e.g. CommandExecutionStatus)
			const itemStatus = (v2Item?.status ??
				(p as unknown as ItemCompletedParams).status ??
				"completed") as string;
			if (!itemId || !itemType) return;

			const startTime = itemStartTimes.get(itemId);
			itemStartTimes.delete(itemId);
			void controlClient.toolLifecycle(config.agentName, "exit");
			const durationMs = startTime !== undefined ? Date.now() - startTime : null;

			const deltaOutput = deltaManager.flush(itemId);

			const record = normalizeItemCompleted({
				agentName: config.agentName,
				sessionId: config.sessionId,
				runId: config.runId,
				itemId,
				itemType: itemType as ItemCompletedParams["itemType"],
				status: itemStatus as ItemCompletedParams["status"],
				data: v2Item ?? (p as unknown as ItemCompletedParams).data,
				deltaOutput,
				durationMs,
			});

			const endLevel = VALID_LEVELS.has(record.level) ? (record.level as EventLevel) : "info";
			tryInsertEvent(eventStore, {
				runId: record.runId,
				agentName: record.agentName,
				sessionId: record.sessionId,
				eventType: "tool_end",
				toolName: record.toolName,
				toolArgs: record.toolArgs,
				toolDurationMs: record.toolDurationMs,
				level: endLevel,
				data: record.data,
			});

			// Track modified files for checkpoint building (compaction support)
			if (itemType === "fileChange") {
				const changes = v2Item?.changes as Array<{ path?: string }> | undefined;
				if (changes) {
					for (const c of changes) {
						if (c.path) modifiedFiles.add(c.path);
					}
				} else {
					const data = (p as unknown as ItemCompletedParams).data as { path?: string } | undefined;
					if (data?.path) modifiedFiles.add(data.path);
				}
			}

			// Update progress summary from the latest completed item
			if (record.toolArgs) {
				lastProgressSummary = `Last action: ${record.toolName} ${record.toolArgs.slice(0, 100)}`;
			}

			// Debounced mail check after tool completion (mirrors PostToolUse hook behavior)
			debouncedMailCheck();
		}

		// requestApproval — handled by rpc.onRequest() for server-initiated requests
		// with id fields. This branch catches notifications (no id) for compatibility.
		else if (method === "requestApproval" || method === "approval/request") {
			const req = p as ApprovalRequest | undefined;
			if (!req) return;
			// Notification path: fire-and-forget response via separate RPC call
			handleApprovalRequest(req)
				.then((response) => {
					rpc.request("approval/respond", response).catch((err: unknown) => {
						console.error("[bridge] approval/respond failed:", err);
					});
				})
				.catch((err: unknown) => {
					console.error("[bridge] approval handler error:", err);
				});
		}

		// token usage updates — log + compaction threshold checkpoint save
		else if (method === "thread/tokenUsage/updated" || method.endsWith("/tokenUsage")) {
			const usage = p as TokenUsageParams | undefined;
			if (!usage) return;
			console.log(
				`[bridge] token usage: input=${usage.inputTokens} output=${usage.outputTokens}` +
					` total=${usage.totalTokens} ctx=${usage.contextWindowSize}`,
			);

			// Phase 1: Save checkpoint when usage crosses compaction threshold.
			// This pre-saves state so post-compaction recovery has data to inject.
			// Debounced: saves every CHECKPOINT_DEBOUNCE_MS while above threshold
			// so the checkpoint stays fresh as more work happens.
			if (
				shouldSaveCheckpoint(
					usage.totalTokens,
					usage.contextWindowSize,
					config.compactionThreshold,
					lastCheckpointSaveMs,
					CHECKPOINT_DEBOUNCE_MS,
				)
			) {
				lastCheckpointSaveMs = Date.now();
				const ratio = usage.totalTokens / usage.contextWindowSize;
				const checkpoint: SessionCheckpoint = {
					agentName: config.agentName,
					beadId: config.beadId,
					sessionId: config.sessionId,
					timestamp: new Date().toISOString(),
					progressSummary: lastProgressSummary || "In progress",
					filesModified: Array.from(modifiedFiles),
					currentBranch: config.branchName,
					pendingWork: `Continue task ${config.beadId}`,
					mulchDomains: [],
				};
				const identityBaseDir = join(overstoryDir, "agents");
				saveCheckpoint(identityBaseDir, checkpoint).catch((err: unknown) => {
					console.error("[bridge] checkpoint save failed:", err);
				});
				console.log(
					`[bridge] checkpoint saved (ratio=${ratio.toFixed(2)}, threshold=${config.compactionThreshold})`,
				);
			}
		}

		// contextCompaction — Phase 2: post-compaction recovery.
		// Load the saved checkpoint and inject recovery context via turn/steer.
		else if (
			method === "contextCompaction" ||
			method === "thread/compacted" ||
			method.endsWith("/contextCompaction")
		) {
			const identityBaseDir = join(overstoryDir, "agents");
			loadCheckpoint(identityBaseDir, config.agentName)
				.then((checkpoint) => {
					if (!checkpoint || activeTurnId === null) return;
					const recovery = [
						"[CONTEXT RECOVERY] Your conversation was compacted.",
						`Progress: ${checkpoint.progressSummary}`,
						`Files modified: ${checkpoint.filesModified.join(", ") || "none"}`,
						`Pending work: ${checkpoint.pendingWork}`,
						`Branch: ${checkpoint.currentBranch}`,
						`Continue working on task ${config.beadId}.`,
					].join("\n");

					return rpc.request("turn/steer", {
						threadId,
						expectedTurnId: activeTurnId,
						input: [{ type: "text", text: recovery, text_elements: [] }],
					} as Record<string, unknown>);
				})
				.catch((err: unknown) => {
					console.error("[bridge] post-compaction recovery failed:", err);
					tryInsertEvent(eventStore, {
						runId: config.runId,
						agentName: config.agentName,
						sessionId: config.sessionId,
						eventType: "tool_end",
						toolName: "MailSteer",
						toolArgs: null,
						toolDurationMs: null,
						level: "warn",
						data: JSON.stringify({ error: String(err) }),
					});
				});

			// Reset checkpoint debounce so it can be saved again after compaction
			lastCheckpointSaveMs = 0;
		}
	});

	// Build prompt: initial on first connect, recovery on reconnect
	const sessionPrompt = isReconnect
		? await buildReconnectPrompt(config, overstoryDir, prevProgressSummary)
		: await buildInitialPrompt(config, overstoryDir);

	// Start the turn with the agent's task instructions.
	// The v2 API expects input as an array of UserInput objects.
	const turnStartResult = (await rpc.request("turn/start", {
		threadId,
		input: [{ type: "text", text: sessionPrompt, text_elements: [] }],
	})) as { turn?: { id: string } } | undefined;

	// Capture initial turn ID if returned synchronously
	if (turnStartResult?.turn?.id !== undefined) {
		activeTurnId = turnStartResult.turn.id;
		refs.activeTurnId = activeTurnId;
	}

	// Transition from "booting" to "working" now that the turn has started.
	// In the Claude Code path, hooks handle this transition via updateLastActivity().
	// The bridge must do it explicitly since there are no hooks in the Codex runtime.
	try {
		const { store: sessionStore } = openSessionStore(overstoryDir);
		try {
			sessionStore.updateState(config.agentName, "working");
		} finally {
			sessionStore.close();
		}
	} catch {
		// Non-fatal: state transition failure shouldn't block the bridge
	}

	// Event loop: wait for shutdown signal (Promise-based instead of polling).
	// Resolves with true on normal shutdown (turn completed), false on unexpected disconnect.
	const normalShutdown = await new Promise<boolean>((resolveShutdown) => {
		shutdownResolve = (normal: boolean) => resolveShutdown(normal);
		// If already requested before we set the resolve, fire immediately
		if (shutdownRequested) {
			resolveShutdown(true);
			return;
		}
		// Poll for WebSocket disconnection (rpc.closed set by close handler)
		const disconnectCheck = setInterval(() => {
			if (rpc.closed) {
				clearInterval(disconnectCheck);
				console.error("[bridge] WebSocket disconnected unexpectedly");
				resolveShutdown(false);
			}
		}, 1000);
		// Clean up interval when shutdown resolves
		const origResolve = shutdownResolve;
		shutdownResolve = (normal: boolean) => {
			clearInterval(disconnectCheck);
			origResolve?.(normal);
		};
	});

	// Clear session refs
	refs.rpc = null;
	refs.activeTurnId = null;
	rpc.close();

	return { normalShutdown, lastProgressSummary };
}

/**
 * Run the bridge process for a single worker agent.
 * Owns long-lived resources (event store, mail client) and the reconnect loop.
 * Delegates per-session work (connect, thread, event loop) to runBridgeSession().
 */
export async function runBridge(config: BridgeConfig): Promise<void> {
	const overstoryDir = join(config.projectRoot, ".overstory");
	const eventStore = createEventStore(join(overstoryDir, "events.db"));
	const mailStore = createMailStore(join(overstoryDir, "mail.db"));
	const mailClient = createMailClient(mailStore);
	const controlClient = createControlClient(overstoryDir);

	const modifiedFiles = new Set<string>();
	const refs: BridgeSessionRefs = { rpc: null, threadId: null, activeTurnId: null };

	// Best-effort control-plane registration for safe nudging/activity tracking.
	void controlClient.registerAgent({
		agentName: config.agentName,
		sessionId: config.sessionId,
		runtime: "codex",
		driverKind: "codex-bridge",
		tmuxSession: null,
		pid: process.pid,
	});

	const heartbeatInterval = setInterval(() => {
		void controlClient.heartbeat(config.agentName);
	}, 10_000);

	// Write PID file so nudge can find the bridge process directly
	const pidFilePath = join(overstoryDir, "agents", config.agentName, "bridge.pid");
	try {
		await mkdir(join(overstoryDir, "agents", config.agentName), { recursive: true });
		await Bun.write(pidFilePath, String(process.pid));
	} catch {
		// Non-fatal: nudge will fall back to session PID
	}

	// SIGUSR1 handler: check mail and steer the active turn if there are messages.
	// Registered once here so it persists across reconnects via refs.
	process.on("SIGUSR1", () => {
		try {
			const messages = mailClient.check(config.agentName);
			if (messages.length === 0) return;
			if (refs.activeTurnId === null || refs.rpc === null || refs.threadId === null) return;

			const summary = messages
				.map((m) => `[${m.from}] ${m.subject}: ${m.body.slice(0, 200)}`)
				.join("\n");

			refs.rpc
				.request("turn/steer", {
					threadId: refs.threadId,
					expectedTurnId: refs.activeTurnId,
					input: [{ type: "text", text: `New messages:\n${summary}`, text_elements: [] }],
				} as Record<string, unknown>)
				.catch((err: unknown) => {
					console.error("[bridge] turn/steer failed:", err);
					tryInsertEvent(eventStore, {
						runId: config.runId,
						agentName: config.agentName,
						sessionId: config.sessionId,
						eventType: "tool_end",
						toolName: "MailSteer",
						toolArgs: null,
						toolDurationMs: null,
						level: "warn",
						data: JSON.stringify({ error: String(err) }),
					});
				});
		} catch (err) {
			console.error("[bridge] SIGUSR1 handler error:", err);
		}
	});

	// SIGTERM handler: set flag and close active connection so the reconnect loop exits cleanly.
	// Registered here (alongside SIGUSR1) so it persists across reconnects via refs.
	let shutdownRequested = false;
	process.on("SIGTERM", () => {
		shutdownRequested = true;
		refs.rpc?.close();
	});

	// Reconnect loop: retry on unexpected disconnects, stop on normal shutdown
	let lastProgressSummary = "";
	let reconnectAttempt = 0;
	while (true) {
		const result = await runBridgeSession(
			config,
			overstoryDir,
			eventStore,
			mailClient,
			controlClient,
			modifiedFiles,
			refs,
			reconnectAttempt > 0,
			lastProgressSummary,
		);

		lastProgressSummary = result.lastProgressSummary;
		if (result.normalShutdown) break;

		reconnectAttempt++;
		if (!shouldAttemptReconnect(shutdownRequested, reconnectAttempt, config.maxReconnectAttempts)) {
			const reason = shutdownRequested
				? "SIGTERM received, not reconnecting."
				: `Max reconnect attempts (${config.maxReconnectAttempts}) reached, giving up.`;
			console.error(`[bridge] WebSocket disconnected. ${reason}`);
			break;
		}

		const delayMs = config.reconnectBaseDelayMs * 2 ** (reconnectAttempt - 1);
		console.log(
			`[bridge] Reconnecting in ${delayMs}ms (attempt ${reconnectAttempt}/${config.maxReconnectAttempts})...`,
		);
		await Bun.sleep(delayMs);
	}

	// Graceful shutdown: session-end bookkeeping (delegated to extracted function)
	await performShutdownBookkeeping(config, overstoryDir, {
		eventStore,
		mailClient,
		openSessionStore,
		updateIdentity,
		createRunStore,
		stopServer,
		runMulchLearn: async (cwd: string) => {
			const mulchProc = Bun.spawn(["mulch", "learn"], {
				cwd,
				stdout: "pipe",
				stderr: "pipe",
			});
			await mulchProc.exited;
		},
	});

	// Close connections
	clearInterval(heartbeatInterval);
	void controlClient.markOffline(config.agentName);
	eventStore.close();
	mailClient.close();
}

// Only run when executed directly (not imported for testing)
if (import.meta.main) {
	const config = parseBridgeConfig(process.env as Record<string, string | undefined>);
	runBridge(config).catch((err: unknown) => {
		console.error("[bridge] Fatal error:", err);
		process.exit(1);
	});
}
