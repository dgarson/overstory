// src/codex/bridge.ts
// Per-worker bridge adapter process. Mediates between overstory and the shared
// Codex App Server via JSON-RPC 2.0 over WebSocket. Run via Bun.spawn from sling.ts.
import { join } from "node:path";
import type {
	ApprovalRequest,
	BridgeConfig,
	CodexItemType,
	ItemCompletedParams,
	ItemStartedParams,
	OutputDeltaParams,
	ThreadStartResult,
	TokenUsageParams,
	TurnCompletedParams,
	TurnSteerParams,
} from "./types";
import { createRpcClient } from "./rpc-client";
import type { ApprovalContext } from "./approval";
import { evaluateCommandApproval, evaluateFileChangeApproval } from "./approval";
import { createDeltaBufferManager, normalizeItemCompleted, normalizeItemStarted } from "./events";
import { createEventStore } from "../events/store";
import { createMailStore } from "../mail/store";
import { createMailClient } from "../mail/client";
import type { EventStore } from "../types";

/** Parse bridge config from environment variables */
export function parseBridgeConfig(
	env: Record<string, string | undefined>,
): BridgeConfig {
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
function tryInsertEvent(
	eventStore: EventStore,
	event: Parameters<EventStore["insert"]>[0],
): void {
	try {
		eventStore.insert(event);
	} catch {
		// Fire-and-forget: event recording errors are non-fatal
	}
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

	// Shutdown flag set when a terminal turn/completed notification arrives
	let shutdownRequested = false;

	// Approval context for this agent
	const approvalCtx: ApprovalContext = {
		capability: config.capability,
		agentName: config.agentName,
		worktreePath: config.worktreePath,
		fileScope: config.fileScope,
	};

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

			tryInsertEvent(eventStore, {
				runId: record.runId,
				agentName: record.agentName,
				sessionId: record.sessionId,
				eventType: "tool_start",
				toolName: record.toolName,
				toolArgs: record.toolArgs,
				toolDurationMs: null,
				level: record.level as "debug" | "info" | "warn" | "error",
				data: record.data,
			});
		}

		// outputDelta — accumulate delta per item
		else if (method.includes("outputDelta") || method === "outputDelta") {
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

			tryInsertEvent(eventStore, {
				runId: record.runId,
				agentName: record.agentName,
				sessionId: record.sessionId,
				eventType: "tool_end",
				toolName: record.toolName,
				toolArgs: record.toolArgs,
				toolDurationMs: record.toolDurationMs,
				level: record.level as "debug" | "info" | "warn" | "error",
				data: record.data,
			});
		}

		// requestApproval — evaluate and respond
		else if (method.includes("requestApproval")) {
			const req = p as ApprovalRequest | undefined;
			if (!req) return;

			let decision: string;
			let reason: string | undefined;

			if (req.type === "fileChange" && req.changes) {
				const result = evaluateFileChangeApproval(req.changes, approvalCtx);
				if (result.decision === "escalate") {
					// Treat escalate as decline until escalation mail is wired up
					decision = "decline";
					reason = result.reason;
				} else {
					decision = result.decision;
					reason = result.decision !== "accept" ? result.reason : undefined;
				}
			} else {
				const command = req.command ?? "";
				const result = evaluateCommandApproval(command, approvalCtx);
				if (result.decision === "escalate") {
					decision = "decline";
					reason = result.reason;
				} else {
					decision = result.decision;
					reason = result.decision !== "accept" ? result.reason : undefined;
				}
			}

			// Respond asynchronously (fire-and-forget for the response call)
			const respondParams: Record<string, unknown> = {
				threadId: req.threadId,
				itemId: req.itemId,
				decision,
			};
			if (reason !== undefined) {
				respondParams.reason = reason;
			}
			rpc.request("approval/respond", respondParams).catch((err: unknown) => {
				console.error("[bridge] approval/respond failed:", err);
			});
		}

		// turn/completed — check if we should shut down
		else if (method === "turn/completed") {
			const turn = p as TurnCompletedParams | undefined;
			if (!turn) return;

			activeTurnId = null;

			if (shouldShutdown(turn.status)) {
				shutdownRequested = true;
			}
		}

		// turn/started — track the active turn ID
		else if (method === "turn/started") {
			const turn = p as { threadId: string; turnId: string } | undefined;
			if (turn) {
				activeTurnId = turn.turnId;
			}
		}

		// token usage updates — log for observability
		else if (method.includes("tokenUsage") || method === "thread/tokenUsage/updated") {
			const usage = p as TokenUsageParams | undefined;
			if (!usage) return;
			console.log(
				`[bridge] token usage: input=${usage.inputTokens} output=${usage.outputTokens}` +
					` total=${usage.totalTokens} ctx=${usage.contextWindowSize}`,
			);
		}
	});

	// Start the initial turn with the agent's task instructions
	const turnStartResult = (await rpc.request("turn/start", {
		threadId,
		input: `You are ${config.agentName} (${config.capability} agent). Your task ID is ${config.beadId}. Begin your work.`,
	})) as { turnId?: string } | undefined;

	// Capture initial turn ID if returned synchronously
	if (turnStartResult?.turnId !== undefined) {
		activeTurnId = turnStartResult.turnId;
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

			const steerParams: TurnSteerParams = {
				threadId,
				turnId: activeTurnId,
				input: `New messages:\n${summary}`,
			};

			rpc.request("turn/steer", steerParams as unknown as Record<string, unknown>).catch(
				(err: unknown) => {
					console.error("[bridge] turn/steer failed:", err);
				},
			);
		} catch (err) {
			console.error("[bridge] SIGUSR1 handler error:", err);
		}
	});

	// Event loop: wait until shutdown is requested
	while (!shutdownRequested) {
		await Bun.sleep(500);
	}

	// Graceful shutdown
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
