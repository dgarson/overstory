# Pluggable Agent Drivers Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace inline runtime branching in sling/nudge with a pluggable AgentDriver interface, then add a CodexDaemonDriver for intra-process Codex agent management via a sidecar HTTP daemon.

**Architecture:** Strategy pattern with three AgentDriver implementations (ClaudeDriver, CodexBridgeDriver, CodexDaemonDriver). sling.ts resolves the driver at spawn time (persisting the runtime on the session), and all operation-time calls (nudge, inspect, shutdown) resolve the driver from the persisted session.runtime. A new sidecar daemon process manages Codex agents via multiplexed WebSocket connections to the App Server.

**Tech Stack:** TypeScript (strict), Bun runtime, bun:sqlite, Bun.serve() for daemon HTTP, bun:test for testing.

---

## Phase 1: Interface + Types Foundation

### Task 1: Extend AgentRuntime, add config types for intraProcess and daemonPort

**Files:**
- Modify: `src/types.ts:48-63` (CodexConfig interface, AgentRuntime type)
- Modify: `src/config.ts:51-59` (DEFAULT_CONFIG.codex)
- Modify: `src/config.ts:439-485` (validateCodexConfig)
- Modify: `src/config.test.ts` (add validation tests)
- Modify: `config.yaml.sample:47-56`

**Step 1: Write the failing tests**

Add tests in `src/config.test.ts` for the new fields:

```typescript
test("codex.intraProcess defaults to false", () => {
	const config = /* load a config with codex section */;
	expect(config.codex?.intraProcess).toBe(false);
});

test("codex.daemonPort defaults to 0", () => {
	const config = /* load a config with codex section */;
	expect(config.codex?.daemonPort).toBe(0);
});

test("rejects codex.daemonPort outside 0-65535", () => {
	// Write a config.yaml with daemonPort: -1
	expect(() => /* loadConfig */).toThrow("codex.daemonPort");
});

test("accepts codex.daemonPort of 0 for dynamic allocation", () => {
	// Write a config.yaml with daemonPort: 0
	const config = /* loadConfig */;
	expect(config.codex?.daemonPort).toBe(0);
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test src/config.test.ts`
Expected: FAIL — `intraProcess` and `daemonPort` don't exist on CodexConfig

**Step 3: Add the types and defaults**

In `src/types.ts`, extend `AgentRuntime` and add to `CodexConfig`:

```typescript
/** "codex-daemon" distinguishes daemon-managed agents from bridge agents at the session level */
export type AgentRuntime = "claude" | "codex" | "codex-daemon";

export interface CodexConfig {
	enabled: boolean;
	defaultRuntime: Partial<Record<string, AgentRuntime>>;
	serverPort: number;
	model: string;
	compactionThreshold: number;
	maxDeltaBufferBytes: number;
	approvalTimeoutMs: number;
	/** Use intra-process daemon instead of per-agent bridge processes */
	intraProcess: boolean;
	/** HTTP port for the CodexDaemon sidecar. 0 = dynamic (OS-assigned). */
	daemonPort: number;
}
```

In `src/config.ts` DEFAULT_CONFIG, add:

```typescript
codex: {
	enabled: false,
	defaultRuntime: {},
	serverPort: 21816,
	model: "gpt-5.3-codex",
	compactionThreshold: 0.8,
	maxDeltaBufferBytes: 1_048_576,
	approvalTimeoutMs: 60_000,
	intraProcess: false,
	daemonPort: 0,
},
```

In `src/config.ts` validateCodexConfig, add:

```typescript
// codex.daemonPort must be an integer 0-65535 (0 = dynamic OS-assigned port)
if (!Number.isInteger(codex.daemonPort) || codex.daemonPort < 0 || codex.daemonPort > 65535) {
	throw new ValidationError("codex.daemonPort must be an integer between 0 and 65535", {
		field: "codex.daemonPort",
		value: codex.daemonPort,
	});
}
```

In `config.yaml.sample`, add after `approvalTimeoutMs`:

```yaml
  intraProcess: false     # false = bridge (per-agent process), true = daemon (sidecar)
  daemonPort: 0           # 0 = dynamic (OS-assigned), >0 = fixed port
```

**Step 4: Run tests to verify they pass**

Run: `bun test src/config.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/types.ts src/config.ts src/config.test.ts config.yaml.sample
git commit --no-gpg-sign -m "feat: extend AgentRuntime with codex-daemon, add intraProcess + daemonPort config"
```

---

### Task 2: Create AgentDriver interface and types

**Files:**
- Create: `src/drivers/types.ts`

**Step 1: Write the types file**

```typescript
// src/drivers/types.ts
// AgentDriver interface: pluggable strategy for agent lifecycle management.
// Three implementations: ClaudeDriver, CodexBridgeDriver, CodexDaemonDriver.

import type { AgentRuntime, AgentSession, AgentState, OverlayConfig, OverstoryConfig } from "../types";

/** Context passed to the driver at spawn time. sling owns steps 1-11; driver handles 12+. */
export interface SpawnContext {
	config: OverstoryConfig;
	session: AgentSession;
	overlayConfig: OverlayConfig;
	worktreePath: string;
	branchName: string;
	tmuxSessionName: string;
	runId: string;
}

/** Result of a successful spawn */
export interface SpawnResult {
	pid: number;
	/** Opaque handle the driver can stash per-agent metadata in */
	driverState?: Record<string, unknown>;
}

/** Real-time snapshot of a running agent */
export interface AgentInspection {
	state: AgentState;
	lastActivity: string;
	recentToolCalls?: Array<{ name: string; startedAt: string; durationMs?: number }>;
	/** Only for tmux-based drivers (ClaudeDriver, CodexBridgeDriver) */
	tmuxCapture?: string;
	/** Only for codex-based drivers */
	activeThreadId?: string;
	/** Only for codex-based drivers */
	tokenUsage?: { input: number; output: number; total: number };
}

/** Options for nudge delivery */
export interface NudgeOptions {
	/** Skip debounce check (required for watchdog escalation nudges) */
	force?: boolean;
}

/** Nudge delivery result — preserves watchdog telemetry contract */
export interface NudgeResult {
	delivered: boolean;
	reason?: string;
}

/**
 * Pluggable agent lifecycle driver.
 *
 * sling handles shared setup (config, validation, worktree, overlay, identity,
 * session recording). The driver handles runtime-specific operations: spawning
 * the agent process, nudging, steering, inspecting, and shutting down.
 */
export interface AgentDriver {
	/** Human-readable name for this driver */
	readonly name: string;

	/** Launch an agent. sling handles steps 1-11; driver handles step 12+. */
	spawn(ctx: SpawnContext): Promise<SpawnResult>;

	/** Indirect: wake agent and have it check mail.
	 *  Returns NudgeResult with delivery status for watchdog telemetry. */
	nudge(agentName: string, message: string, from: string, opts?: NudgeOptions): Promise<NudgeResult>;

	/** Direct: inject a message into the agent's active turn/session.
	 *  Returns true if delivered, false if no active turn (caller should fall back to mail). */
	steer(agentName: string, input: string): Promise<boolean>;

	/** Get detailed runtime state for inspect/dashboard */
	inspect(agentName: string): Promise<AgentInspection>;

	/** Request graceful shutdown of an agent */
	shutdown(agentName: string): Promise<void>;

	/** Clean up driver-level resources (connections, daemon handles).
	 *  For CodexDaemonDriver: no-op (daemon lifecycle is independent).
	 *  For ClaudeDriver/CodexBridgeDriver: no-op (nothing to clean up). */
	close(): Promise<void>;
}
```

