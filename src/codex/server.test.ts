// src/codex/server.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getServerStatePath, isServerAlive, parseServerState, readServerState } from "./server";

test("parseServerState validates required fields", () => {
	const valid = {
		pid: 1234,
		port: 21816,
		startedAt: "2024-01-01T00:00:00Z",
		url: "ws://127.0.0.1:21816",
	};
	expect(parseServerState(JSON.stringify(valid))).toEqual(valid);
});

test("parseServerState returns null for invalid JSON", () => {
	expect(parseServerState("not json")).toBeNull();
	expect(parseServerState('{"pid":"string"}')).toBeNull();
});

test("parseServerState returns null when required fields are missing", () => {
	expect(parseServerState('{"pid":1234,"port":21816}')).toBeNull();
	expect(parseServerState("{}")).toBeNull();
});

test("isServerAlive returns false for dead PID", () => {
	// Use PID 99999999 which almost certainly doesn't exist
	expect(isServerAlive({ pid: 99999999, port: 21816, startedAt: "", url: "" })).toBe(false);
});

test("isServerAlive returns false for pid=0 sentinel (external server)", () => {
	// pid=0 means we connected to a server we didn't start — never report it as alive
	expect(isServerAlive({ pid: 0, port: 21816, startedAt: "", url: "" })).toBe(false);
});

test("isServerAlive returns true for own process PID", () => {
	expect(isServerAlive({ pid: process.pid, port: 21816, startedAt: "", url: "" })).toBe(true);
});

describe("getServerStatePath", () => {
	test("returns correct path", () => {
		const result = getServerStatePath("/fake/.overstory");
		expect(result).toBe("/fake/.overstory/codex-server.json");
	});
});

describe("readServerState", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		for (const dir of tempDirs) {
			await rm(dir, { recursive: true, force: true });
		}
		tempDirs.length = 0;
	});

	async function makeTempDir(): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), "server-test-"));
		tempDirs.push(dir);
		return dir;
	}

	test("reads existing valid state file", async () => {
		const dir = await makeTempDir();
		const stateData = {
			pid: process.pid,
			port: 9999,
			startedAt: "2026-01-01T00:00:00Z",
			url: "ws://127.0.0.1:9999",
		};
		await writeFile(join(dir, "codex-server.json"), JSON.stringify(stateData));

		const result = await readServerState(dir);

		expect(result).not.toBeNull();
		expect(result?.pid).toBe(process.pid);
		expect(result?.port).toBe(9999);
		expect(result?.startedAt).toBe("2026-01-01T00:00:00Z");
		expect(result?.url).toBe("ws://127.0.0.1:9999");
	});

	test("returns null when file is missing", async () => {
		const dir = await makeTempDir();
		const result = await readServerState(dir);
		expect(result).toBeNull();
	});

	test("returns null for corrupted JSON", async () => {
		const dir = await makeTempDir();
		await writeFile(join(dir, "codex-server.json"), "not valid json {{{");

		const result = await readServerState(dir);
		expect(result).toBeNull();
	});

	test("returns null when required fields are missing", async () => {
		const dir = await makeTempDir();
		await writeFile(join(dir, "codex-server.json"), JSON.stringify({ pid: 123 }));

		const result = await readServerState(dir);
		expect(result).toBeNull();
	});
});
