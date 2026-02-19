import { describe, expect, test } from "bun:test";
import {
	isControlServerAlive,
	parseControlServerState,
} from "./server.ts";

describe("control/server", () => {
	test("parseControlServerState validates required fields", () => {
		const parsed = parseControlServerState(
			JSON.stringify({
				pid: 123,
				port: 21827,
				url: "http://127.0.0.1:21827",
				token: "abc",
				startedAt: "2026-02-19T00:00:00.000Z",
			}),
		);
		expect(parsed).not.toBeNull();
		expect(parsed?.port).toBe(21827);
	});

	test("parseControlServerState rejects malformed payload", () => {
		const parsed = parseControlServerState(
			JSON.stringify({
				pid: "bad",
				port: 21827,
			}),
		);
		expect(parsed).toBeNull();
	});

	test("isControlServerAlive returns false for invalid pid", () => {
		expect(
			isControlServerAlive({
				pid: -1,
				port: 21827,
				url: "http://127.0.0.1:21827",
				token: "abc",
				startedAt: "2026-02-19T00:00:00.000Z",
			}),
		).toBe(false);
	});
});
