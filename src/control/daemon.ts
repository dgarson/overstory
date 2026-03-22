import { join } from "node:path";
import { isSessionAlive, sendKeys } from "../worktree/tmux.ts";
import { createControlStore } from "./store.ts";
import type { ControlStore } from "./store.ts";
import type {
	AwaitWorkResult,
	ControlAgent,
	ControlNotification,
	ControlServerState,
} from "./types.ts";

interface Waiter {
	leaseOwner: string;
	maxItems: number;
	resolve: (value: AwaitWorkResult & { leaseOwner: string }) => void;
	timer: ReturnType<typeof setTimeout>;
}

export interface ControlDaemonOptions {
	projectRoot: string;
	overstoryDir: string;
	port: number;
	token: string;
	loopIntervalMs: number;
	idleThresholdMs: number;
	leaseMs: number;
	nudgeCooldownMs: number;
}

interface SafeNudgeResult {
	delivered: boolean;
	deferred: boolean;
	reason?: string;
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function unauthorized(): Response {
	return json({ error: "unauthorized" }, 401);
}

function badRequest(reason: string): Response {
	return json({ error: reason }, 400);
}

function newLeaseOwner(agentName: string): string {
	const suffix = Math.random().toString(36).slice(2, 10);
	return `await-${agentName}-${suffix}`;
}

function nowIso(): string {
	return new Date().toISOString();
}

function isRecentlyNudged(agent: ControlAgent, nudgeCooldownMs: number): boolean {
	if (!agent.lastNudgeAt) return false;
	const elapsed = Date.now() - new Date(agent.lastNudgeAt).getTime();
	return elapsed < nudgeCooldownMs;
}

function idleCutoffIso(idleThresholdMs: number): string {
	return new Date(Date.now() - idleThresholdMs).toISOString();
}

async function sendTmuxNudge(tmuxSession: string, message: string): Promise<void> {
	const alive = await isSessionAlive(tmuxSession);
	if (!alive) {
		throw new Error(`tmux session not alive: ${tmuxSession}`);
	}
	await sendKeys(tmuxSession, message);
	await Bun.sleep(200);
	await sendKeys(tmuxSession, "");
}

function signalBridge(pid: number): void {
	process.kill(pid, 0);
	process.kill(pid, "SIGUSR1");
}

async function safeNudgeClaude(
	store: ControlStore,
	agent: ControlAgent,
	message: string,
	opts: { idleThresholdMs: number; nudgeCooldownMs: number; notificationId?: string },
): Promise<SafeNudgeResult> {
	if (!agent.tmuxSession) {
		return { delivered: false, deferred: false, reason: "missing_tmux_session" };
	}
	if (agent.toolDepth >= 1) {
		return { delivered: false, deferred: true, reason: "tool_depth_active" };
	}
	if (agent.lastToolAt) {
		const elapsed = Date.now() - new Date(agent.lastToolAt).getTime();
		if (elapsed < opts.idleThresholdMs) {
			return { delivered: false, deferred: true, reason: "recent_tool_activity" };
		}
	}
	if (isRecentlyNudged(agent, opts.nudgeCooldownMs)) {
		return { delivered: false, deferred: true, reason: "nudge_cooldown" };
	}

	const expectedIoEpoch = agent.ioEpoch;
	const lockToken = `lock-${Math.random().toString(36).slice(2, 12)}`;
	const acquired = store.tryAcquireNudgeLock({
		agentName: agent.agentName,
		expectedIoEpoch,
		idleCutoffIso: idleCutoffIso(opts.idleThresholdMs),
		lockToken,
		lockMs: 3000,
	});
	if (!acquired) {
		return { delivered: false, deferred: true, reason: "lock_acquire_failed" };
	}

	// Race hardening: re-check epoch/depth after lock acquisition before tmux write.
	await Bun.sleep(35);
	const rechecked = store.getAgent(agent.agentName);
	if (
		!rechecked ||
		rechecked.nudgeLockToken !== lockToken ||
		rechecked.toolDepth >= 1 ||
		rechecked.ioEpoch !== expectedIoEpoch
	) {
		store.finishNudgeLock({
			agentName: agent.agentName,
			lockToken,
			delivered: false,
			notificationId: opts.notificationId,
			error: "race_detected_before_send",
		});
		return { delivered: false, deferred: true, reason: "race_detected_before_send" };
	}

	try {
		await sendTmuxNudge(rechecked.tmuxSession ?? agent.tmuxSession, message);
		store.finishNudgeLock({
			agentName: agent.agentName,
			lockToken,
			delivered: true,
			notificationId: opts.notificationId,
		});
		return { delivered: true, deferred: false };
	} catch (err) {
		store.finishNudgeLock({
			agentName: agent.agentName,
			lockToken,
			delivered: false,
			notificationId: opts.notificationId,
			error: err instanceof Error ? err.message : String(err),
		});
		return {
			delivered: false,
			deferred: false,
			reason: err instanceof Error ? err.message : "tmux_send_failed",
		};
	}
}

async function safeNudgeCodex(
	store: ControlStore,
	agent: ControlAgent,
	opts: { nudgeCooldownMs: number; notificationId?: string },
): Promise<SafeNudgeResult> {
	if (agent.pid === null || agent.pid <= 0) {
		return { delivered: false, deferred: false, reason: "missing_bridge_pid" };
	}
	if (isRecentlyNudged(agent, opts.nudgeCooldownMs)) {
		return { delivered: false, deferred: true, reason: "nudge_cooldown" };
	}
	try {
		signalBridge(agent.pid);
		store.updateLastNudgeAt(agent.agentName);
		if (opts.notificationId) {
			store.markNotificationDelivery({
				notificationId: opts.notificationId,
				delivered: true,
			});
		}
		return { delivered: true, deferred: false };
	} catch (err) {
		if (opts.notificationId) {
			store.markNotificationDelivery({
				notificationId: opts.notificationId,
				delivered: false,
				error: err instanceof Error ? err.message : String(err),
			});
		}
		return {
			delivered: false,
			deferred: false,
			reason: err instanceof Error ? err.message : "sigusr1_failed",
		};
	}
}

function buildQueueNudgeMessage(agentName: string, notification: ControlNotification): string {
	return (
		`[OVERSTORY CONTROL] Priority mail from ${notification.fromAgent}: ` +
		`"${notification.subject}". Run: overstory mail check --agent ${agentName}`
	);
}

export async function runControlDaemon(options: ControlDaemonOptions): Promise<void> {
	const store = createControlStore(join(options.overstoryDir, "control.db"));
	const waiters = new Map<string, Waiter[]>();

	const flushWaiters = (agentName: string): void => {
		const queue = waiters.get(agentName);
		if (!queue || queue.length === 0) return;

		while (queue.length > 0) {
			const waiter = queue[0];
			if (!waiter) break;
			const leased = store.leaseNotifications(
				agentName,
				waiter.leaseOwner,
				waiter.maxItems,
				options.leaseMs,
			);
			if (leased.length === 0) break;
			queue.shift();
			clearTimeout(waiter.timer);
			waiter.resolve({
				timedOut: false,
				notifications: leased,
				leaseOwner: waiter.leaseOwner,
			});
		}

		if (queue.length === 0) {
			waiters.delete(agentName);
		}
	};

	const tryNudgePending = async (agentName: string): Promise<void> => {
		const agent = store.getAgent(agentName);
		if (!agent) return;

		const pending = store.getTopPendingNotification(agentName);
		if (!pending) return;

		if (agent.runtime === "codex") {
			await safeNudgeCodex(store, agent, {
				nudgeCooldownMs: options.nudgeCooldownMs,
				notificationId: pending.id,
			});
			return;
		}

		const result = await safeNudgeClaude(
			store,
			agent,
			buildQueueNudgeMessage(agentName, pending),
			{
				idleThresholdMs: options.idleThresholdMs,
				nudgeCooldownMs: options.nudgeCooldownMs,
				notificationId: pending.id,
			},
		);

		// Keep pending when deferred so the next sweep can retry safely.
		if (!result.delivered && !result.deferred) {
			store.markNotificationDelivery({
				notificationId: pending.id,
				delivered: false,
				error: result.reason ?? "nudge_failed",
			});
		}
	};

	const sweep = async (): Promise<void> => {
		store.reclaimExpiredLeases();
		for (const agentName of store.getAgentsWithPendingNotifications()) {
			flushWaiters(agentName);
			await tryNudgePending(agentName);
		}
	};

	const interval = setInterval(() => {
		sweep().catch(() => {
			// keep daemon alive on sweep errors
		});
	}, options.loopIntervalMs);

	const server = Bun.serve({
		port: options.port,
		idleTimeout: 30,
		fetch: async (req) => {
			const token = req.headers.get("x-overstory-control-token");
			if (token !== options.token) {
				return unauthorized();
			}

			const url = new URL(req.url);
			const path = url.pathname;

			if (req.method === "GET" && path === "/health") {
				return json({
					ok: true,
					ts: nowIso(),
				});
			}

			let body: Record<string, unknown> = {};
			if (req.method === "POST") {
				try {
					body = (await req.json()) as Record<string, unknown>;
				} catch {
					body = {};
				}
			}

			if (req.method === "POST" && path === "/register-agent") {
				const agentName = body.agentName;
				const runtime = body.runtime;
				const driverKind = body.driverKind;
				if (
					typeof agentName !== "string" ||
					(runtime !== "claude" && runtime !== "codex") ||
					(driverKind !== "claude-hooks" && driverKind !== "codex-bridge")
				) {
					return badRequest("invalid registration payload");
				}
				store.upsertAgent({
					agentName,
					sessionId: typeof body.sessionId === "string" ? body.sessionId : null,
					runtime,
					driverKind,
					tmuxSession: typeof body.tmuxSession === "string" ? body.tmuxSession : null,
					pid: typeof body.pid === "number" ? body.pid : null,
				});
				return json({ ok: true });
			}

			if (req.method === "POST" && path === "/mark-offline") {
				const agentName = body.agentName;
				if (typeof agentName !== "string") {
					return badRequest("agentName is required");
				}
				store.markOffline(agentName);
				return json({ ok: true });
			}

			if (req.method === "POST" && path === "/heartbeat") {
				const agentName = body.agentName;
				if (typeof agentName !== "string") {
					return badRequest("agentName is required");
				}
				store.touch(agentName);
				return json({ ok: true });
			}

			if (req.method === "POST" && path === "/tool-lifecycle") {
				const agentName = body.agentName;
				const event = body.event;
				if (
					typeof agentName !== "string" ||
					(event !== "enter" && event !== "exit")
				) {
					return badRequest("agentName and event(enter|exit) are required");
				}
				const updated = store.applyToolLifecycle(agentName, event);
				return json({ ok: true, state: updated });
			}

			if (req.method === "POST" && path === "/enqueue") {
				const toAgent = body.toAgent;
				const fromAgent = body.fromAgent;
				const kind = body.kind;
				const subject = body.subject;
				const bodyText = body.body;
				const priority = body.priority;
				if (
					typeof toAgent !== "string" ||
					typeof fromAgent !== "string" ||
					typeof kind !== "string" ||
					typeof subject !== "string" ||
					typeof bodyText !== "string" ||
					(priority !== "low" &&
						priority !== "normal" &&
						priority !== "high" &&
						priority !== "urgent")
				) {
					return badRequest("invalid enqueue payload");
				}

				const queued = store.enqueue({
					messageId: typeof body.messageId === "string" ? body.messageId : null,
					toAgent,
					fromAgent,
					kind,
					subject,
					body: bodyText,
					priority,
					payload: typeof body.payload === "string" ? body.payload : null,
				});
				flushWaiters(toAgent);
				await tryNudgePending(toAgent);
				return json({ ok: true, notificationId: queued.id });
			}

			if (req.method === "POST" && path === "/drain") {
				const agentName = body.agentName;
				if (typeof agentName !== "string") {
					return badRequest("agentName is required");
				}
				const maxItems = typeof body.maxItems === "number" ? body.maxItems : 20;
				const leaseOwner =
					typeof body.leaseOwner === "string" ? body.leaseOwner : newLeaseOwner(agentName);
				const notifications = store.leaseNotifications(
					agentName,
					leaseOwner,
					maxItems,
					options.leaseMs,
				);
				return json({ ok: true, leaseOwner, notifications });
			}

			if (req.method === "POST" && path === "/await-work") {
				const agentName = body.agentName;
				if (typeof agentName !== "string") {
					return badRequest("agentName is required");
				}

				const timeoutMs =
					typeof body.timeoutMs === "number" ? Math.max(0, Math.floor(body.timeoutMs)) : 30000;
				const maxItems =
					typeof body.maxItems === "number" ? Math.max(1, Math.floor(body.maxItems)) : 20;
				const leaseOwner =
					typeof body.leaseOwner === "string" ? body.leaseOwner : newLeaseOwner(agentName);

				const immediate = store.leaseNotifications(
					agentName,
					leaseOwner,
					maxItems,
					options.leaseMs,
				);
				if (immediate.length > 0) {
					return json({
						ok: true,
						timedOut: false,
						leaseOwner,
						notifications: immediate,
					});
				}

				const result = await new Promise<AwaitWorkResult & { leaseOwner: string }>((resolve) => {
					const timer = setTimeout(() => {
						const queue = waiters.get(agentName);
						if (queue) {
							const idx = queue.findIndex((w) => w.resolve === resolve);
							if (idx !== -1) queue.splice(idx, 1);
							if (queue.length === 0) waiters.delete(agentName);
						}
						resolve({
							timedOut: true,
							notifications: [],
							leaseOwner,
						});
					}, timeoutMs);

					const entry: Waiter = {
						leaseOwner,
						maxItems,
						resolve,
						timer,
					};
					const queue = waiters.get(agentName) ?? [];
					queue.push(entry);
					waiters.set(agentName, queue);
				});

				return json({
					ok: true,
					timedOut: result.timedOut,
					leaseOwner: result.leaseOwner,
					notifications: result.notifications,
				});
			}

			if (req.method === "POST" && path === "/ack") {
				const agentName = body.agentName;
				const leaseOwner = body.leaseOwner;
				const ids = body.ids;
				if (
					typeof agentName !== "string" ||
					typeof leaseOwner !== "string" ||
					!Array.isArray(ids)
				) {
					return badRequest("agentName, leaseOwner and ids[] are required");
				}
				store.ackNotifications(
					agentName,
					leaseOwner,
					ids.filter((id): id is string => typeof id === "string"),
				);
				return json({ ok: true });
			}

			if (req.method === "POST" && path === "/release") {
				const agentName = body.agentName;
				const leaseOwner = body.leaseOwner;
				const ids = body.ids;
				if (
					typeof agentName !== "string" ||
					typeof leaseOwner !== "string" ||
					!Array.isArray(ids)
				) {
					return badRequest("agentName, leaseOwner and ids[] are required");
				}
				store.releaseNotifications(
					agentName,
					leaseOwner,
					ids.filter((id): id is string => typeof id === "string"),
				);
				return json({ ok: true });
			}

			if (req.method === "POST" && path === "/safe-nudge") {
				const agentName = body.agentName;
				const message = body.message;
				if (typeof agentName !== "string" || typeof message !== "string") {
					return badRequest("agentName and message are required");
				}
				const agent = store.getAgent(agentName);
				if (!agent) {
					return json({
						ok: true,
						delivered: false,
						deferred: false,
						reason: "agent_not_registered",
					});
				}
				const result =
					agent.runtime === "codex"
						? await safeNudgeCodex(store, agent, {
								nudgeCooldownMs: options.nudgeCooldownMs,
							})
						: await safeNudgeClaude(store, agent, message, {
								idleThresholdMs: options.idleThresholdMs,
								nudgeCooldownMs: options.nudgeCooldownMs,
							});
				return json({
					ok: true,
					delivered: result.delivered,
					deferred: result.deferred,
					reason: result.reason ?? null,
				});
			}

			if (req.method === "POST" && path === "/state") {
				const agentName = body.agentName;
				if (typeof agentName !== "string") {
					return badRequest("agentName is required");
				}
				return json({
					ok: true,
					agent: store.getAgent(agentName),
					topPending: store.getTopPendingNotification(agentName),
				});
			}

			return json({ error: "not_found" }, 404);
		},
	});

	// Prime a sweep once at startup.
	await sweep().catch(() => {
		// keep daemon alive
	});

	await new Promise<void>((resolve) => {
		const shutdown = (): void => {
			clearInterval(interval);
			server.stop(true);
			for (const queue of waiters.values()) {
				for (const waiter of queue) {
					clearTimeout(waiter.timer);
					waiter.resolve({
						timedOut: true,
						notifications: [],
						leaseOwner: waiter.leaseOwner,
					});
				}
			}
			waiters.clear();
			store.close();
			resolve();
		};
		process.on("SIGTERM", shutdown);
		process.on("SIGINT", shutdown);
	});
}

export function buildControlServerState(opts: {
	pid: number;
	port: number;
	token: string;
}): ControlServerState {
	return {
		pid: opts.pid,
		port: opts.port,
		token: opts.token,
		url: `http://127.0.0.1:${opts.port}`,
		startedAt: nowIso(),
	};
}