**Step 2: Verify types compile**

Run: `bun run typecheck`
Expected: PASS (types only, no runtime code to break)

**Step 3: Commit**

```bash
git add src/drivers/types.ts
git commit --no-gpg-sign -m "feat: add AgentDriver interface with NudgeOptions/NudgeResult types"
```

---

### Task 3: Create driver resolver (two-path resolution)

**Files:**
- Create: `src/drivers/resolve.ts`
- Create: `src/drivers/resolve.test.ts`

**Step 1: Write failing tests**

```typescript
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
```

**Step 2: Run tests to verify they fail**

Run: `bun test src/drivers/resolve.test.ts`
Expected: FAIL — module not found

**Step 3: Implement resolver**

Two resolution functions: one for spawn-time (consults config), one for operation-time (reads persisted runtime):

```typescript
// src/drivers/resolve.ts
import type { AgentRuntime, OverstoryConfig } from "../types";

export type DriverName = "claude" | "codex-bridge" | "codex-daemon";

/**
 * At spawn time: resolve which runtime to persist on the session.
 * This is the ONLY place where codex.intraProcess is consulted.
 * The result is stored on session.runtime and used for all future lookups.
 */
export function resolveRuntimeForSpawn(
	capability: string,
	config: { codex?: { defaultRuntime?: Partial<Record<string, AgentRuntime>>; intraProcess?: boolean } },
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
 * Never consults codex.intraProcess — the session knows which driver spawned it.
 */
export function resolveDriverName(runtime: AgentRuntime): DriverName {
	switch (runtime) {
		case "claude": return "claude";
		case "codex": return "codex-bridge";
		case "codex-daemon": return "codex-daemon";
	}
}
```

**Step 4: Run tests**

Run: `bun test src/drivers/resolve.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/drivers/resolve.ts src/drivers/resolve.test.ts
git commit --no-gpg-sign -m "feat: add two-path driver resolver (spawn-time + operation-time)"
```

---

## Phase 2: ClaudeDriver + CodexBridgeDriver (Extract from sling.ts)

### Task 4: Create ClaudeDriver with spawn

**Files:**
- Create: `src/drivers/claude.ts`
- Create: `src/drivers/claude.test.ts`

**Step 1: Write failing tests**

Test that `ClaudeDriver.spawn()` calls the expected functions (tmux createSession, writeOverlay, deployHooks, sendKeys). Use DI to inject fakes for tmux operations.

```typescript
import { describe, expect, test } from "bun:test";
import { ClaudeDriver } from "./claude";

describe("ClaudeDriver", () => {
	test("name is 'claude'", () => {
		const driver = new ClaudeDriver({ createSession: async () => 123, sendKeys: async () => {} });
		expect(driver.name).toBe("claude");
	});

	test("spawn calls createSession with claude command", async () => {
		const calls: string[] = [];
		const driver = new ClaudeDriver({
			createSession: async (name, cwd, cmd) => { calls.push(cmd); return 42; },
			sendKeys: async () => {},
		});
		const result = await driver.spawn(/* minimal SpawnContext */);
		expect(result.pid).toBe(42);
		expect(calls[0]).toContain("claude");
	});

	test("nudge returns NudgeResult with delivered status", async () => {
		let sentTo = "";
		const driver = new ClaudeDriver({
			createSession: async () => 0,
			sendKeys: async (session) => { sentTo = session; },
			isSessionAlive: async () => true,
		});
		const result = await driver.nudge("test-agent", "hello", "orchestrator");
		expect(result.delivered).toBe(true);
	});

	test("nudge with dead tmux returns delivered=false", async () => {
		const driver = new ClaudeDriver({
			createSession: async () => 0,
			sendKeys: async () => {},
			isSessionAlive: async () => false,
		});
		const result = await driver.nudge("test-agent", "hello", "orchestrator");
		expect(result.delivered).toBe(false);
		expect(result.reason).toBeDefined();
	});
});
```

Exact test code will adapt based on what's extractable from sling.ts. The key is DI for tmux operations.

**Step 2: Run tests to verify they fail**

Run: `bun test src/drivers/claude.test.ts`
Expected: FAIL — module not found

**Step 3: Implement ClaudeDriver**

Extract the Claude-specific spawn logic from `sling.ts:445-614`:
- `writeOverlay()` call (step 8b)
- `deployHooks()` call (step 9)
- `createSession()` with claude command (step 12e)
- Sleep + beacon + follow-up Enter (step 13b-c)

Also extract nudge logic from `nudge.ts:326-344` (`nudgeClaudeAgent`).

```typescript
// src/drivers/claude.ts
import type { AgentDriver, AgentInspection, NudgeOptions, NudgeResult, SpawnContext, SpawnResult } from "./types";

export interface ClaudeDriverDeps {
	createSession: (name: string, cwd: string, cmd: string, env?: Record<string, string>) => Promise<number>;
	sendKeys: (session: string, text: string) => Promise<void>;
	isSessionAlive?: (session: string) => Promise<boolean>;
	writeOverlay: typeof import("../agents/overlay").writeOverlay;
	deployHooks: typeof import("../agents/hooks-deployer").deployHooks;
	resolveModel: typeof import("../agents/manifest").resolveModel;
	buildBeacon: typeof import("../commands/sling").buildBeacon;
}

export class ClaudeDriver implements AgentDriver {
	readonly name = "claude";
	constructor(private deps: ClaudeDriverDeps) {}

	async spawn(ctx: SpawnContext): Promise<SpawnResult> {
		// Write overlay
		await this.deps.writeOverlay(ctx.worktreePath, ctx.overlayConfig, ctx.config.project.root);
		// Deploy hooks
		await this.deps.deployHooks(ctx.worktreePath, ctx.session.agentName, ctx.session.capability);
		// Resolve model and create tmux session
		// ... (extracted from sling.ts:536-614)
	}

	async nudge(agentName: string, message: string, _from: string, opts?: NudgeOptions): Promise<NudgeResult> {
		// tmux sendKeys with retry (extracted from nudge.ts)
		// Honor opts.force to skip debounce
		// Return { delivered, reason } instead of void
	}

	async steer(agentName: string, input: string): Promise<boolean> {
		// Same as nudge for Claude (no steer/nudge distinction)
		const result = await this.nudge(agentName, input, "steer");
		return result.delivered;
	}

	async inspect(_agentName: string): Promise<AgentInspection> {
		// Placeholder — will be filled in later tasks
		return { state: "working", lastActivity: new Date().toISOString() };
	}

	async shutdown(_agentName: string): Promise<void> {
		// Kill tmux session
	}

	async close(): Promise<void> {
		// No-op for ClaudeDriver
	}
}
```

