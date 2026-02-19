import { describe, expect, test } from "bun:test";
import { resolveRuntimeForSpawn, resolveDriverName } from "./resolve";

describe("resolveRuntimeForSpawn", () => {
	test("returns 'claude' when no codex config", () => {
		expect(resolveRuntimeForSpawn("builder", { codex: undefined })).toBe("claude");
	});

	test("returns 'codex' when capability mapped to codex and intraProcess is false", () => {
		const config = { codex: { defaultRuntime: { builder: "codex" }, intraProcess: false } };
		expect(resolveRuntimeForSpawn("builder", config)).toBe("codex");
	});

	test("returns 'codex-daemon' when capability mapped to codex and intraProcess is true", () => {
		const config = { codex: { defaultRuntime: { builder: "codex" }, intraProcess: true } };
		expect(resolveRuntimeForSpawn("builder", config)).toBe("codex-daemon");
	});

	test("runtime flag overrides config", () => {
		const config = { codex: { defaultRuntime: { builder: "claude" }, intraProcess: false } };
		expect(resolveRuntimeForSpawn("builder", config, "codex")).toBe("codex");
	});

	test("runtime flag 'codex' with intraProcess=true still resolves to codex-daemon", () => {
		const config = { codex: { defaultRuntime: {}, intraProcess: true } };
		expect(resolveRuntimeForSpawn("builder", config, "codex")).toBe("codex-daemon");
	});

	test("runtime flag 'codex-daemon' is passed through as-is", () => {
		const config = { codex: { defaultRuntime: {}, intraProcess: false } };
		expect(resolveRuntimeForSpawn("builder", config, "codex-daemon")).toBe("codex-daemon");
	});
});

describe("resolveDriverName", () => {
	test("returns 'claude' for runtime 'claude'", () => {
		expect(resolveDriverName("claude")).toBe("claude");
	});

	test("returns 'codex-bridge' for runtime 'codex'", () => {
		expect(resolveDriverName("codex")).toBe("codex-bridge");
	});

	test("returns 'codex-daemon' for runtime 'codex-daemon'", () => {
		expect(resolveDriverName("codex-daemon")).toBe("codex-daemon");
	});
});
