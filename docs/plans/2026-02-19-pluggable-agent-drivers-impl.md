# Pluggable Agent Drivers Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace inline runtime branching in sling/nudge with a pluggable AgentDriver interface, then add a CodexDaemonDriver for intra-process Codex agent management via a sidecar HTTP daemon.

**Architecture:** Strategy pattern with three AgentDriver implementations (ClaudeDriver, CodexBridgeDriver, CodexDaemonDriver). sling.ts resolves the driver from config and delegates spawn. nudge.ts delegates delivery. A new sidecar daemon process manages Codex agents via multiplexed WebSocket connections to the App Server.

**Tech Stack:** TypeScript (strict), Bun runtime, bun:sqlite, Bun.serve() for daemon HTTP, bun:test for testing.

---

## Phase 1: Interface + Types Foundation

### Task 1: Add config types for intraProcess and daemonPort

**Files:**
- Modify: `src/types.ts:48-63` (CodexConfig interface)
- Modify: `src/config.ts:51-59` (DEFAULT_CONFIG.codex)
- Modify: `src/config.ts:439-485` (validateCodexConfig)
- Modify: `src/config.test.ts` (add validation tests)
- Modify: `config.yaml.sample:47-56`

**Step 1: Write the failing tests**

Add tests in `src/config.test.ts` for the new fields:

```typescript
test("codex.intraProcess defaults to false", () => {
	// loadConfig with codex section but no intraProcess should default to false
	const config = /* load a config with codex section */;
	expect(config.codex?.intraProcess).toBe(false);
});

test("codex.daemonPort defaults to 21817", () => {
	const config = /* load a config with codex section */;
	expect(config.codex?.daemonPort).toBe(21817);
});

test("rejects codex.daemonPort outside 1-65535", () => {
	// Write a config.yaml with daemonPort: 0
	expect(() => /* loadConfig */).toThrow("codex.daemonPort");
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test src/config.test.ts`
Expected: FAIL — `intraProcess` and `daemonPort` don't exist on CodexConfig

**Step 3: Add the types and defaults**

In `src/types.ts`, add to `CodexConfig`:

```typescript
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
	/** HTTP port for the CodexDaemon sidecar (only used when intraProcess=true) */
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
	daemonPort: 21817,
},
```

In `src/config.ts` validateCodexConfig, add:

```typescript
// codex.daemonPort must be an integer 1-65535
if (!Number.isInteger(codex.daemonPort) || codex.daemonPort < 1 || codex.daemonPort > 65535) {
	throw new ValidationError("codex.daemonPort must be an integer between 1 and 65535", {
		field: "codex.daemonPort",
		value: codex.daemonPort,
	});
}
```

In `config.yaml.sample`, add after `approvalTimeoutMs`:

```yaml
  intraProcess: false
  daemonPort: 21817
```

**Step 4: Run tests to verify they pass**

Run: `bun test src/config.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/types.ts src/config.ts src/config.test.ts config.yaml.sample
git commit --no-gpg-sign -m "feat: add codex.intraProcess and codex.daemonPort config fields"
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

	/** Indirect: wake agent and have it check mail */
	nudge(agentName: string, message: string, from: string): Promise<void>;

	/** Direct: inject a message into the agent's active turn/session.
	 *  Returns true if delivered, false if no active turn (caller should fall back to mail). */
	steer(agentName: string, input: string): Promise<boolean>;

	/** Get detailed runtime state for inspect/dashboard */
	inspect(agentName: string): Promise<AgentInspection>;

	/** Request graceful shutdown of an agent */
	shutdown(agentName: string): Promise<void>;

	/** Clean up driver-level resources (connections, daemon handles) */
	close(): Promise<void>;
}
```

**Step 2: Verify types compile**

Run: `bun run typecheck`
Expected: PASS (types only, no runtime code to break)

**Step 3: Commit**

```bash
git add src/drivers/types.ts
git commit --no-gpg-sign -m "feat: add AgentDriver interface and supporting types"
```

---

