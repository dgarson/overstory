import { Database } from "bun:sqlite";
import type {
	ControlAgent,
	ControlAgentRegistration,
	ControlNotification,
	EnqueueNotificationInput,
} from "./types.ts";

interface AgentRow {
	agent_name: string;
	session_id: string | null;
	runtime: string;
	driver_kind: string;
	tmux_session: string | null;
	pid: number | null;
	registered_at: string;
	last_seen_at: string;
	last_tool_at: string | null;
	tool_depth: number;
	io_epoch: number;
	last_nudge_at: string | null;
	nudge_lock_token: string | null;
	nudge_lock_expires_at: string | null;
}

interface NotificationRow {
	id: string;
	message_id: string | null;
	to_agent: string;
	from_agent: string;
	kind: string;
	subject: string;
	body: string;
	priority: string;
	payload: string | null;
	created_at: string;
	status: string;
	leased_by: string | null;
	lease_expires_at: string | null;
	acked_at: string | null;
	nudge_count: number;
	last_nudged_at: string | null;
	last_error: string | null;
}

function rowToAgent(row: AgentRow): ControlAgent {
	return {
		agentName: row.agent_name,
		sessionId: row.session_id,
		runtime: row.runtime as ControlAgent["runtime"],
		driverKind: row.driver_kind as ControlAgent["driverKind"],
		tmuxSession: row.tmux_session,
		pid: row.pid,
		registeredAt: row.registered_at,
		lastSeenAt: row.last_seen_at,
		lastToolAt: row.last_tool_at,
		toolDepth: row.tool_depth,
		ioEpoch: row.io_epoch,
		lastNudgeAt: row.last_nudge_at,
		nudgeLockToken: row.nudge_lock_token,
		nudgeLockExpiresAt: row.nudge_lock_expires_at,
	};
}

function rowToNotification(row: NotificationRow): ControlNotification {
	return {
		id: row.id,
		messageId: row.message_id,
		toAgent: row.to_agent,
		fromAgent: row.from_agent,
		kind: row.kind,
		subject: row.subject,
		body: row.body,
		priority: row.priority as ControlNotification["priority"],
		payload: row.payload,
		createdAt: row.created_at,
		status: row.status as ControlNotification["status"],
		leasedBy: row.leased_by,
		leaseExpiresAt: row.lease_expires_at,
		ackedAt: row.acked_at,
		nudgeCount: row.nudge_count,
		lastNudgedAt: row.last_nudged_at,
		lastError: row.last_error,
	};
}

function randomId(prefix: string): string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
	const bytes = new Uint8Array(12);
	crypto.getRandomValues(bytes);
	let out = prefix;
	for (const b of bytes) {
		out += chars[b % chars.length] ?? "0";
	}
	return out;
}

const CREATE_AGENTS_TABLE = `
CREATE TABLE IF NOT EXISTS control_agents (
  agent_name TEXT PRIMARY KEY,
  session_id TEXT,
  runtime TEXT NOT NULL CHECK(runtime IN ('claude','codex')),
  driver_kind TEXT NOT NULL CHECK(driver_kind IN ('claude-hooks','codex-bridge')),
  tmux_session TEXT,
  pid INTEGER,
  registered_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_tool_at TEXT,
  tool_depth INTEGER NOT NULL DEFAULT 0,
  io_epoch INTEGER NOT NULL DEFAULT 0,
  last_nudge_at TEXT,
  nudge_lock_token TEXT,
  nudge_lock_expires_at TEXT
)`;

const CREATE_NOTIFICATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS control_notifications (
  id TEXT PRIMARY KEY,
  message_id TEXT,
  to_agent TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  priority TEXT NOT NULL CHECK(priority IN ('low','normal','high','urgent')),
  payload TEXT,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','leased','acked')),
  leased_by TEXT,
  lease_expires_at TEXT,
  acked_at TEXT,
  nudge_count INTEGER NOT NULL DEFAULT 0,
  last_nudged_at TEXT,
  last_error TEXT
)`;

const CREATE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_control_agents_seen ON control_agents(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_control_agents_depth ON control_agents(tool_depth);
CREATE INDEX IF NOT EXISTS idx_control_notif_to_status ON control_notifications(to_agent, status, created_at);
CREATE INDEX IF NOT EXISTS idx_control_notif_lease ON control_notifications(status, lease_expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_control_notif_dedupe
ON control_notifications(to_agent, message_id) WHERE message_id IS NOT NULL;
`;