**Step 4: Run tests**

Run: `bun test src/drivers/claude.test.ts`
Expected: PASS

**Step 5: Run quality gates**

Run: `bun run typecheck && bun run lint`

**Step 6: Commit**

```bash
git add src/drivers/claude.ts src/drivers/claude.test.ts
git commit --no-gpg-sign -m "feat: add ClaudeDriver (extracted from sling.ts claude path)"
```

---

### Task 5: Create CodexBridgeDriver with spawn

**Files:**
- Create: `src/drivers/codex-bridge.ts`
- Create: `src/drivers/codex-bridge.test.ts`

**Step 1: Write failing tests**

Similar pattern to ClaudeDriver: DI for tmux, startServer, writeAgentsOverlay, writeCodexConfig. Test that spawn calls expected functions with correct args. Nudge must also return NudgeResult.

```typescript
test("nudge returns NudgeResult after SIGUSR1", async () => {
	const driver = new CodexBridgeDriver(/* deps with mock kill */);
	const result = await driver.nudge("test-agent", "check mail", "orchestrator");
	expect(result.delivered).toBe(true);
});

test("nudge with force=true skips debounce", async () => {
	const driver = new CodexBridgeDriver(/* deps */);
	const result = await driver.nudge("test-agent", "escalation", "watchdog", { force: true });
	expect(result.delivered).toBe(true);
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test src/drivers/codex-bridge.test.ts`
Expected: FAIL

**Step 3: Implement CodexBridgeDriver**

Extract from `sling.ts:480-534`:
- `writeAgentsOverlay()` call (step 12a)
- `writeCodexConfig()` call (step 12b)
- `startServer()` call (step 12c)
- Bridge tmux spawn with env vars (step 12d)

Nudge: extract from `nudge.ts:259-321` (SIGUSR1 + mail). Return NudgeResult.

```typescript
// src/drivers/codex-bridge.ts
import type { AgentDriver, NudgeOptions, NudgeResult, SpawnContext, SpawnResult, AgentInspection } from "./types";

export interface CodexBridgeDriverDeps {
	createSession: (name: string, cwd: string, cmd: string, env?: Record<string, string>) => Promise<number>;
	startServer: typeof import("../codex/server").startServer;
	writeAgentsOverlay: typeof import("../codex/overlay").writeAgentsOverlay;
	writeCodexConfig: typeof import("../codex/config-gen").writeCodexConfig;
}

export class CodexBridgeDriver implements AgentDriver {
	readonly name = "codex-bridge";
	constructor(private deps: CodexBridgeDriverDeps) {}

	async nudge(agentName: string, message: string, _from: string, opts?: NudgeOptions): Promise<NudgeResult> {
		// SIGUSR1 to bridge PID + mail
		// Honor opts.force to skip debounce
		// Return { delivered, reason }
	}
	// ...
}
```

**Step 4: Run tests, typecheck, lint**

**Step 5: Commit**

```bash
git add src/drivers/codex-bridge.ts src/drivers/codex-bridge.test.ts
git commit --no-gpg-sign -m "feat: add CodexBridgeDriver (extracted from sling.ts codex path)"
```

---

## Phase 3: Wire Drivers into sling.ts + nudge.ts

### Task 6: Add resolveDriver factory function

**Files:**
- Modify: `src/drivers/resolve.ts`
- Modify: `src/drivers/resolve.test.ts`

**Step 1: Extend resolve.ts with full resolveDriver functions**

Add two factory functions matching the two resolution paths:

```typescript
import type { AgentDriver } from "./types";
import type { AgentRuntime, OverstoryConfig } from "../types";
import { ClaudeDriver } from "./claude";
import { CodexBridgeDriver } from "./codex-bridge";
import { CodexDaemonDriver } from "./codex-daemon";

/** At spawn time: config determines runtime, constructs the driver */
export function resolveDriverForSpawn(
	capability: string,
	config: OverstoryConfig,
	runtimeFlag?: AgentRuntime,
): { runtime: AgentRuntime; driver: AgentDriver } {
	const runtime = resolveRuntimeForSpawn(capability, config, runtimeFlag);
	const driver = resolveDriverForSession(runtime, config);
	return { runtime, driver };
}

/** At operation time: session.runtime determines driver */
export function resolveDriverForSession(runtime: AgentRuntime, config: OverstoryConfig): AgentDriver {
	const driverName = resolveDriverName(runtime);
	switch (driverName) {
		case "claude":
			return new ClaudeDriver(/* deps from config */);
		case "codex-bridge":
			return new CodexBridgeDriver(/* deps from config */);
		case "codex-daemon":
			return getCodexDaemonDriver(config); // singleton, reads daemon.json for URL/token
	}
}
```

**Step 2: Test with mock deps**

**Step 3: Commit**

```bash
git add src/drivers/resolve.ts src/drivers/resolve.test.ts
git commit --no-gpg-sign -m "feat: add resolveDriverForSpawn + resolveDriverForSession factories"
```

---

### Task 7: Refactor sling.ts to use drivers

**Files:**
- Modify: `src/commands/sling.ts`
- Modify: `src/commands/sling.test.ts` (if existing tests need updating)

**Step 1: Replace the if/else runtime fork**

Currently `sling.ts:442-557` has a try/catch wrapping the runtime fork. Replace the runtime-specific code (lines 445-557) with:

```typescript
// Resolve driver using two-path resolution — persist runtime on session
const { runtime, driver } = resolveDriverForSpawn(capability, config, runtimeFlag);

// Session is created with the resolved runtime (persisted for operation-time lookups)
const session = sessionStore.create({
	agentName,
	capability,
	runtime,  // "claude" | "codex" | "codex-daemon"
	tmuxSession: runtime === "codex-daemon" ? `daemon:${agentName}` : tmuxSessionName,
	// ... other fields
});

const result = await driver.spawn({
	config,
	session,
	overlayConfig,
	worktreePath,
	branchName,
	tmuxSessionName,
	runId,
});
pid = result.pid;
```

Key changes:
- Runtime is resolved via `resolveDriverForSpawn` (replaces inline `resolveRuntime`)
- Session records `"codex-daemon"` as runtime (not just `"codex"`)
- `tmuxSession` uses sentinel value `"daemon:<agentName>"` for daemon agents (avoids schema migration, keeps NOT NULL constraint)
- Driver handles everything from step 12 onward

Keep the try/catch for worktree cleanup on failure.

**Step 2: Run existing sling tests**

Run: `bun test src/commands/sling.test.ts`
Expected: PASS (pure function tests should be unaffected)

