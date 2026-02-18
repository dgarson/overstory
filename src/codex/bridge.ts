// src/codex/bridge.ts
// Per-worker bridge adapter process. Mediates between overstory and the shared
// Codex App Server via JSON-RPC 2.0 over WebSocket. Run via Bun.spawn from sling.ts.
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { loadCheckpoint, saveCheckpoint } from "../agents/checkpoint";
import { loadIdentity, updateIdentity } from "../agents/identity";
import { createEventStore } from "../events/store";
import { createMailClient } from "../mail/client";
import { createMailStore } from "../mail/store";
import { openSessionStore } from "../sessions/compat";
import { createRunStore } from "../sessions/store";
import type { EventLevel, EventStore, SessionCheckpoint } from "../types";
import type { ApprovalContext } from "./approval";
import { evaluateCommandApproval, evaluateFileChangeApproval } from "./approval";
import { createDeltaBufferManager, normalizeItemCompleted, normalizeItemStarted } from "./events";
import { createRpcClient } from "./rpc-client";
import type {
	ApprovalRequest,
	BridgeConfig,
	ItemCompletedParams,
	ItemStartedParams,
	OutputDeltaParams,
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
		sessionId: env.OVERSTORY_SESSION_ID ?? "",
		serverUrl: env.OVERSTORY_CODEX_SERVER_URL ?? "ws://127.0.0.1:21816",
		model: env.OVERSTORY_CODEX_MODEL ?? "o3",
		compactionThreshold: Number(env.OVERSTORY_COMPACTION_THRESHOLD ?? "0.8"),
		maxDeltaBufferBytes: Number(env.OVERSTORY_MAX_DELTA_BUFFER ?? "1048576"),
		approvalTimeoutMs: Number(env.OVERSTORY_APPROVAL_TIMEOUT ?? "60000"),
		fileScope: (env.OVERSTORY_FILE_SCOPE ?? "").split(",").filter(Boolean),
		projectRoot: env.OVERSTORY_PROJECT_ROOT ?? "",
	};
}

