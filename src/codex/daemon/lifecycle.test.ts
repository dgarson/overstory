import { describe, expect, test } from "bun:test";
import { generateToken, isDaemonAlive, parseDaemonState } from "./lifecycle.ts";

describe("parseDaemonState", () => {
	test("parses valid daemon state JSON", () => {
		const state = parseDaemonState(
			'{"pid":123,"port":21817,"startedAt":"2026-01-01","url":"http://127.0.0.1:21817","token":"abc"}',
		);
		expect(state?.pid).toBe(123);
		expect(state?.port).toBe(21817);
		expect(state?.token).toBe("abc");
	});

	test("returns null for invalid JSON", () => {
		expect(parseDaemonState("not json")).toBeNull();
	});

	test("returns null for missing required fields", () => {
		expect(parseDaemonState('{"pid":123}')).toBeNull();
	});
});

describe("isDaemonAlive", () => {
	test("returns false for non-existent PID", () => {
		expect(isDaemonAlive({ pid: 999999, port: 0, startedAt: "", url: "", token: "" })).toBe(false);
	});

	test("returns true for current process PID", () => {
		// The current process is definitely alive
		expect(isDaemonAlive({ pid: process.pid, port: 0, startedAt: "", url: "", token: "" })).toBe(
			true,
		);
	});
});

describe("generateToken", () => {
	test("generates a 32-byte hex token", () => {
		const token = generateToken();
		expect(token.length).toBe(64); // 32 bytes = 64 hex chars
		expect(/^[0-9a-f]+$/.test(token)).toBe(true);
	});

	test("generates unique tokens", () => {
		const t1 = generateToken();
		const t2 = generateToken();
		expect(t1).not.toBe(t2);
	});
});