**Step 3: Run full test suite**

Run: `bun test`
Expected: PASS

**Step 4: Run quality gates**

Run: `bun run typecheck && bun run lint`

**Step 5: Commit**

```bash
git add src/commands/sling.ts src/commands/sling.test.ts
git commit --no-gpg-sign -m "refactor: replace sling.ts runtime fork with driver dispatch, persist runtime per-session"
```

---

### Task 8: Refactor nudge.ts to use driver.nudge()

**Files:**
- Modify: `src/commands/nudge.ts`

**Step 1: Replace runtime fork in nudgeAgent() with driver dispatch**

Currently `nudge.ts:373-376` has:

```typescript
const result =
	target.runtime === "codex"
		? await nudgeCodexAgent(...)
		: await nudgeClaudeAgent(...);
```

Replace with driver dispatch. The `nudgeClaudeAgent` and `nudgeCodexAgent` functions are **moved into** ClaudeDriver.nudge() and CodexBridgeDriver.nudge() respectively (Task 4 and 5). The nudge command becomes a thin wrapper:

```typescript
// Look up the session to get persisted runtime
const session = sessionStore.getByName(agentName);
if (!session) throw new NudgeError(`No active session for agent: ${agentName}`);

// Resolve driver from persisted session.runtime (never from config)
const driver = resolveDriverForSession(session.runtime ?? "claude", config);

// Delegate to the driver — all three runtimes handled uniformly
const result = await driver.nudge(agentName, message, from, { force });
```

This eliminates all runtime branching in nudge.ts. The driver handles the runtime-specific delivery mechanism (tmux sendKeys, SIGUSR1, HTTP POST).

**Critical: The nudge return type is now `NudgeResult`** (`{ delivered: boolean; reason?: string }`), matching what the existing code already returns and what the watchdog expects for telemetry.

**Step 2: Run full test suite**

Run: `bun test`
Expected: PASS

**Step 3: Commit**

```bash
git add src/commands/nudge.ts
git commit --no-gpg-sign -m "refactor: replace nudge.ts runtime fork with driver.nudge() dispatch"
```

---

### Task 9: Update watchdog to use driver resolution

**Files:**
- Modify: `src/watchdog/daemon.ts` (nudge calls)
- Modify: `src/watchdog/health.ts` (health evaluation)

**Step 1: Update daemon.ts nudge calls**

Currently `daemon.ts:539-543` calls `nudgeAgent()` directly with `force=true`. Update to resolve the driver from the session's persisted runtime:

```typescript
// Before (daemon.ts:539):
// const { delivered } = await nudgeAgent(root, agentName, message, true);

// After:
const session = sessionStore.getByName(agentName);
const driver = resolveDriverForSession(session?.runtime ?? "claude", config);
const { delivered, reason } = await driver.nudge(agentName, message, "watchdog", { force: true });
```

This ensures the watchdog routes nudges correctly for all three runtimes, including codex-daemon agents.

**Step 2: Add runtime-aware health evaluation in health.ts**

Currently ZFC Rule 1 (health.ts:126) kills agents with dead tmux sessions. Add a check before the tmux liveness evaluation:

```typescript
// Skip tmux liveness for daemon-managed agents — use daemon HTTP health instead
if (session.runtime === "codex-daemon") {
	return evaluateDaemonHealth(session, daemonUrl);
}
// ... existing tmux check for "claude" and "codex" agents
```

`evaluateDaemonHealth()` calls `GET /agents/:name` on the daemon and maps the response:
- Daemon reachable + agent found → use agent state from daemon
- Daemon reachable + agent not found → zombie (agent lost)
- Daemon unreachable → zombie (same severity as tmux dead)

Also add a daemon process health check:
- Read `.overstory/daemon.json` for daemon PID
- If PID is dead and there are active `codex-daemon` sessions → restart daemon

**Step 3: Write tests**

Test `evaluateDaemonHealth` with a fake Bun.serve daemon and various response scenarios.

**Step 4: Run quality gates**

Run: `bun test && bun run typecheck && bun run lint`

**Step 5: Commit**

```bash
git add src/watchdog/daemon.ts src/watchdog/health.ts
git commit --no-gpg-sign -m "feat: runtime-aware watchdog health + driver-based nudge resolution"
```

---

## Phase 4: Daemon Infrastructure

### Task 10: Create AgentPool

**Files:**
- Create: `src/codex/daemon/pool.ts`
- Create: `src/codex/daemon/pool.test.ts`

**Step 1: Write failing tests**

Test the pool operations with a mock RpcClient:

```typescript
import { describe, expect, test } from "bun:test";
import { createAgentPool } from "./pool";

describe("AgentPool", () => {
	test("add registers an agent by name", async () => {
		const pool = createAgentPool({ createRpcClient: async () => mockRpcClient() });
		await pool.add(makeBridgeConfig({ agentName: "test-agent" }));
		expect(pool.names()).toContain("test-agent");
	});

	test("get returns undefined for unknown agent", () => {
		const pool = createAgentPool({ createRpcClient: async () => mockRpcClient() });
		expect(pool.get("nonexistent")).toBeUndefined();
	});

	test("remove deletes agent from pool", async () => {
		const pool = createAgentPool({ createRpcClient: async () => mockRpcClient() });
		await pool.add(makeBridgeConfig({ agentName: "test-agent" }));
		await pool.remove("test-agent");
		expect(pool.get("test-agent")).toBeUndefined();
	});

	test("steer returns false when no active turn", async () => {
		const pool = createAgentPool({ createRpcClient: async () => mockRpcClient() });
		await pool.add(makeBridgeConfig({ agentName: "test-agent" }));
		const result = await pool.steer("test-agent", "hello");
		expect(result).toBe(false);
	});

	test("add rejects duplicate agent name", async () => {
		const pool = createAgentPool({ createRpcClient: async () => mockRpcClient() });
		await pool.add(makeBridgeConfig({ agentName: "dup" }));
		expect(pool.add(makeBridgeConfig({ agentName: "dup" }))).rejects.toThrow();
	});

	test("drain removes all agents", async () => {
		const pool = createAgentPool({ createRpcClient: async () => mockRpcClient() });
		await pool.add(makeBridgeConfig({ agentName: "a1" }));
		await pool.add(makeBridgeConfig({ agentName: "a2" }));
		await pool.drain();
		expect(pool.names()).toEqual([]);
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test src/codex/daemon/pool.test.ts`
Expected: FAIL

**Step 3: Implement AgentPool**