/** Determine if a turn status means the agent is done */
export function shouldShutdown(status: string): boolean {
	return status === "completed" || status === "failed" || status === "cancelled";
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
async function buildInitialPrompt(config: BridgeConfig, overstoryDir: string): Promise<string> {
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

/**
 * Run the bridge process for a single worker agent.
 * Connects to the Codex App Server, starts a thread+turn, handles notifications,
 * and shuts down cleanly when the turn reaches a terminal state.
 */
export async function runBridge(config: BridgeConfig): Promise<void> {
	const overstoryDir = join(config.projectRoot, ".overstory");
	const eventStore = createEventStore(join(overstoryDir, "events.db"));
	const mailStore = createMailStore(join(overstoryDir, "mail.db"));
	const mailClient = createMailClient(mailStore);

	const rpc = await createRpcClient(config.serverUrl);

	// Initialize the server session
	await rpc.request("initialize", {});

	// Start a new thread for this agent
	const threadResult = (await rpc.request("thread/start", {
		cwd: config.worktreePath,
		model: config.model,
		sandboxPolicy: { type: "dangerFullAccess" },
		approvalPolicy: "on-request",
	})) as ThreadStartResult;

	const threadId = threadResult.threadId;

	// Delta buffer manager for accumulating streamed output per item
	const deltaManager = createDeltaBufferManager(config.maxDeltaBufferBytes);

	// Track item start times for duration calculation
	const itemStartTimes = new Map<string, number>();

	// Track the active turn ID so we can steer it on mail arrival
	let activeTurnId: string | null = null;

	// Shutdown signal: Promise-based instead of polling
	let shutdownRequested = false;
	let shutdownResolve: (() => void) | null = null;

	// Compaction tracking: accumulate modified files for checkpoint building
	const modifiedFiles = new Set<string>();
	let lastProgressSummary = "";
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
				const reply = messages.find((m) => {
					if (m.from !== config.parentAgent) return false;
					const subj = m.subject.toLowerCase();
					// Check for correlated reply (contains itemId marker)
					const isCorrelated = m.subject.includes(escalationMarker);
					// Check by type: result or status from parent
					const isApprovalType = m.type === "result" || m.type === "status";
					// Check by keyword in subject
					const hasApproveKeyword = subj.includes("approve") || subj.includes("accept");
					return hasApproveKeyword || (isCorrelated && isApprovalType);
				});
				if (reply) {
					parentApproved = true;
					break;
				}
				const rejection = messages.find((m) => {
					if (m.from !== config.parentAgent) return false;
					const subj = m.subject.toLowerCase();
					const isCorrelated = m.subject.includes(escalationMarker);
					const hasRejectKeyword = subj.includes("decline") || subj.includes("reject");
					return hasRejectKeyword || (isCorrelated && m.type === "error");
				});
				if (rejection) {
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
					turnId: activeTurnId,
					input: `New messages:\n${summary}`,
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

		// item/started — record tool_start event
		if (method === "item/started" || method.endsWith("/started")) {
			const started = p as ItemStartedParams | undefined;
			if (!started) return;
			itemStartTimes.set(started.itemId, Date.now());
			deltaManager.start(started.itemId, started.itemType, new Date().toISOString());

			const record = normalizeItemStarted({
				agentName: config.agentName,
				sessionId: config.sessionId,
				runId: config.runId,
				itemId: started.itemId,
				itemType: started.itemType,
				data: started.data,
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
			const delta = p as OutputDeltaParams | undefined;
			if (!delta) return;
			deltaManager.appendDelta(delta.itemId, delta.delta);
		}

		// item/completed — flush buffer, record tool_end event
		else if (method === "item/completed" || method.endsWith("/completed")) {
			const completed = p as ItemCompletedParams | undefined;
			if (!completed) return;

			const startTime = itemStartTimes.get(completed.itemId);
			itemStartTimes.delete(completed.itemId);
			const durationMs = startTime !== undefined ? Date.now() - startTime : null;

			const deltaOutput = deltaManager.flush(completed.itemId);

			const record = normalizeItemCompleted({
				agentName: config.agentName,
				sessionId: config.sessionId,
				runId: config.runId,
				itemId: completed.itemId,
				itemType: completed.itemType,
				status: completed.status,
				data: completed.data,
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
			if (completed.itemType === "fileChange") {
				const data = completed.data as { path?: string } | undefined;
				if (data?.path) {
					modifiedFiles.add(data.path);
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

		// turn/completed — check if we should shut down
		else if (method === "turn/completed") {
			const turn = p as TurnCompletedParams | undefined;
			if (!turn) return;

			activeTurnId = null;

			if (shouldShutdown(turn.status)) {
				shutdownRequested = true;
				shutdownResolve?.();
			}
		}

		// turn/started — track the active turn ID and check for pending messages
		else if (method === "turn/started") {
			const turn = p as { threadId: string; turnId: string } | undefined;
			if (turn) {
				activeTurnId = turn.turnId;
				// Check for messages that arrived between turns
				debouncedMailCheck();
			}
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
			if (usage.contextWindowSize > 0) {
				const ratio = usage.totalTokens / usage.contextWindowSize;
				const now = Date.now();
				if (
					ratio >= config.compactionThreshold &&
					now - lastCheckpointSaveMs >= CHECKPOINT_DEBOUNCE_MS
				) {
					lastCheckpointSaveMs = now;
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
		}

		// contextCompaction — Phase 2: post-compaction recovery.
		// Load the saved checkpoint and inject recovery context via turn/steer.
		else if (method === "contextCompaction" || method.endsWith("/contextCompaction")) {
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
						turnId: activeTurnId,
						input: recovery,
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

	// Build rich priming prompt (mirrors Claude path's beacon + SessionStart hook)
	const initialPrompt = await buildInitialPrompt(config, overstoryDir);

	// Start the initial turn with the agent's task instructions
	const turnStartResult = (await rpc.request("turn/start", {
		threadId,
		input: initialPrompt,
	})) as { turnId?: string } | undefined;

	// Capture initial turn ID if returned synchronously
	if (turnStartResult?.turnId !== undefined) {
		activeTurnId = turnStartResult.turnId;
	}

	// Write PID file so nudge can find the bridge process directly
	const pidFilePath = join(overstoryDir, "agents", config.agentName, "bridge.pid");
	try {
		await mkdir(join(overstoryDir, "agents", config.agentName), { recursive: true });
		await Bun.write(pidFilePath, String(process.pid));
	} catch {
		// Non-fatal: nudge will fall back to session PID
	}

	// SIGUSR1 handler: check mail and steer the active turn if there are messages
	process.on("SIGUSR1", () => {
		try {
			const messages = mailClient.check(config.agentName);
			if (messages.length === 0) return;
			if (activeTurnId === null) return;

			const summary = messages
				.map((m) => `[${m.from}] ${m.subject}: ${m.body.slice(0, 200)}`)
				.join("\n");

			rpc
				.request("turn/steer", {
					threadId,
					turnId: activeTurnId,
					input: `New messages:\n${summary}`,
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

	// Event loop: wait for shutdown signal (Promise-based instead of polling).
	// Also detect unexpected WebSocket closure as a shutdown trigger.
	await new Promise<void>((resolveShutdown) => {
		shutdownResolve = resolveShutdown;
		// If already requested before we set the resolve, fire immediately
		if (shutdownRequested) {
			resolveShutdown();
			return;
		}
		// Poll for WebSocket disconnection (rpc.closed set by close handler)
		const disconnectCheck = setInterval(() => {
			if (rpc.closed) {
				clearInterval(disconnectCheck);
				console.error("[bridge] WebSocket disconnected unexpectedly, shutting down");
				resolveShutdown();
			}
		}, 1000);
		// Clean up interval when shutdown resolves normally
		const origResolve = shutdownResolve;
		shutdownResolve = () => {
			clearInterval(disconnectCheck);
			origResolve?.();
		};
	});

	// Graceful shutdown: session-end bookkeeping
	try {
		// Record session_end event
		tryInsertEvent(eventStore, {
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

		// Update session state to "completed" in SessionStore
		try {
			const { store: sessionStore } = openSessionStore(overstoryDir);
			try {
				sessionStore.updateState(config.agentName, "completed");
			} finally {
				sessionStore.close();
			}
		} catch {
			// Non-fatal: session state update failure shouldn't block shutdown
		}

		// Increment identity.sessionsCompleted
		try {
			const identityBaseDir = join(overstoryDir, "agents");
			await updateIdentity(identityBaseDir, config.agentName, {
				sessionsCompleted: 1,
				completedTask: {
					beadId: config.beadId,
					summary: `Codex ${config.capability} agent completed task ${config.beadId}`,
				},
			});
		} catch {
			// Non-fatal: identity update failure shouldn't block shutdown
		}

		// Auto-record expertise (mirrors Stop hook's `mulch learn`)
		try {
			const mulchProc = Bun.spawn(["mulch", "learn"], {
				cwd: config.worktreePath,
				stdout: "pipe",
				stderr: "pipe",
			});
			await mulchProc.exited;
		} catch {
			// Non-fatal: mulch may not be installed or available
		}

		// Send worker_done mail to parent agent so they can verify and merge
		if (config.parentAgent) {
			try {
				mailClient.send({
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

		// Auto-nudge coordinator when a lead completes (mirrors log.ts session-end).
		// Writes a pending-nudge marker so the coordinator wakes up to process
		// merge_ready/worker_done messages without waiting for user input.
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

		// Auto-complete the current run when the coordinator exits (mirrors log.ts).
		// Handles the case where the coordinator process ends without explicit
		// `overstory coordinator stop`.
		if (config.capability === "coordinator") {
			try {
				const currentRunPath = join(overstoryDir, "current-run.txt");
				const currentRunFile = Bun.file(currentRunPath);
				if (await currentRunFile.exists()) {
					const runId = (await currentRunFile.text()).trim();
					if (runId.length > 0) {
						const runStore = createRunStore(join(overstoryDir, "sessions.db"));
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
	} catch {
		// Non-fatal: bookkeeping errors shouldn't prevent process exit
	}

	// Close connections
	rpc.close();
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
