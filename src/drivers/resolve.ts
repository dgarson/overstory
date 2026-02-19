import { OverstoryError } from "../errors";
import type { AgentRuntime, OverstoryConfig } from "../types";
import type { AgentDriver } from "./types";

export type DriverName = "claude" | "codex-bridge" | "codex-daemon";

/**
 * At spawn time: resolve which runtime to persist on the session.
 * This is the ONLY place where codex.intraProcess is consulted.
 * The result is stored on session.runtime and used for all future lookups.
 *
 * Resolution order:
 * 1. runtimeFlag (explicit CLI override) takes priority
 * 2. config.codex.defaultRuntime[capability] (per-capability config)
 * 3. "claude" (default fallback)
 *
 * "codex-daemon" is always passed through as-is.
 * "codex" + intraProcess=true is upgraded to "codex-daemon".
 */
export function resolveRuntimeForSpawn(
	capability: string,
	config: {
		codex?: { defaultRuntime?: Partial<Record<string, AgentRuntime>>; intraProcess?: boolean };
	},
	runtimeFlag?: AgentRuntime,
): AgentRuntime {
	const base = runtimeFlag ?? config.codex?.defaultRuntime?.[capability] ?? "claude";
	// "codex-daemon" flag is explicit — pass through
	if (base === "codex-daemon") return "codex-daemon";
	// "codex" + intraProcess=true → upgrade to "codex-daemon"
	if (base === "codex" && config.codex?.intraProcess) return "codex-daemon";
	return base;
}

/**
 * At operation time: map persisted session.runtime to driver name.
 * Never consults codex.intraProcess — the session already knows which driver spawned it.
 *
 * "codex" maps to "codex-bridge" because the bridge driver manages the per-agent
 * Codex subprocess. "codex-daemon" maps to itself — the sidecar daemon driver.
 */
export function resolveDriverName(runtime: AgentRuntime): DriverName {
	switch (runtime) {
		case "claude":
			return "claude";
		case "codex":
			return "codex-bridge";
		case "codex-daemon":
			return "codex-daemon";
	}
}

/**
 * At spawn time: resolve runtime from config + flags, then construct the driver.
 * Call this in sling.ts when an agent is being spawned.
 *
 * @param capability - Agent capability (e.g. "builder", "scout")
 * @param config - Full OverstoryConfig
 * @param runtimeFlag - Optional explicit runtime override from CLI flag
 * @returns The resolved runtime (to persist on the session) and driver instance
 */
export async function resolveDriverForSpawn(
	capability: string,
	config: OverstoryConfig,
	runtimeFlag?: AgentRuntime,
): Promise<{ runtime: AgentRuntime; driver: AgentDriver }> {
	const runtime = resolveRuntimeForSpawn(capability, config, runtimeFlag);
	const driver = await resolveDriverForSession(runtime, config);
	return { runtime, driver };
}

/**
 * At operation time: map persisted session.runtime to a driver instance.
 * Call this in nudge.ts, inspect, shutdown, etc. where the runtime is already known.
 *
 * Never consults codex.intraProcess — the session already resolved the runtime at spawn.
 *
 * @param runtime - The runtime stored on the session
 * @param config - Full OverstoryConfig (needed for driver factory deps)
 * @returns Constructed driver for the given runtime
 */
export async function resolveDriverForSession(
	runtime: AgentRuntime,
	_config: OverstoryConfig,
): Promise<AgentDriver> {
	const driverName = resolveDriverName(runtime);
	switch (driverName) {
		case "claude": {
			const { createClaudeDriver } = await import("./claude.ts");
			return createClaudeDriver();
		}
		case "codex-bridge": {
			const { CodexBridgeDriver, makeCodexBridgeDriverDeps } = await import("./codex-bridge.ts");
			const deps = await makeCodexBridgeDriverDeps();
			return new CodexBridgeDriver(deps);
		}
		case "codex-daemon":
			throw new OverstoryError(
				"CodexDaemonDriver is not yet implemented (Task 13)",
				"NOT_IMPLEMENTED",
			);
	}
}