```typescript
// src/codex/daemon/pool.ts
import type { BridgeConfig } from "../types";
import type { RpcClient } from "../rpc-client";

export interface ManagedAgent {
	config: BridgeConfig;
	rpc: RpcClient;
	threadId: string;
	activeTurnId: string | null;
	state: "booting" | "working" | "completed" | "failed";
}

export interface AgentPoolDeps {
	createRpcClient: (url: string) => Promise<RpcClient>;
}

export interface AgentPool {
	add(config: BridgeConfig): Promise<void>;
	get(name: string): ManagedAgent | undefined;
	steer(name: string, input: string): Promise<boolean>;
	nudge(name: string, message: string, force?: boolean): Promise<{ delivered: boolean; reason?: string }>;
	remove(name: string): Promise<void>;
	names(): string[];
	drain(): Promise<void>;
}

export function createAgentPool(deps: AgentPoolDeps): AgentPool {
	const agents = new Map<string, ManagedAgent>();
	// ... implementation
}
```

**Step 4: Run tests**

Run: `bun test src/codex/daemon/pool.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/codex/daemon/pool.ts src/codex/daemon/pool.test.ts
git commit --no-gpg-sign -m "feat: add AgentPool for daemon-managed Codex agents"
```

---

### Task 11: Create daemon HTTP server with bearer token auth

**Files:**
- Create: `src/codex/daemon/server.ts`
- Create: `src/codex/daemon/server.test.ts`

**Step 1: Write failing tests**

Use real `Bun.serve()` on a random port. Test HTTP routes with `fetch`:

```typescript
import { describe, expect, test, afterEach } from "bun:test";
import { createDaemonServer } from "./server";

describe("DaemonServer", () => {
	let server: ReturnType<typeof createDaemonServer>;
	const TOKEN = "test-token-abc123";

	afterEach(() => { server?.stop(); });

	test("GET /health returns 200 without auth", async () => {
		server = createDaemonServer({ port: 0, pool: mockPool(), token: TOKEN });
		const res = await fetch(`${server.url}/health`);
		expect(res.status).toBe(200);
	});

	test("POST /agents returns 401 without bearer token", async () => {
		server = createDaemonServer({ port: 0, pool: mockPool(), token: TOKEN });
		const res = await fetch(`${server.url}/agents`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(makeBridgeConfig({ agentName: "new-agent" })),
		});
		expect(res.status).toBe(401);
	});

	test("POST /agents returns 201 with valid bearer token", async () => {
		const pool = mockPool();
		server = createDaemonServer({ port: 0, pool, token: TOKEN });
		const res = await fetch(`${server.url}/agents`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Authorization": `Bearer ${TOKEN}`,
			},
			body: JSON.stringify(makeBridgeConfig({ agentName: "new-agent" })),
		});
		expect(res.status).toBe(201);
		expect(pool.addCalls).toBe(1);
	});

	test("GET /agents returns list without auth (read-only)", async () => {
		server = createDaemonServer({ port: 0, pool: mockPool(), token: TOKEN });
		const res = await fetch(`${server.url}/agents`);
		const body = await res.json();
		expect(body).toEqual([]);
	});

	test("POST /agents/:name/nudge with force flag", async () => {
		const pool = mockPool();
		server = createDaemonServer({ port: 0, pool, token: TOKEN });
		const res = await fetch(`${server.url}/agents/test-agent/nudge`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Authorization": `Bearer ${TOKEN}`,
			},
			body: JSON.stringify({ message: "check mail", force: true }),
		});
		expect(res.status).toBe(200);
	});

	test("POST /shutdown drains pool and stops", async () => {
		const pool = mockPool();
		server = createDaemonServer({ port: 0, pool, token: TOKEN });
		const res = await fetch(`${server.url}/shutdown`, {
			method: "POST",
			headers: { "Authorization": `Bearer ${TOKEN}` },
		});
		expect(res.status).toBe(200);
		expect(pool.drainCalled).toBe(true);
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test src/codex/daemon/server.test.ts`
Expected: FAIL

**Step 3: Implement daemon server**

```typescript
// src/codex/daemon/server.ts
import type { AgentPool } from "./pool";
import type { Server } from "bun";

export interface DaemonServerOpts {
	port: number;
	pool: AgentPool;
	token: string;
	hostname?: string; // defaults to "127.0.0.1" (localhost only)
}

export function createDaemonServer(opts: DaemonServerOpts): Server {
	const { pool, token, hostname = "127.0.0.1" } = opts;

	function requireAuth(req: Request): Response | null {
		const auth = req.headers.get("authorization");
		if (auth !== `Bearer ${token}`) {
			return new Response("Unauthorized", { status: 401 });
		}
		return null;
	}

	return Bun.serve({
		port: opts.port,
		hostname,
		async fetch(req) {
			const url = new URL(req.url);
			const method = req.method;

			// GET /health — unauthenticated liveness check
			if (url.pathname === "/health" && method === "GET") {
				return Response.json({ status: "ok", agents: pool.names().length });
			}

			// GET /agents — unauthenticated read-only list
			if (url.pathname === "/agents" && method === "GET") {
				return Response.json(pool.names().map(n => ({
					name: n,
					state: pool.get(n)?.state,
				})));
			}

			// GET /agents/:name — unauthenticated read-only inspect
			const agentMatch = url.pathname.match(/^\/agents\/([^/]+)$/);
			if (agentMatch && method === "GET") {
				const agent = pool.get(agentMatch[1]!);
				if (!agent) return new Response("Not Found", { status: 404 });
				return Response.json(agent);
			}

			// --- Mutation endpoints require bearer token ---

			if (url.pathname === "/agents" && method === "POST") {
				const authErr = requireAuth(req);
				if (authErr) return authErr;
				const config = await req.json();
				await pool.add(config);
				return new Response(null, { status: 201 });
			}

			// POST /agents/:name/nudge
			const nudgeMatch = url.pathname.match(/^\/agents\/([^/]+)\/nudge$/);
			if (nudgeMatch && method === "POST") {
				const authErr = requireAuth(req);
				if (authErr) return authErr;
				const body = await req.json() as { message: string; force?: boolean };
				const result = await pool.nudge(nudgeMatch[1]!, body.message, body.force);
				return Response.json(result);
			}

			// POST /agents/:name/steer
			const steerMatch = url.pathname.match(/^\/agents\/([^/]+)\/steer$/);
			if (steerMatch && method === "POST") {
				const authErr = requireAuth(req);
				if (authErr) return authErr;
				const body = await req.json() as { input: string };
				const delivered = await pool.steer(steerMatch[1]!, body.input);
				return Response.json({ delivered });
			}

			// DELETE /agents/:name
			const deleteMatch = url.pathname.match(/^\/agents\/([^/]+)$/);
			if (deleteMatch && method === "DELETE") {
				const authErr = requireAuth(req);
				if (authErr) return authErr;
				await pool.remove(deleteMatch[1]!);
				return new Response(null, { status: 204 });
			}

			if (url.pathname === "/shutdown" && method === "POST") {
				const authErr = requireAuth(req);
				if (authErr) return authErr;
				await pool.drain();
				setTimeout(() => process.exit(0), 100);
				return Response.json({ status: "shutting_down" });
			}

			return new Response("Not Found", { status: 404 });
		},
	});
}
```

