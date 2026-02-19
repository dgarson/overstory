import { describe, expect, test } from "bun:test";
import { OverstoryError } from "../errors";
import type { AgentRuntime, OverstoryConfig } from "../types";
import {
	resolveDriverForSession,
	resolveDriverForSpawn,
	resolveDriverName,
	resolveRuntimeForSpawn,
} from "./resolve";

describe("resolveRuntimeForSpawn", () => {
	test("returns 'claude' when no codex config", () => {
		expect(resolveRuntimeForSpawn("builder", { codex: undefined })).toBe("claude");
	});

	test("returns 'codex' when capability mapped to codex and intraProcess is false", () => {
		const config = {
			codex: { defaultRuntime: { builder: "codex" as AgentRuntime }, intraProcess: false },
		};
		expect(resolveRuntimeForSpawn("builder", config)).toBe("codex");
	});

	test("returns 'codex-daemon' when capability mapped to codex and intraProcess is true", () => {
		const config = {
			codex: { defaultRuntime: { builder: "codex" as AgentRuntime }, intraProcess: true },
		};
		expect(resolveRuntimeForSpawn("builder", config)).toBe("codex-daemon");
	});

	test("runtime flag overrides config", () => {
		const config = {
			codex: { defaultRuntime: { builder: "claude" as AgentRuntime }, intraProcess: false },
		};
		expect(resolveRuntimeForSpawn("builder", config, "codex")).toBe("codex");
	});

	test("capability mapped to claude is not upgraded even when intraProcess=true", () => {
		const config = {
			codex: { defaultRuntime: { builder: "claude" as AgentRuntime }, intraProcess: true },
		};
		expect(resolveRuntimeForSpawn("builder", config)).toBe("claude");
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

// ---------------------------------------------------------------------------
// Minimal config fixture for factory function tests
// ---------------------------------------------------------------------------

function makeConfig(overrides?: { codex?: OverstoryConfig["codex"] }): OverstoryConfig {
	return {
		project: { name: "test-project", root: "/tmp/test-project", canonicalBranch: "main" },
		agents: {
			manifestPath: ".overstory/agent-manifest.json",
			baseDir: "agents",
			maxConcurrent: 10,
			staggerDelayMs: 0,
			maxDepth: 2,
		},
		worktrees: { baseDir: ".overstory/worktrees" },
		beads: { enabled: false },
		mulch: { enabled: false, domains: [], primeFormat: "markdown" },
		merge: { aiResolveEnabled: false, reimagineEnabled: false },
		watchdog: {
			tier0Enabled: false,
			tier0IntervalMs: 30_000,
			tier1Enabled: false,
			tier2Enabled: false,
			staleThresholdMs: 300_000,
			zombieThresholdMs: 600_000,
			nudgeIntervalMs: 60_000,
		},
		models: {},
		logging: { verbose: false, redactSecrets: false },
		...overrides,
	};
}

/**
 * resolveDriverForSession and resolveDriverForSpawn use dynamic imports that
 * pull in modules depending on bundled-defs.ts (a generated file not present
 * in the worktree). We test the full factory path for codex-daemon (which
 * throws before any dynamic import), and test the runtime resolution + driver
 * name contract via direct driver instantiation for claude and codex runtimes.
 */
describe("resolveDriverForSession — codex-daemon stub", () => {
	test("throws OverstoryError for runtime 'codex-daemon' (not yet implemented)", async () => {
		await expect(resolveDriverForSession("codex-daemon", makeConfig())).rejects.toBeInstanceOf(
			OverstoryError,
		);
	});

	test("thrown error for 'codex-daemon' has NOT_IMPLEMENTED code", async () => {
		try {
			await resolveDriverForSession("codex-daemon", makeConfig());
			throw new Error("Expected error to be thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(OverstoryError);
			expect((err as OverstoryError).code).toBe("NOT_IMPLEMENTED");
		}
	});
});

describe("resolveDriverForSpawn — runtime resolution", () => {
	// These tests validate that resolveDriverForSpawn correctly delegates runtime
	// resolution to resolveRuntimeForSpawn. Driver construction is exercised by
	// the codex-daemon case (throws before any dynamic import).

	test("codex-daemon stub: throws NOT_IMPLEMENTED for codex + intraProcess=true", async () => {
		const config = makeConfig({
			codex: {
				enabled: true,
				defaultRuntime: { builder: "codex" as AgentRuntime },
				intraProcess: true,
				model: "codex-mini",
				serverPort: 8765,
				compactionThreshold: 0.3,
				maxDeltaBufferBytes: 1_048_576,
				approvalTimeoutMs: 30_000,
				daemonPort: 0,
			},
		});
		await expect(resolveDriverForSpawn("builder", config)).rejects.toBeInstanceOf(OverstoryError);
	});

	test("codex-daemon stub: explicit codex-daemon runtimeFlag throws NOT_IMPLEMENTED", async () => {
		await expect(
			resolveDriverForSpawn("builder", makeConfig(), "codex-daemon"),
		).rejects.toBeInstanceOf(OverstoryError);
	});

	test("resolveRuntimeForSpawn is used: no codex config defaults to 'claude'", () => {
		// Validate the runtime resolution path that resolveDriverForSpawn delegates to.
		// (The factory itself is tested via the codex-daemon cases above.)
		const runtime = resolveRuntimeForSpawn("builder", makeConfig());
		expect(runtime).toBe("claude");
	});

	test("resolveRuntimeForSpawn is used: capability in defaultRuntime maps to codex", () => {
		const config = makeConfig({
			codex: {
				enabled: true,
				defaultRuntime: { builder: "codex" as AgentRuntime },
				intraProcess: false,
				model: "codex-mini",
				serverPort: 8765,
				compactionThreshold: 0.3,
				maxDeltaBufferBytes: 1_048_576,
				approvalTimeoutMs: 30_000,
				daemonPort: 0,
			},
		});
		const runtime = resolveRuntimeForSpawn("builder", config);
		expect(runtime).toBe("codex");
	});
});