### Task 3: Create driver resolver

**Files:**
- Create: `src/drivers/resolve.ts`
- Create: `src/drivers/resolve.test.ts`

**Step 1: Write failing tests**

```typescript
import { describe, expect, test } from "bun:test";
import { resolveDriverName } from "./resolve";

describe("resolveDriverName", () => {
	test("returns 'claude' for runtime 'claude'", () => {
		expect(resolveDriverName("claude", undefined)).toBe("claude");
	});

	test("returns 'codex-bridge' for runtime 'codex' when intraProcess is false", () => {
		expect(resolveDriverName("codex", { intraProcess: false })).toBe("codex-bridge");
	});

	test("returns 'codex-bridge' for runtime 'codex' when codex config is undefined", () => {
		expect(resolveDriverName("codex", undefined)).toBe("codex-bridge");
	});

	test("returns 'codex-daemon' for runtime 'codex' when intraProcess is true", () => {
		expect(resolveDriverName("codex", { intraProcess: true })).toBe("codex-daemon");
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test src/drivers/resolve.test.ts`
Expected: FAIL — module not found

**Step 3: Implement resolver**

Start with just the name resolution (pure function, no driver instantiation yet — drivers don't exist yet):

```typescript
// src/drivers/resolve.ts
import type { AgentRuntime } from "../types";

export type DriverName = "claude" | "codex-bridge" | "codex-daemon";

/**
 * Resolve which driver implementation to use based on runtime and config.
 * Pure function — no side effects, no instantiation.
 */
export function resolveDriverName(
	runtime: AgentRuntime,
	codexConfig: { intraProcess?: boolean } | undefined,
): DriverName {
	if (runtime === "claude") return "claude";
	// runtime === "codex"
	if (codexConfig?.intraProcess) return "codex-daemon";
	return "codex-bridge";
}
```

**Step 4: Run tests**

Run: `bun test src/drivers/resolve.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/drivers/resolve.ts src/drivers/resolve.test.ts
git commit --no-gpg-sign -m "feat: add driver name resolver"
```

---

## Phase 2: ClaudeDriver (Extract from sling.ts)

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
import type { AgentDriver, AgentInspection, SpawnContext, SpawnResult } from "./types";

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

	async nudge(agentName: string, message: string, _from: string): Promise<void> {
		// tmux sendKeys with retry (extracted from nudge.ts)
	}

	async steer(agentName: string, input: string): Promise<boolean> {
		// Same as nudge for Claude (no steer/nudge distinction)
		await this.nudge(agentName, input, "steer");
		return true;
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

Similar pattern to ClaudeDriver: DI for tmux, startServer, writeAgentsOverlay, writeCodexConfig. Test that spawn calls expected functions with correct args.

**Step 2: Run tests to verify they fail**

Run: `bun test src/drivers/codex-bridge.test.ts`
Expected: FAIL

**Step 3: Implement CodexBridgeDriver**

Extract from `sling.ts:480-534`:
- `writeAgentsOverlay()` call (step 12a)
- `writeCodexConfig()` call (step 12b)
- `startServer()` call (step 12c)
- Bridge tmux spawn with env vars (step 12d)

Nudge: extract from `nudge.ts:259-321` (SIGUSR1 + mail).

```typescript
// src/drivers/codex-bridge.ts
import type { AgentDriver, SpawnContext, SpawnResult, AgentInspection } from "./types";

export interface CodexBridgeDriverDeps {
	createSession: (name: string, cwd: string, cmd: string, env?: Record<string, string>) => Promise<number>;
	startServer: typeof import("../codex/server").startServer;
	writeAgentsOverlay: typeof import("../codex/overlay").writeAgentsOverlay;
	writeCodexConfig: typeof import("../codex/config-gen").writeCodexConfig;
}

export class CodexBridgeDriver implements AgentDriver {
	readonly name = "codex-bridge";
	constructor(private deps: CodexBridgeDriverDeps) {}
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

## Phase 3: Wire Drivers into sling.ts

### Task 6: Add resolveDriver factory function

**Files:**
- Modify: `src/drivers/resolve.ts`
- Modify: `src/drivers/resolve.test.ts`

**Step 1: Extend resolve.ts with full resolveDriver function**

Add `resolveDriver()` that returns an instantiated `AgentDriver`. Uses `resolveDriverName()` internally. Takes the full config + deps needed to construct each driver.

**Step 2: Test with mock deps**

**Step 3: Commit**

```bash
git add src/drivers/resolve.ts src/drivers/resolve.test.ts
git commit --no-gpg-sign -m "feat: add resolveDriver factory with full instantiation"
```

---

### Task 7: Refactor sling.ts to use drivers

**Files:**
- Modify: `src/commands/sling.ts`
- Modify: `src/commands/sling.test.ts` (if existing tests need updating)

**Step 1: Replace the if/else runtime fork**

Currently `sling.ts:442-557` has a try/catch wrapping the runtime fork. Replace the runtime-specific code (lines 445-557) with:

```typescript
const driver = resolveDriver(runtime, config);
const result = await driver.spawn({
	config,
	session: { /* partially built session */ },
	overlayConfig,
	worktreePath,
	branchName,
	tmuxSessionName,
	runId,
});
pid = result.pid;
```

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
git commit --no-gpg-sign -m "refactor: replace sling.ts runtime fork with AgentDriver dispatch"
```

---

### Task 8: Refactor nudge.ts to use drivers

**Files:**
- Modify: `src/commands/nudge.ts`

**Step 1: Replace runtime fork in nudgeAgent()**

Currently `nudge.ts:373-376` has:

```typescript
const result =
	target.runtime === "codex"
		? await nudgeCodexAgent(...)
		: await nudgeClaudeAgent(...);
```

Replace with driver dispatch. The `nudgeClaudeAgent` and `nudgeCodexAgent` functions can be kept as internal helpers used by the drivers, or extracted into the drivers themselves.

The cleanest approach: keep the nudge module but have it resolve and delegate to the driver:

```typescript
const driver = resolveDriver(target.runtime, config);
await driver.nudge(agentName, message, from);
```

This requires `nudgeAgent` to load config (it currently doesn't). Alternative: pass the driver in, or keep the existing functions but have them also support "codex-daemon" via HTTP.

**Decision:** For minimal disruption, add a `codex-daemon` branch that calls the daemon HTTP API. This aligns with the existing pattern and avoids needing config in nudge.

**Step 2: Run nudge tests if they exist, otherwise run full suite**

Run: `bun test`
Expected: PASS

**Step 3: Commit**

```bash
git add src/commands/nudge.ts
git commit --no-gpg-sign -m "refactor: add codex-daemon path to nudge delivery"
```

---

## Phase 4: Daemon Infrastructure

### Task 9: Create AgentPool

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
import { createDeltaBufferManager } from "../events";

export interface ManagedAgent {
	config: BridgeConfig;
	rpc: RpcClient;
	threadId: string;
	activeTurnId: string | null;
	// ... (per design doc)
	state: "booting" | "working" | "completed" | "failed";
}

export interface AgentPoolDeps {
	createRpcClient: (url: string) => Promise<RpcClient>;
	// Event/mail store factories for DI
}

export interface AgentPool {
	add(config: BridgeConfig): Promise<void>;
	get(name: string): ManagedAgent | undefined;
	steer(name: string, input: string): Promise<boolean>;
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

### Task 10: Create daemon HTTP server

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

	afterEach(() => { server?.stop(); });

	test("GET /health returns 200", async () => {
		server = createDaemonServer({ port: 0, pool: mockPool() });
		const res = await fetch(`${server.url}/health`);
		expect(res.status).toBe(200);
	});

	test("GET /agents returns empty array initially", async () => {
		server = createDaemonServer({ port: 0, pool: mockPool() });
		const res = await fetch(`${server.url}/agents`);
		const body = await res.json();
		expect(body).toEqual([]);
	});

	test("POST /agents spawns an agent", async () => {
		const pool = mockPool();
		server = createDaemonServer({ port: 0, pool });
		const res = await fetch(`${server.url}/agents`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(makeBridgeConfig({ agentName: "new-agent" })),
		});
		expect(res.status).toBe(201);
		expect(pool.addCalls).toBe(1);
	});

	test("POST /shutdown drains pool and stops", async () => {
		const pool = mockPool();
		server = createDaemonServer({ port: 0, pool });
		const res = await fetch(`${server.url}/shutdown`, { method: "POST" });
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
}

export function createDaemonServer(opts: DaemonServerOpts): Server {
	return Bun.serve({
		port: opts.port,
		async fetch(req) {
			const url = new URL(req.url);
			const method = req.method;

			if (url.pathname === "/health" && method === "GET") {
				return Response.json({ status: "ok" });
			}

			if (url.pathname === "/agents" && method === "GET") {
				return Response.json(opts.pool.names().map(n => ({
					name: n,
					state: opts.pool.get(n)?.state,
				})));
			}

			if (url.pathname === "/agents" && method === "POST") {
				const config = await req.json();
				await opts.pool.add(config);
				return new Response(null, { status: 201 });
			}

			// ... other routes per design doc

			if (url.pathname === "/shutdown" && method === "POST") {
				await opts.pool.drain();
				// Schedule process exit after response
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
git commit --no-gpg-sign -m "feat: add daemon HTTP server with agent pool routes"
```

---

### Task 11: Create daemon entry point and lifecycle manager

**Files:**
- Create: `src/codex/daemon/main.ts` (entry point, like bridge.ts `import.meta.main`)
- Create: `src/codex/daemon/lifecycle.ts` (start/stop/health check from CLI side)
- Create: `src/codex/daemon/lifecycle.test.ts`

**Step 1: Write failing tests for lifecycle**

```typescript
import { describe, expect, test } from "bun:test";
import { parseDaemonState, isDaemonAlive } from "./lifecycle";

describe("parseDaemonState", () => {
	test("parses valid daemon state JSON", () => {
		const state = parseDaemonState('{"pid":123,"port":21817,"startedAt":"2026-01-01","url":"http://127.0.0.1:21817"}');
		expect(state?.pid).toBe(123);
		expect(state?.port).toBe(21817);
	});

	test("returns null for invalid JSON", () => {
		expect(parseDaemonState("not json")).toBeNull();
	});
});

describe("isDaemonAlive", () => {
	test("returns false for non-existent PID", () => {
		expect(isDaemonAlive({ pid: 999999, port: 0, startedAt: "", url: "" })).toBe(false);
	});
});
```

**Step 2: Implement lifecycle functions**

Pattern matches `src/codex/server.ts` (readServerState, isServerAlive, startServer, stopServer) but for the daemon process.

**Step 3: Implement daemon entry point (main.ts)**

```typescript
// src/codex/daemon/main.ts
// Entry point for the daemon sidecar process.
// Spawned by CodexDaemonDriver on first agent spawn.
if (import.meta.main) {
	const port = Number(process.env.OVERSTORY_DAEMON_PORT ?? "21817");
	const overstoryDir = process.env.OVERSTORY_DIR ?? "";
	const serverUrl = process.env.OVERSTORY_CODEX_SERVER_URL ?? "ws://127.0.0.1:21816";
	// Create pool, start server, write state file
}
```

**Step 4: Run tests, typecheck, lint**

**Step 5: Commit**

```bash
git add src/codex/daemon/main.ts src/codex/daemon/lifecycle.ts src/codex/daemon/lifecycle.test.ts
git commit --no-gpg-sign -m "feat: add daemon lifecycle manager and entry point"
```

---

## Phase 5: CodexDaemonDriver

### Task 12: Create CodexDaemonDriver

**Files:**
- Create: `src/drivers/codex-daemon.ts`
- Create: `src/drivers/codex-daemon.test.ts`

**Step 1: Write failing tests**

Mock the HTTP calls to the daemon:

```typescript
import { describe, expect, test } from "bun:test";
import { CodexDaemonDriver } from "./codex-daemon";

describe("CodexDaemonDriver", () => {
	test("name is 'codex-daemon'", () => {
		const driver = new CodexDaemonDriver({ daemonUrl: "http://localhost:0" });
		expect(driver.name).toBe("codex-daemon");
	});

	test("spawn POSTs to /agents", async () => {
		let posted = false;
		// Use a real Bun.serve on port 0 as a fake daemon
		const fakeDaemon = Bun.serve({
			port: 0,
			fetch(req) {
				if (req.method === "POST" && new URL(req.url).pathname === "/agents") {
					posted = true;
					return new Response(JSON.stringify({ pid: 42 }), { status: 201 });
				}
				return new Response("Not Found", { status: 404 });
			},
		});
		try {
			const driver = new CodexDaemonDriver({ daemonUrl: `http://localhost:${fakeDaemon.port}` });
			const result = await driver.spawn(makeSpawnContext());
			expect(posted).toBe(true);
			expect(result.pid).toBe(42);
		} finally {
			fakeDaemon.stop();
		}
	});

	test("steer POSTs to /agents/:name/steer", async () => {
		// Similar pattern with fake daemon server
	});

	test("shutdown DELETEs /agents/:name", async () => {
		// Similar pattern
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test src/drivers/codex-daemon.test.ts`
Expected: FAIL

**Step 3: Implement CodexDaemonDriver**

```typescript
// src/drivers/codex-daemon.ts
import type { AgentDriver, AgentInspection, SpawnContext, SpawnResult } from "./types";
import { ensureDaemonRunning } from "../codex/daemon/lifecycle";
import { writeAgentsOverlay } from "../codex/overlay";
import { writeCodexConfig } from "../codex/config-gen";

export interface CodexDaemonDriverOpts {
	daemonUrl: string;
}

export class CodexDaemonDriver implements AgentDriver {
	readonly name = "codex-daemon";
	private daemonUrl: string;

	constructor(opts: CodexDaemonDriverOpts) {
		this.daemonUrl = opts.daemonUrl;
	}

	async spawn(ctx: SpawnContext): Promise<SpawnResult> {
		// Write AGENTS.md overlay
		await writeAgentsOverlay(ctx.worktreePath, ctx.overlayConfig, ctx.config.project.root);
		// Write .codex/config.toml
		const codexConfig = ctx.config.codex!;
		await writeCodexConfig(ctx.worktreePath, {
			model: codexConfig.model,
			approvalPolicy: "on-request",
		});

		// POST to daemon
		const res = await fetch(`${this.daemonUrl}/agents`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
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

	async nudge(agentName: string, message: string, _from: string): Promise<void> {
		await fetch(`${this.daemonUrl}/agents/${agentName}/nudge`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message }),
		});
	}

	async steer(agentName: string, input: string): Promise<boolean> {
		const res = await fetch(`${this.daemonUrl}/agents/${agentName}/steer`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
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
		await fetch(`${this.daemonUrl}/agents/${agentName}`, { method: "DELETE" });
	}

	async close(): Promise<void> {
		await fetch(`${this.daemonUrl}/shutdown`, { method: "POST" });
	}
}
```

**Step 4: Run tests**

Run: `bun test src/drivers/codex-daemon.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/drivers/codex-daemon.ts src/drivers/codex-daemon.test.ts
git commit --no-gpg-sign -m "feat: add CodexDaemonDriver (HTTP client to sidecar daemon)"
```

---

## Phase 6: Integration

### Task 13: Wire CodexDaemonDriver into resolveDriver

**Files:**
- Modify: `src/drivers/resolve.ts`
- Modify: `src/drivers/resolve.test.ts`

Add the full `resolveDriver()` function that instantiates all three drivers. The `codex-daemon` path needs the daemon URL from config.

**Step 1: Update resolve.ts**

```typescript
export function resolveDriver(runtime: AgentRuntime, config: OverstoryConfig): AgentDriver {
	const driverName = resolveDriverName(runtime, config.codex);
	switch (driverName) {
		case "claude":
			return new ClaudeDriver(/* deps */);
		case "codex-bridge":
			return new CodexBridgeDriver(/* deps */);
		case "codex-daemon": {
			const port = config.codex?.daemonPort ?? 21817;
			return new CodexDaemonDriver({ daemonUrl: `http://127.0.0.1:${port}` });
		}
	}
}
```

**Step 2: Test + commit**

---

### Task 14: Add daemon command to CLI

**Files:**
- Create: `src/commands/daemon.ts`
- Modify: `src/index.ts` (add command routing)

Add `overstory daemon start|stop|status` command, following the pattern of `coordinator.ts`.

```
overstory daemon start   # Start the daemon sidecar
overstory daemon stop    # Stop the daemon
overstory daemon status  # Show daemon state (pid, port, agents)
```

**Step 1: Implement + test**

**Step 2: Commit**

```bash
git add src/commands/daemon.ts src/index.ts
git commit --no-gpg-sign -m "feat: add overstory daemon start/stop/status command"
```

---

### Task 15: Quality gates + final integration check

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
| `src/types.ts` | Modify | Add `intraProcess` + `daemonPort` to CodexConfig |
| `src/config.ts` | Modify | Add defaults + validation for new fields |
| `src/config.test.ts` | Modify | Tests for new config fields |
| `config.yaml.sample` | Modify | Add new fields with comments |
| `src/drivers/types.ts` | Create | AgentDriver interface + supporting types |
| `src/drivers/resolve.ts` | Create | Driver resolution factory |
| `src/drivers/resolve.test.ts` | Create | Resolution tests |
| `src/drivers/claude.ts` | Create | ClaudeDriver (extracted from sling.ts) |
| `src/drivers/claude.test.ts` | Create | ClaudeDriver tests |
| `src/drivers/codex-bridge.ts` | Create | CodexBridgeDriver (extracted from sling.ts) |
| `src/drivers/codex-bridge.test.ts` | Create | CodexBridgeDriver tests |
| `src/drivers/codex-daemon.ts` | Create | CodexDaemonDriver (HTTP client) |
| `src/drivers/codex-daemon.test.ts` | Create | CodexDaemonDriver tests |
| `src/codex/daemon/pool.ts` | Create | AgentPool for managed agents |
| `src/codex/daemon/pool.test.ts` | Create | Pool tests (mock RPC) |
| `src/codex/daemon/server.ts` | Create | Daemon HTTP server (Bun.serve) |
| `src/codex/daemon/server.test.ts` | Create | Server tests (real Bun.serve) |
| `src/codex/daemon/main.ts` | Create | Daemon entry point |
| `src/codex/daemon/lifecycle.ts` | Create | Start/stop/health for daemon process |
| `src/codex/daemon/lifecycle.test.ts` | Create | Lifecycle tests |
| `src/commands/sling.ts` | Modify | Replace if/else with driver.spawn() |
| `src/commands/nudge.ts` | Modify | Add codex-daemon nudge path |
| `src/commands/daemon.ts` | Create | CLI command for daemon management |
| `src/index.ts` | Modify | Route daemon subcommand |

## Execution Order

Tasks are ordered for incremental buildability. Each task produces passing tests before moving on.

1. Config types (foundation — everything depends on this)
2. AgentDriver interface (types only — no runtime code)
3. Driver resolver (pure function — no deps)
4. ClaudeDriver (extraction — largest task)
5. CodexBridgeDriver (extraction — mirrors task 4)
6. Resolve factory (wires drivers together)
7. Sling refactor (uses drivers)
8. Nudge refactor (uses drivers)
9. AgentPool (daemon core)
10. Daemon HTTP server
11. Daemon lifecycle + entry point
12. CodexDaemonDriver (HTTP client)
13. Wire into resolver
14. CLI command
15. Quality gates