**Step 4: Run tests**

Run: `bun test src/codex/daemon/server.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/codex/daemon/server.ts src/codex/daemon/server.test.ts
git commit --no-gpg-sign -m "feat: add daemon HTTP server with bearer token auth"
```

---

### Task 12: Create daemon lifecycle manager (start/stop/health with file lock)

**Files:**
- Create: `src/codex/daemon/lifecycle.ts` (start/stop/health check from CLI side)
- Create: `src/codex/daemon/lifecycle.test.ts`

**Step 1: Write failing tests**

```typescript
import { describe, expect, test } from "bun:test";
import { parseDaemonState, isDaemonAlive, generateToken } from "./lifecycle";

describe("parseDaemonState", () => {
	test("parses valid daemon state JSON", () => {
		const state = parseDaemonState('{"pid":123,"port":21817,"startedAt":"2026-01-01","url":"http://127.0.0.1:21817","token":"abc"}');
		expect(state?.pid).toBe(123);
		expect(state?.port).toBe(21817);
		expect(state?.token).toBe("abc");
	});

	test("returns null for invalid JSON", () => {
		expect(parseDaemonState("not json")).toBeNull();
	});
});

describe("isDaemonAlive", () => {
	test("returns false for non-existent PID", () => {
		expect(isDaemonAlive({ pid: 999999, port: 0, startedAt: "", url: "", token: "" })).toBe(false);
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
```

**Step 2: Implement lifecycle functions**

Pattern matches `src/codex/server.ts` (readServerState, isServerAlive, startServer, stopServer) but for the daemon process. Key additions:

```typescript
// src/codex/daemon/lifecycle.ts

export interface DaemonState {
	pid: number;
	port: number;
	startedAt: string;
	url: string;
	token: string;
}

/** Generate a random 32-byte hex token for daemon auth */
export function generateToken(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Race-safe daemon startup using file lock.
 * Pattern: acquire lock → check daemon.json → start if needed → write daemon.json → release lock.
 */
export async function ensureDaemonRunning(overstoryDir: string, config: OverstoryConfig): Promise<DaemonState> {
	const lockPath = `${overstoryDir}/daemon.lock`;
	const statePath = `${overstoryDir}/daemon.json`;

	// Acquire file lock (Bun.file + atomic write pattern)
	// Check if daemon already running
	const existing = await readDaemonState(statePath);
	if (existing && isDaemonAlive(existing)) return existing;

	// Start daemon process
	const token = generateToken();
	const port = config.codex?.daemonPort ?? 0;
	const proc = Bun.spawn(["bun", "run", "src/codex/daemon/main.ts"], {
		cwd: /* repo root */,
		env: {
			OVERSTORY_DIR: overstoryDir,
			OVERSTORY_DAEMON_PORT: String(port),
			OVERSTORY_DAEMON_TOKEN: token,
			OVERSTORY_CODEX_SERVER_URL: `ws://127.0.0.1:${config.codex?.serverPort ?? 21816}`,
		},
		stdout: "pipe",
		stderr: "pipe",
	});

	// Wait for daemon to write state file, read actual port
	// Write daemon.json with mode 0600
	// Release lock
}
```

**Step 3: Implement daemon entry point (main.ts)**

```typescript
// src/codex/daemon/main.ts
// Entry point for the daemon sidecar process.
// Spawned by ensureDaemonRunning on first agent spawn.
if (import.meta.main) {
	const port = Number(process.env.OVERSTORY_DAEMON_PORT ?? "0");
	const overstoryDir = process.env.OVERSTORY_DIR ?? "";
	const serverUrl = process.env.OVERSTORY_CODEX_SERVER_URL ?? "ws://127.0.0.1:21816";
	const token = process.env.OVERSTORY_DAEMON_TOKEN ?? "";
	// Create pool, start server, write state file
}
```

**Step 4: Run tests, typecheck, lint**

**Step 5: Commit**

```bash
git add src/codex/daemon/main.ts src/codex/daemon/lifecycle.ts src/codex/daemon/lifecycle.test.ts
git commit --no-gpg-sign -m "feat: add daemon lifecycle manager with file lock + bearer token"
```

---

## Phase 5: CodexDaemonDriver

### Task 13: Create CodexDaemonDriver

**Files:**
- Create: `src/drivers/codex-daemon.ts`
- Create: `src/drivers/codex-daemon.test.ts`

**Step 1: Write failing tests**

Mock the HTTP calls to the daemon using a real Bun.serve as a fake:

```typescript
import { describe, expect, test } from "bun:test";
import { CodexDaemonDriver } from "./codex-daemon";

