import type { AgentRuntime } from "../types";

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
