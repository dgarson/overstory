import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	deleteServerState,
	isServerAlive,
	parseServerState,
	readServerState,
	writeServerState,
} from "./state.ts";

describe("parseServerState", () => {
	test("returns null for invalid JSON", () => {
		expect(parseServerState("not json")).toBeNull();
		expect(parseServerState("{bad}")).toBeNull();
		expect(parseServerState("")).toBeNull();
	});

	test("returns null when pid is missing", () => {
		const raw = JSON.stringify({
			port: 21817,
			startedAt: "2024-01-01T00:00:00.000Z",
			url: "http://localhost:21817",
		});
		expect(parseServerState(raw)).toBeNull();
	});

	test("returns null when port is missing", () => {
		const raw = JSON.stringify({
			pid: 1234,
			startedAt: "2024-01-01T00:00:00.000Z",
			url: "http://localhost:21817",
		});
		expect(parseServerState(raw)).toBeNull();
	});

	test("returns null when startedAt is missing", () => {
		const raw = JSON.stringify({ pid: 1234, port: 21817, url: "http://localhost:21817" });
		expect(parseServerState(raw)).toBeNull();
	});

	test("returns null when url is missing", () => {
		const raw = JSON.stringify({ pid: 1234, port: 21817, startedAt: "2024-01-01T00:00:00.000Z" });
		expect(parseServerState(raw)).toBeNull();
	});

	test("returns null when pid is not a number", () => {
		const raw = JSON.stringify({
			pid: "1234",
			port: 21817,
			startedAt: "2024-01-01T00:00:00.000Z",
			url: "http://localhost:21817",
		});
		expect(parseServerState(raw)).toBeNull();
	});

	test("parses valid state", () => {
		const raw = JSON.stringify({
			pid: 1234,
			port: 21817,
			startedAt: "2024-01-01T00:00:00.000Z",
			url: "http://localhost:21817",
		});
		const result = parseServerState(raw);
		expect(result).not.toBeNull();
		expect(result?.pid).toBe(1234);
		expect(result?.port).toBe(21817);
		expect(result?.startedAt).toBe("2024-01-01T00:00:00.000Z");
		expect(result?.url).toBe("http://localhost:21817");
	});

	test("ignores extra fields in valid JSON", () => {
		const raw = JSON.stringify({
			pid: 5000,
			port: 3000,
			startedAt: "2024-06-15T12:00:00.000Z",
			url: "http://localhost:3000",
			extraField: "ignored",
		});
		const result = parseServerState(raw);
		expect(result).not.toBeNull();
		expect(result?.pid).toBe(5000);
	});
});

describe("isServerAlive", () => {
	test("returns true for the current process PID", () => {
		const state = {
			pid: process.pid,
			port: 21817,
			startedAt: new Date().toISOString(),
			url: "http://localhost:21817",
		};
		expect(isServerAlive(state)).toBe(true);
	});

	test("returns false for a PID that does not exist", () => {
		// Use a very large PID that is extremely unlikely to exist
		const state = {
			pid: 9_999_999,
			port: 21817,
			startedAt: new Date().toISOString(),
			url: "http://localhost:21817",
		};
		expect(isServerAlive(state)).toBe(false);
	});

	test("returns false for PID <= 0", () => {
		const state = {
			pid: 0,
			port: 21817,
			startedAt: new Date().toISOString(),
			url: "http://localhost:21817",
		};
		expect(isServerAlive(state)).toBe(false);
	});

	test("returns false for negative PID", () => {
		const state = {
			pid: -1,
			port: 21817,
			startedAt: new Date().toISOString(),
			url: "http://localhost:21817",
		};
		expect(isServerAlive(state)).toBe(false);
	});
});

describe("readServerState / writeServerState / deleteServerState", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "ost-mcp-state-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("returns null if state file does not exist", async () => {
		const result = await readServerState(tempDir);
		expect(result).toBeNull();
	});

	test("writes then reads back state", async () => {
		const state = {
			pid: process.pid,
			port: 21817,
			startedAt: "2024-01-01T00:00:00.000Z",
			url: "http://localhost:21817",
		};
		await writeServerState(tempDir, state);
		const result = await readServerState(tempDir);
		expect(result).not.toBeNull();
		expect(result?.pid).toBe(state.pid);
		expect(result?.port).toBe(state.port);
		expect(result?.startedAt).toBe(state.startedAt);
		expect(result?.url).toBe(state.url);
	});

	test("overwrites an existing state file", async () => {
		const state1 = {
			pid: 1111,
			port: 1234,
			startedAt: "2024-01-01T00:00:00.000Z",
			url: "http://localhost:1234",
		};
		const state2 = {
			pid: 2222,
			port: 5678,
			startedAt: "2024-06-01T00:00:00.000Z",
			url: "http://localhost:5678",
		};

		await writeServerState(tempDir, state1);
		await writeServerState(tempDir, state2);

		const result = await readServerState(tempDir);
		expect(result?.pid).toBe(2222);
		expect(result?.port).toBe(5678);
	});

	test("deleteServerState removes the file", async () => {
		const state = {
			pid: process.pid,
			port: 21817,
			startedAt: new Date().toISOString(),
			url: "http://localhost:21817",
		};
		await writeServerState(tempDir, state);

		// Confirm it exists
		const before = await readServerState(tempDir);
		expect(before).not.toBeNull();

		await deleteServerState(tempDir);

		const after = await readServerState(tempDir);
		expect(after).toBeNull();
	});

	test("deleteServerState is idempotent (no error if file missing)", async () => {
		// File does not exist — should not throw
		await expect(deleteServerState(tempDir)).resolves.toBeUndefined();
	});
});