export interface ControlStore {
	upsertAgent(reg: ControlAgentRegistration): void;
	markOffline(agentName: string): void;
	touch(agentName: string): void;
	applyToolLifecycle(agentName: string, event: "enter" | "exit"): ControlAgent | null;
	getAgent(agentName: string): ControlAgent | null;
	listAgents(): ControlAgent[];
	enqueue(input: EnqueueNotificationInput): ControlNotification;
	leaseNotifications(
		agentName: string,
		leaseOwner: string,
		limit: number,
		leaseMs: number,
	): ControlNotification[];
	ackNotifications(agentName: string, leaseOwner: string, ids: string[]): void;
	releaseNotifications(agentName: string, leaseOwner: string, ids: string[]): void;
	reclaimExpiredLeases(): number;
	getTopPendingNotification(agentName: string): ControlNotification | null;
	getAgentsWithPendingNotifications(): string[];
	tryAcquireNudgeLock(params: {
		agentName: string;
		expectedIoEpoch: number;
		idleCutoffIso: string;
		lockToken: string;
		lockMs: number;
	}): boolean;
	finishNudgeLock(params: {
		agentName: string;
		lockToken: string;
		delivered: boolean;
		notificationId?: string;
		error?: string | null;
	}): void;
	markNotificationDelivery(params: {
		notificationId: string;
		delivered: boolean;
		error?: string | null;
	}): void;
	updateLastNudgeAt(agentName: string): void;
	close(): void;
}

