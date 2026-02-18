// src/codex/server.test.ts
import { expect, test } from "bun:test";
import { isServerAlive, parseServerState } from "./server";

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

test("isServerAlive returns true for own process PID", () => {
	expect(isServerAlive({ pid: process.pid, port: 21816, startedAt: "", url: "" })).toBe(true);
});
