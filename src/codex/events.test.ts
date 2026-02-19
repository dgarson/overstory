// src/codex/events.test.ts
import { describe, expect, test } from "bun:test";
import { createDeltaBufferManager, normalizeItemStarted, normalizeToolName } from "./events";

describe("normalizeToolName", () => {
	test("maps commandExecution to Bash", () => {
		expect(normalizeToolName("commandExecution")).toBe("Bash");
	});

	test("maps fileChange add to Write", () => {
		expect(normalizeToolName("fileChange", "add")).toBe("Write");
	});

	test("maps fileChange update to Edit", () => {
		expect(normalizeToolName("fileChange", "update")).toBe("Edit");
	});

	test("maps webSearch to WebSearch", () => {
		expect(normalizeToolName("webSearch")).toBe("WebSearch");
	});
});

describe("createDeltaBufferManager", () => {
	test("accumulates deltas and flushes on complete", () => {
		const mgr = createDeltaBufferManager(1_048_576);

		mgr.start("item-1", "commandExecution", "2024-01-01T00:00:00Z");
		mgr.appendDelta("item-1", "hello ");
		mgr.appendDelta("item-1", "world");

		const result = mgr.flush("item-1");
		expect(result).toBeDefined();
		expect(result?.output).toBe("hello world");
		expect(result?.totalBytes).toBe(11);
		expect(result?.truncated).toBe(false);
	});

	test("truncates when exceeding max buffer size", () => {
		const mgr = createDeltaBufferManager(10); // 10 byte max

		mgr.start("item-1", "commandExecution", "2024-01-01T00:00:00Z");
		mgr.appendDelta("item-1", "12345678901234567890");

		const result = mgr.flush("item-1");
		expect(result).toBeDefined();
		expect(result?.truncated).toBe(true);
		expect(result?.totalBytes).toBe(20);
	});

	test("returns null for unknown item", () => {
		const mgr = createDeltaBufferManager(1_048_576);
		expect(mgr.flush("nonexistent")).toBeNull();
	});
});

describe("normalizeItemStarted", () => {
	test("normalizes commandExecution to tool_start", () => {
		const event = normalizeItemStarted({
			agentName: "builder-1",
			sessionId: "sess-1",
			runId: "run-1",
			itemId: "item-1",
			itemType: "commandExecution",
			data: { command: "bun test" },
		});
		expect(event.eventType).toBe("tool_start");
		expect(event.toolName).toBe("Bash");
		expect(event.toolArgs).toContain("bun test");
	});
});