export function createControlStore(dbPath: string): ControlStore {
	const db = new Database(dbPath);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA synchronous = NORMAL");
	db.exec("PRAGMA busy_timeout = 5000");
	db.exec(CREATE_AGENTS_TABLE);
	db.exec(CREATE_NOTIFICATIONS_TABLE);
	db.exec(CREATE_INDEXES);

	const upsertAgentStmt = db.prepare<
		void,
		{
			$agent_name: string;
			$session_id: string | null;
			$runtime: string;
			$driver_kind: string;
			$tmux_session: string | null;
			$pid: number | null;
			$now: string;
		}
	>(`
		INSERT INTO control_agents (
			agent_name, session_id, runtime, driver_kind, tmux_session, pid,
			registered_at, last_seen_at, last_tool_at, tool_depth, io_epoch
		) VALUES (
			$agent_name, $session_id, $runtime, $driver_kind, $tmux_session, $pid,
			$now, $now, NULL, 0, 0
		)
		ON CONFLICT(agent_name) DO UPDATE SET
			session_id = excluded.session_id,
			runtime = excluded.runtime,
			driver_kind = excluded.driver_kind,
			tmux_session = excluded.tmux_session,
			pid = excluded.pid,
			last_seen_at = excluded.last_seen_at
	`);

	const markOfflineStmt = db.prepare<void, { $agent_name: string; $now: string }>(`
		UPDATE control_agents
		SET session_id = NULL, pid = NULL, last_seen_at = $now,
		    nudge_lock_token = NULL, nudge_lock_expires_at = NULL
		WHERE agent_name = $agent_name
	`);

	const touchStmt = db.prepare<void, { $agent_name: string; $now: string }>(`
		UPDATE control_agents SET last_seen_at = $now WHERE agent_name = $agent_name
	`);

	const applyToolEnterStmt = db.prepare<void, { $agent_name: string; $now: string }>(`
		UPDATE control_agents
		SET tool_depth = tool_depth + 1,
		    io_epoch = io_epoch + 1,
		    last_tool_at = $now,
		    last_seen_at = $now
		WHERE agent_name = $agent_name
	`);

	const applyToolExitStmt = db.prepare<void, { $agent_name: string; $now: string }>(`
		UPDATE control_agents
		SET tool_depth = CASE WHEN tool_depth > 0 THEN tool_depth - 1 ELSE 0 END,
		    io_epoch = io_epoch + 1,
		    last_tool_at = $now,
		    last_seen_at = $now
		WHERE agent_name = $agent_name
	`);

	const getAgentStmt = db.prepare<AgentRow, { $agent_name: string }>(`
		SELECT * FROM control_agents WHERE agent_name = $agent_name
	`);

	const listAgentsStmt = db.prepare<AgentRow, []>(`
		SELECT * FROM control_agents ORDER BY agent_name ASC
	`);

	const insertNotificationStmt = db.prepare<
		void,
		{
			$id: string;
			$message_id: string | null;
			$to_agent: string;
			$from_agent: string;
			$kind: string;
			$subject: string;
			$body: string;
			$priority: string;
			$payload: string | null;
			$now: string;
		}
	>(`
		INSERT OR IGNORE INTO control_notifications (
			id, message_id, to_agent, from_agent, kind, subject, body, priority, payload,
			created_at, status, leased_by, lease_expires_at, acked_at, nudge_count, last_nudged_at, last_error
		) VALUES (
			$id, $message_id, $to_agent, $from_agent, $kind, $subject, $body, $priority, $payload,
			$now, 'pending', NULL, NULL, NULL, 0, NULL, NULL
		)
	`);

	const getNotificationByDedupeStmt = db.prepare<NotificationRow, { $to_agent: string; $message_id: string }>(`
		SELECT * FROM control_notifications
		WHERE to_agent = $to_agent AND message_id = $message_id
		ORDER BY created_at DESC
		LIMIT 1
	`);

	const getNotificationByIdStmt = db.prepare<NotificationRow, { $id: string }>(`
		SELECT * FROM control_notifications WHERE id = $id
	`);

	const reclaimExpiredStmt = db.prepare<void, { $now: string }>(`
		UPDATE control_notifications
		SET status = 'pending', leased_by = NULL, lease_expires_at = NULL
		WHERE status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at <= $now
	`);

	const pendingForAgentStmt = db.prepare<NotificationRow, { $to_agent: string; $limit: number }>(`
		SELECT * FROM control_notifications
		WHERE to_agent = $to_agent AND status = 'pending'
		ORDER BY
			CASE priority
				WHEN 'urgent' THEN 3
				WHEN 'high' THEN 2
				WHEN 'normal' THEN 1
				ELSE 0
			END DESC,
			created_at ASC
		LIMIT $limit
	`);

	const leaseByIdStmt = db.prepare<
		void,
		{
			$id: string;
			$leased_by: string;
			$lease_expires_at: string;
		}
	>(`
		UPDATE control_notifications
		SET status = 'leased', leased_by = $leased_by, lease_expires_at = $lease_expires_at
		WHERE id = $id AND status = 'pending'
	`);

	const ackByIdStmt = db.prepare<
		void,
		{
			$id: string;
			$to_agent: string;
			$leased_by: string;
			$acked_at: string;
		}
	>(`
		UPDATE control_notifications
		SET status = 'acked', leased_by = NULL, lease_expires_at = NULL, acked_at = $acked_at
		WHERE id = $id AND to_agent = $to_agent AND status = 'leased' AND leased_by = $leased_by
	`);

	const releaseByIdStmt = db.prepare<
		void,
		{
			$id: string;
			$to_agent: string;
			$leased_by: string;
		}
	>(`
		UPDATE control_notifications
		SET status = 'pending', leased_by = NULL, lease_expires_at = NULL
		WHERE id = $id AND to_agent = $to_agent AND status = 'leased' AND leased_by = $leased_by
	`);

	const agentsWithPendingStmt = db.prepare<{ to_agent: string }, []>(`
		SELECT DISTINCT to_agent
		FROM control_notifications
		WHERE status = 'pending'
		ORDER BY to_agent ASC
	`);

	const topPendingForAgentStmt = db.prepare<NotificationRow, { $to_agent: string }>(`
		SELECT * FROM control_notifications
		WHERE to_agent = $to_agent AND status = 'pending'
		ORDER BY
			CASE priority
				WHEN 'urgent' THEN 3
				WHEN 'high' THEN 2
				WHEN 'normal' THEN 1
				ELSE 0
			END DESC,
			created_at ASC
		LIMIT 1
	`);

	const tryAcquireNudgeLockStmt = db.prepare<
		void,
		{
			$agent_name: string;
			$expected_io_epoch: number;
			$idle_cutoff: string;
			$lock_token: string;
			$lock_expires_at: string;
			$now: string;
		}
	>(`
		UPDATE control_agents
		SET nudge_lock_token = $lock_token, nudge_lock_expires_at = $lock_expires_at
		WHERE agent_name = $agent_name
		  AND tool_depth = 0
		  AND io_epoch = $expected_io_epoch
		  AND (
			last_tool_at IS NULL OR last_tool_at <= $idle_cutoff
		  )
		  AND (
			nudge_lock_token IS NULL OR nudge_lock_expires_at IS NULL OR nudge_lock_expires_at <= $now
		  )
	`);

	const clearNudgeLockStmt = db.prepare<
		void,
		{
			$agent_name: string;
			$lock_token: string;
			$now: string;
			$delivered: number;
		}
	>(`
		UPDATE control_agents
		SET nudge_lock_token = NULL,
		    nudge_lock_expires_at = NULL,
		    last_nudge_at = CASE WHEN $delivered = 1 THEN $now ELSE last_nudge_at END
		WHERE agent_name = $agent_name AND nudge_lock_token = $lock_token
	`);

	const markNotificationNudgedStmt = db.prepare<
		void,
		{
			$id: string;
			$now: string;
			$error: string | null;
			$mark_acked: number;
		}
	>(`
		UPDATE control_notifications
		SET nudge_count = nudge_count + 1,
		    last_nudged_at = $now,
		    last_error = $error,
		    status = CASE WHEN $mark_acked = 1 THEN 'acked' ELSE status END,
		    acked_at = CASE WHEN $mark_acked = 1 THEN $now ELSE acked_at END,
		    leased_by = CASE WHEN $mark_acked = 1 THEN NULL ELSE leased_by END,
		    lease_expires_at = CASE WHEN $mark_acked = 1 THEN NULL ELSE lease_expires_at END
		WHERE id = $id
	`);

	const updateLastNudgeAtStmt = db.prepare<void, { $agent_name: string; $now: string }>(`
		UPDATE control_agents SET last_nudge_at = $now WHERE agent_name = $agent_name
	`);

	const leaseTx = db.transaction(
		(agentName: string, leaseOwner: string, limit: number, leaseExpiresAt: string) => {
			const selected = pendingForAgentStmt.all({
				$to_agent: agentName,
				$limit: limit,
			});
			for (const row of selected) {
				leaseByIdStmt.run({
					$id: row.id,
					$leased_by: leaseOwner,
					$lease_expires_at: leaseExpiresAt,
				});
			}
			const leasedRows: NotificationRow[] = [];
			for (const row of selected) {
				const leased = getNotificationByIdStmt.get({ $id: row.id });
				if (leased && leased.status === "leased" && leased.leased_by === leaseOwner) {
					leasedRows.push(leased);
				}
			}
			return leasedRows.map(rowToNotification);
		},
	);

	return {
		upsertAgent(reg: ControlAgentRegistration): void {
			const now = new Date().toISOString();
			upsertAgentStmt.run({
				$agent_name: reg.agentName,
				$session_id: reg.sessionId,
				$runtime: reg.runtime,
				$driver_kind: reg.driverKind,
				$tmux_session: reg.tmuxSession,
				$pid: reg.pid,
				$now: now,
			});
		},

		markOffline(agentName: string): void {
			markOfflineStmt.run({
				$agent_name: agentName,
				$now: new Date().toISOString(),
			});
		},

		touch(agentName: string): void {
			touchStmt.run({
				$agent_name: agentName,
				$now: new Date().toISOString(),
			});
		},

		applyToolLifecycle(agentName: string, event: "enter" | "exit"): ControlAgent | null {
			const now = new Date().toISOString();
			if (event === "enter") {
				applyToolEnterStmt.run({ $agent_name: agentName, $now: now });
			} else {
				applyToolExitStmt.run({ $agent_name: agentName, $now: now });
			}
			const row = getAgentStmt.get({ $agent_name: agentName });
			return row ? rowToAgent(row) : null;
		},

		getAgent(agentName: string): ControlAgent | null {
			const row = getAgentStmt.get({ $agent_name: agentName });
			return row ? rowToAgent(row) : null;
		},

		listAgents(): ControlAgent[] {
			return listAgentsStmt.all().map(rowToAgent);
		},

		enqueue(input: EnqueueNotificationInput): ControlNotification {
			const now = new Date().toISOString();
			const id = randomId("cn-");
			insertNotificationStmt.run({
				$id: id,
				$message_id: input.messageId ?? null,
				$to_agent: input.toAgent,
				$from_agent: input.fromAgent,
				$kind: input.kind,
				$subject: input.subject,
				$body: input.body,
				$priority: input.priority,
				$payload: input.payload ?? null,
				$now: now,
			});

			// Dedupe path (INSERT OR IGNORE skipped write).
			if (input.messageId) {
				const deduped = getNotificationByDedupeStmt.get({
					$to_agent: input.toAgent,
					$message_id: input.messageId,
				});
				if (deduped) return rowToNotification(deduped);
			}

			const inserted = getNotificationByIdStmt.get({ $id: id });
			if (!inserted) {
				throw new Error(`Failed to enqueue control notification: ${id}`);
			}
			return rowToNotification(inserted);
		},

		leaseNotifications(
			agentName: string,
			leaseOwner: string,
			limit: number,
			leaseMs: number,
		): ControlNotification[] {
			const safeLimit = Math.max(1, Math.min(limit, 100));
			this.reclaimExpiredLeases();
			const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
			return leaseTx(agentName, leaseOwner, safeLimit, leaseExpiresAt);
		},

		ackNotifications(agentName: string, leaseOwner: string, ids: string[]): void {
			const now = new Date().toISOString();
			for (const id of ids) {
				ackByIdStmt.run({
					$id: id,
					$to_agent: agentName,
					$leased_by: leaseOwner,
					$acked_at: now,
				});
			}
		},

		releaseNotifications(agentName: string, leaseOwner: string, ids: string[]): void {
			for (const id of ids) {
				releaseByIdStmt.run({
					$id: id,
					$to_agent: agentName,
					$leased_by: leaseOwner,
				});
			}
		},

			reclaimExpiredLeases(): number {
				const now = new Date().toISOString();
				const result = reclaimExpiredStmt.run({ $now: now });
				return result.changes;
			},

		getTopPendingNotification(agentName: string): ControlNotification | null {
			const row = topPendingForAgentStmt.get({ $to_agent: agentName });
			return row ? rowToNotification(row) : null;
		},

		getAgentsWithPendingNotifications(): string[] {
			return agentsWithPendingStmt.all().map((row) => row.to_agent);
		},

		tryAcquireNudgeLock(params): boolean {
			const now = new Date().toISOString();
			const lockExpiresAt = new Date(Date.now() + params.lockMs).toISOString();
			tryAcquireNudgeLockStmt.run({
				$agent_name: params.agentName,
				$expected_io_epoch: params.expectedIoEpoch,
				$idle_cutoff: params.idleCutoffIso,
				$lock_token: params.lockToken,
				$lock_expires_at: lockExpiresAt,
				$now: now,
			});
			const row = getAgentStmt.get({ $agent_name: params.agentName });
			return row?.nudge_lock_token === params.lockToken;
		},

		finishNudgeLock(params): void {
			const now = new Date().toISOString();
			clearNudgeLockStmt.run({
				$agent_name: params.agentName,
				$lock_token: params.lockToken,
				$now: now,
				$delivered: params.delivered ? 1 : 0,
			});
			if (params.notificationId) {
				markNotificationNudgedStmt.run({
					$id: params.notificationId,
					$now: now,
					$error: params.error ?? null,
					$mark_acked: params.delivered ? 1 : 0,
				});
			}
		},

		markNotificationDelivery(params): void {
			const now = new Date().toISOString();
			markNotificationNudgedStmt.run({
				$id: params.notificationId,
				$now: now,
				$error: params.error ?? null,
				$mark_acked: params.delivered ? 1 : 0,
			});
		},

		updateLastNudgeAt(agentName: string): void {
			updateLastNudgeAtStmt.run({
				$agent_name: agentName,
				$now: new Date().toISOString(),
			});
		},

		close(): void {
			db.close();
		},
	};
}