describe("CodexDaemonDriver", () => {
	test("name is 'codex-daemon'", () => {
		const driver = new CodexDaemonDriver({ daemonUrl: "http://localhost:0", token: "test" });
		expect(driver.name).toBe("codex-daemon");
	});

	test("spawn calls ensureDaemonRunning then POSTs to /agents", async () => {
		let posted = false;
		const fakeDaemon = Bun.serve({
			port: 0,
			fetch(req) {
				if (req.method === "POST" && new URL(req.url).pathname === "/agents") {
					// Verify bearer token
					expect(req.headers.get("authorization")).toBe("Bearer test-token");
					posted = true;
					return new Response(JSON.stringify({ pid: 42 }), { status: 201 });
				}
				return new Response("Not Found", { status: 404 });
			},
		});
		try {
			const driver = new CodexDaemonDriver({
				daemonUrl: `http://localhost:${fakeDaemon.port}`,
				token: "test-token",
				ensureDaemonRunning: async () => ({
					pid: 1, port: fakeDaemon.port, startedAt: "", url: `http://localhost:${fakeDaemon.port}`, token: "test-token",
				}),
			});
			const result = await driver.spawn(makeSpawnContext());
			expect(posted).toBe(true);
			expect(result.pid).toBe(42);
		} finally {
			fakeDaemon.stop();
		}
	});

	test("nudge returns NudgeResult from daemon", async () => {
		const fakeDaemon = Bun.serve({
			port: 0,
			fetch(req) {
				if (req.method === "POST" && new URL(req.url).pathname.endsWith("/nudge")) {
					return Response.json({ delivered: true });
				}
				return new Response("Not Found", { status: 404 });
			},
		});
		try {
			const driver = new CodexDaemonDriver({
				daemonUrl: `http://localhost:${fakeDaemon.port}`,
				token: "t",
			});
			const result = await driver.nudge("test-agent", "hello", "orch");
			expect(result.delivered).toBe(true);
		} finally {
			fakeDaemon.stop();
		}
	});

	test("nudge passes force flag to daemon", async () => {
		let receivedForce = false;
		const fakeDaemon = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method === "POST" && new URL(req.url).pathname.endsWith("/nudge")) {
					const body = await req.json() as { force?: boolean };
					receivedForce = body.force === true;
					return Response.json({ delivered: true });
				}
				return new Response("Not Found", { status: 404 });
			},
		});
		try {
			const driver = new CodexDaemonDriver({
				daemonUrl: `http://localhost:${fakeDaemon.port}`,
				token: "t",
			});
			await driver.nudge("test-agent", "escalation", "watchdog", { force: true });
			expect(receivedForce).toBe(true);
		} finally {
			fakeDaemon.stop();
		}
	});

	test("close is a no-op (does not POST /shutdown)", async () => {
		let shutdownCalled = false;
		const fakeDaemon = Bun.serve({
			port: 0,
			fetch(req) {
				if (new URL(req.url).pathname === "/shutdown") {
					shutdownCalled = true;
					return Response.json({ status: "shutting_down" });
				}
				return new Response("Not Found", { status: 404 });
			},
		});
		try {
			const driver = new CodexDaemonDriver({
				daemonUrl: `http://localhost:${fakeDaemon.port}`,
				token: "t",
			});
			await driver.close();
			expect(shutdownCalled).toBe(false);
		} finally {
			fakeDaemon.stop();
		}
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test src/drivers/codex-daemon.test.ts`
Expected: FAIL

**Step 3: Implement CodexDaemonDriver**

```typescript
// src/drivers/codex-daemon.ts
import type { AgentDriver, AgentInspection, NudgeOptions, NudgeResult, SpawnContext, SpawnResult } from "./types";
import { ensureDaemonRunning, type DaemonState } from "../codex/daemon/lifecycle";
import { writeAgentsOverlay } from "../codex/overlay";

export interface CodexDaemonDriverOpts {
	daemonUrl: string;
	token: string;
	/** Injected for testing — defaults to the real ensureDaemonRunning */
	ensureDaemonRunning?: (overstoryDir: string, config: any) => Promise<DaemonState>;
}

export class CodexDaemonDriver implements AgentDriver {
	readonly name = "codex-daemon";
	private daemonUrl: string;
	private token: string;
	private _ensureDaemonRunning: CodexDaemonDriverOpts["ensureDaemonRunning"];

	constructor(opts: CodexDaemonDriverOpts) {
		this.daemonUrl = opts.daemonUrl;
		this.token = opts.token;
		this._ensureDaemonRunning = opts.ensureDaemonRunning ?? ensureDaemonRunning;
	}

	private authHeaders(): Record<string, string> {
		return {
			"Content-Type": "application/json",
			"Authorization": `Bearer ${this.token}`,
		};
	}

	async spawn(ctx: SpawnContext): Promise<SpawnResult> {
		// Step 0: Ensure daemon is running (race-safe with file lock)
		const daemonState = await this._ensureDaemonRunning!(
			ctx.config.project.overstoryDir,
			ctx.config,
		);
		// Update URL/token from actual daemon state (port may be dynamic)
		this.daemonUrl = daemonState.url;
		this.token = daemonState.token;

		// Write AGENTS.md overlay
		await writeAgentsOverlay(ctx.worktreePath, ctx.overlayConfig, ctx.config.project.root);

		// POST to daemon
		const res = await fetch(`${this.daemonUrl}/agents`, {
			method: "POST",
			headers: this.authHeaders(),
			body: JSON.stringify({
				agentName: ctx.session.agentName,
				worktreePath: ctx.worktreePath,
				branchName: ctx.branchName,
				// ... full BridgeConfig fields
			}),
		});

		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Daemon spawn failed (${res.status}): ${text}`);
		}

		const body = await res.json() as { pid: number };
		return { pid: body.pid };
	}

	async nudge(agentName: string, message: string, _from: string, opts?: NudgeOptions): Promise<NudgeResult> {
		const res = await fetch(`${this.daemonUrl}/agents/${agentName}/nudge`, {
			method: "POST",
			headers: this.authHeaders(),
			body: JSON.stringify({ message, force: opts?.force }),
		});
		if (!res.ok) {
			return { delivered: false, reason: `HTTP ${res.status}` };
		}
		return res.json() as Promise<NudgeResult>;
	}

	async steer(agentName: string, input: string): Promise<boolean> {
		const res = await fetch(`${this.daemonUrl}/agents/${agentName}/steer`, {
			method: "POST",
			headers: this.authHeaders(),
			body: JSON.stringify({ input }),
		});
		if (!res.ok) return false;
		const body = await res.json() as { delivered: boolean };
		return body.delivered;
	}

	async inspect(agentName: string): Promise<AgentInspection> {
		const res = await fetch(`${this.daemonUrl}/agents/${agentName}`);
		return res.json() as Promise<AgentInspection>;
	}

	async shutdown(agentName: string): Promise<void> {
		await fetch(`${this.daemonUrl}/agents/${agentName}`, {
			method: "DELETE",
			headers: this.authHeaders(),
		});
	}

	async close(): Promise<void> {
		// No-op. Daemon lifetime is independent of driver instances.
		// Daemon is stopped by: overstory daemon stop, overstory clean, or self-drain.
	}
}
```

**Step 4: Run tests**

Run: `bun test src/drivers/codex-daemon.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/drivers/codex-daemon.ts src/drivers/codex-daemon.test.ts
git commit --no-gpg-sign -m "feat: add CodexDaemonDriver with ensureDaemonRunning + bearer auth"
```

---

## Phase 6: Integration + CLI

### Task 14: Wire CodexDaemonDriver into resolveDriver

**Files:**
- Modify: `src/drivers/resolve.ts`
- Modify: `src/drivers/resolve.test.ts`

Add the full `resolveDriverForSession()` function that instantiates all three drivers. The `codex-daemon` path reads `daemon.json` for URL/token:

```typescript
export function resolveDriverForSession(runtime: AgentRuntime, config: OverstoryConfig): AgentDriver {
	const driverName = resolveDriverName(runtime);
	switch (driverName) {
		case "claude":
			return new ClaudeDriver(/* deps */);
		case "codex-bridge":
			return new CodexBridgeDriver(/* deps */);
		case "codex-daemon": {
			// Read daemon state for URL and token
			const state = readDaemonStateSync(config.project.overstoryDir);
			if (!state) throw new Error("Codex daemon not running — cannot resolve codex-daemon driver");
			return new CodexDaemonDriver({
				daemonUrl: state.url,
				token: state.token,
			});
		}
	}
}
```

**Step 1: Test + commit**

```bash
git add src/drivers/resolve.ts src/drivers/resolve.test.ts
git commit --no-gpg-sign -m "feat: wire CodexDaemonDriver into resolveDriverForSession"
```

---

### Task 15: Add daemon command to CLI

**Files:**
- Create: `src/commands/daemon.ts`
- Modify: `src/index.ts` (add command routing)

Add `overstory daemon start|stop|status` command, following the pattern of `coordinator.ts`.

```
overstory daemon start   # Start the daemon sidecar
overstory daemon stop    # Stop the daemon (force-drains agents)
overstory daemon status  # Show daemon state (pid, port, agents, token masked)
```

Start calls `ensureDaemonRunning()`. Stop sends `POST /shutdown` with bearer token. Status reads `daemon.json` and pings `/health`.

**Step 1: Implement + test**

**Step 2: Commit**

```bash
git add src/commands/daemon.ts src/index.ts
git commit --no-gpg-sign -m "feat: add overstory daemon start/stop/status command"
```

---

### Task 16: Failure-mode tests

**Files:**
- Create: `src/drivers/codex-daemon.integration.ts` (integration tests)
- Add tests to existing test files

**Test scenarios (from design doc §P2 Additional Test Scenarios):**

1. **Concurrent /agents POST**: Two parallel spawn calls must not create duplicate agents. Test with `Promise.all`.
2. **Mixed bridge+daemon fleet**: Spawn one `codex` (bridge) and one `codex-daemon` agent. Verify nudge/inspect routes correctly to each backend based on persisted `session.runtime`.
3. **Daemon crash mid-turn**: Kill daemon PID during an active turn. Verify watchdog detects + restarts, agents recover from checkpoint.
4. **Config flip during active sessions**: Change `intraProcess` while agents are running. Verify existing agents continue working (routing uses persisted runtime, not config).
5. **Token validation**: Requests without valid bearer token return 401 on mutation endpoints. GET /health and GET /agents work without auth.
6. **Port race**: Two sling calls racing to start daemon. Verify file lock prevents double-start.

**Step 1: Write tests**

**Step 2: Run tests**

Run: `bun test`
Expected: PASS

**Step 3: Commit**

```bash
git add src/drivers/codex-daemon.integration.ts
git commit --no-gpg-sign -m "test: add failure-mode integration tests for daemon driver"
```

---

### Task 17: Quality gates + final integration check

**Step 1: Run full test suite**

Run: `bun test`
Expected: All tests PASS

**Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

**Step 3: Run lint**

Run: `bun run lint`
Expected: PASS (run `bunx biome check --write .` to auto-fix if needed)

**Step 4: Final commit if any fixes**

```bash
git add -A
git commit --no-gpg-sign -m "chore: fix lint/type issues from driver integration"
```

---

## Summary of Deliverables

| File | Action | Description |
|------|--------|-------------|
| `src/types.ts` | Modify | Extend `AgentRuntime` with `"codex-daemon"`, add `intraProcess` + `daemonPort` to CodexConfig |
| `src/config.ts` | Modify | Add defaults (daemonPort=0) + validation for new fields |
| `src/config.test.ts` | Modify | Tests for new config fields |
| `config.yaml.sample` | Modify | Add new fields with comments |
| `src/drivers/types.ts` | Create | AgentDriver interface + NudgeOptions/NudgeResult + supporting types |
| `src/drivers/resolve.ts` | Create | Two-path driver resolution (spawn-time + operation-time) |
| `src/drivers/resolve.test.ts` | Create | Resolution tests |
| `src/drivers/claude.ts` | Create | ClaudeDriver (extracted from sling.ts) |
| `src/drivers/claude.test.ts` | Create | ClaudeDriver tests |
| `src/drivers/codex-bridge.ts` | Create | CodexBridgeDriver (extracted from sling.ts) |
| `src/drivers/codex-bridge.test.ts` | Create | CodexBridgeDriver tests |
| `src/drivers/codex-daemon.ts` | Create | CodexDaemonDriver (HTTP client with bearer auth + ensureDaemonRunning) |
| `src/drivers/codex-daemon.test.ts` | Create | CodexDaemonDriver tests |
| `src/codex/daemon/pool.ts` | Create | AgentPool for managed agents |
| `src/codex/daemon/pool.test.ts` | Create | Pool tests (mock RPC) |
| `src/codex/daemon/server.ts` | Create | Daemon HTTP server (Bun.serve, bearer auth, localhost-only) |
| `src/codex/daemon/server.test.ts` | Create | Server tests (real Bun.serve) |
| `src/codex/daemon/main.ts` | Create | Daemon entry point |
| `src/codex/daemon/lifecycle.ts` | Create | Start/stop/health for daemon process (file lock, token gen) |
| `src/codex/daemon/lifecycle.test.ts` | Create | Lifecycle tests |
| `src/commands/sling.ts` | Modify | Replace if/else with driver.spawn(), persist resolved runtime, use tmux sentinel |
| `src/commands/nudge.ts` | Modify | Replace if/else with driver.nudge() dispatch |
| `src/commands/daemon.ts` | Create | CLI command for daemon management |
| `src/index.ts` | Modify | Route daemon subcommand |
| `src/sessions/store.ts` | Modify | Accept tmux sentinel `"daemon:<name>"` for daemon agents |
| `src/watchdog/health.ts` | Modify | Runtime-aware health (skip tmux for codex-daemon, use daemon HTTP) |
| `src/watchdog/daemon.ts` | Modify | Resolve driver from session.runtime for nudge calls |
| `src/drivers/codex-daemon.integration.ts` | Create | Failure-mode integration tests |

## Execution Order

Tasks are ordered for incremental buildability. Each task produces passing tests before moving on.

1. Config types + AgentRuntime extension (foundation — everything depends on this)
2. AgentDriver interface with NudgeOptions/NudgeResult (types only — no runtime code)
3. Two-path driver resolver (pure functions — no deps)
4. ClaudeDriver (extraction — largest task)
5. CodexBridgeDriver (extraction — mirrors task 4)
6. Resolve factory with full driver instantiation
7. Sling refactor (uses drivers, persists runtime per-session, tmux sentinel)
8. Nudge refactor (uses driver.nudge() — no more runtime branching)
9. Watchdog updates (runtime-aware health + driver-based nudge)
10. AgentPool (daemon core)
11. Daemon HTTP server (bearer auth, localhost binding)
12. Daemon lifecycle + entry point (file lock, token gen)
13. CodexDaemonDriver (HTTP client with ensureDaemonRunning)
14. Wire into resolver
15. CLI command
16. Failure-mode integration tests
17. Quality gates

## Rollout Plan

**Phase A: Driver Extraction (no behavior change)**
- Tasks 1-8: Extract drivers, wire into sling/nudge. `intraProcess` defaults to `false`.
- All existing tests pass. No new runtime code activated.
- Ship and validate. This is the safe rollback point.

**Phase B: Daemon Infrastructure (behind flag)**
- Tasks 9-15: Build daemon pool, server, lifecycle. Add CodexDaemonDriver.
- `intraProcess: false` by default. Daemon code exists but is never activated.
- Ship. No behavior change for anyone.

**Phase C: Opt-in Daemon Mode**
- Set `intraProcess: true` in a single test project.
- Run mixed fleet (some bridge, some daemon) to validate interop.
- Canary criteria: zero zombie misclassifications, approval latency <500ms, daemon uptime >99%.

**Phase D: Default Flip**
- Change default to `intraProcess: true` after canary passes for 1 week.
- Rollback trigger: any daemon crash that loses agent progress, or zombie misclassification.
