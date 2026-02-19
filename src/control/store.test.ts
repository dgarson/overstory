import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createControlStore } from "./store.ts";

describe("control/store", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-control-store-"));
	});

	afterEach(() => {
		// bun test temp dirs are cleaned by OS lifecycle
	});

	test("registers agent and tracks tool depth/epoch", () => {
		const store = createControlStore(join(tempDir, "control.db"));
		try {
			store.upsertAgent({
				agentName: "lead-1",
				sessionId: "session-1",
				runtime: "claude",
				driverKind: "claude-hooks",
				tmuxSession: "overstory-test-lead-1",
				pid: 1234,
			});

			const first = store.getAgent("lead-1");
			expect(first).not.toBeNull();
			expect(first?.toolDepth).toBe(0);
			expect(first?.ioEpoch).toBe(0);

			const afterEnter = store.applyToolLifecycle("lead-1", "enter");
			expect(afterEnter?.toolDepth).toBe(1);
			expect(afterEnter?.ioEpoch).toBe(1);

			const afterExit = store.applyToolLifecycle("lead-1", "exit");
			expect(afterExit?.toolDepth).toBe(0);
			expect(afterExit?.ioEpoch).toBe(2);
		} finally {
			store.close();
		}
	});

	test("dedupes notifications by message id + recipient", () => {
		const store = createControlStore(join(tempDir, "control.db"));
		try {
			const first = store.enqueue({
				messageId: "msg-1",
				toAgent: "coordinator",
				fromAgent: "lead-1",
				kind: "worker_done",
				subject: "done",
				body: "worker finished",
				priority: "high",
			});
			const second = store.enqueue({
				messageId: "msg-1",
				toAgent: "coordinator",
				fromAgent: "lead-1",
				kind: "worker_done",
				subject: "done",
				body: "worker finished",
				priority: "high",
			});

			expect(second.id).toBe(first.id);
			expect(store.getAgentsWithPendingNotifications()).toEqual(["coordinator"]);
		} finally {
			store.close();
		}
	});

	test("leases and acknowledges notifications", () => {
		const store = createControlStore(join(tempDir, "control.db"));
		try {
			store.enqueue({
				toAgent: "coordinator",
				fromAgent: "lead-1",
				kind: "merge_ready",
				subject: "ready",
				body: "ready to merge",
				priority: "urgent",
			});
			store.enqueue({
				toAgent: "coordinator",
				fromAgent: "lead-2",
				kind: "worker_done",
				subject: "done",
				body: "done",
				priority: "high",
			});

			const leased = store.leaseNotifications("coordinator", "lease-1", 10, 60_000);
			expect(leased).toHaveLength(2);
			expect(leased[0]?.priority).toBe("urgent");

			const ids = leased.map((n) => n.id);
			store.ackNotifications("coordinator", "lease-1", ids);
			expect(store.getTopPendingNotification("coordinator")).toBeNull();
		} finally {
			store.close();
		}
	});

	test("nudge lock enforces idle+epoch gate and releases correctly", () => {
		const store = createControlStore(join(tempDir, "control.db"));
		try {
			store.upsertAgent({
				agentName: "reviewer-1",
				sessionId: "session-r1",
				runtime: "claude",
				driverKind: "claude-hooks",
				tmuxSession: "overstory-test-reviewer-1",
				pid: 2222,
			});

			const agent = store.getAgent("reviewer-1");
			expect(agent).not.toBeNull();

			const token = "lock-1";
			const acquired = store.tryAcquireNudgeLock({
				agentName: "reviewer-1",
				expectedIoEpoch: agent?.ioEpoch ?? 0,
				idleCutoffIso: new Date(Date.now() + 1000).toISOString(),
				lockToken: token,
				lockMs: 5000,
			});
			expect(acquired).toBe(true);

			store.finishNudgeLock({
				agentName: "reviewer-1",
				lockToken: token,
				delivered: true,
			});
			const after = store.getAgent("reviewer-1");
			expect(after?.nudgeLockToken).toBeNull();
			expect(after?.lastNudgeAt).toBeTruthy();
		} finally {
			store.close();
		}
	});
});
