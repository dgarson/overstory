# Pluggable Agent Drivers

**Date:** 2026-02-19
**Status:** Approved (v2 — amended per Codex review)
**Branch:** feat/pluggable-agent-drivers

## Problem

The Codex App Server integration currently runs as a separate bridge process per agent, spawned in tmux. This adds latency (mail-based approval escalation takes 2-7s), operational overhead (N bridge processes to monitor), and makes coordinator-to-agent communication indirect.

The coordinator communicates with Codex agents entirely through mail (async, eventually-consistent), while Claude Code agents benefit from direct tmux interaction. We want an intra-process alternative where the coordinator's sidecar daemon manages Codex agents directly via multiplexed WebSocket connections.

Additionally, the spawn and lifecycle logic for both runtimes (Claude Code, Codex bridge) is hardcoded as inline if/else branches in `sling.ts` and `nudge.ts`. Adding a third runtime path would make this worse.

## Solution

Introduce a pluggable `AgentDriver` interface (strategy pattern) that covers the full agent lifecycle. Three implementations:

- **ClaudeDriver** — existing Claude Code tmux path (extraction)
- **CodexBridgeDriver** — existing out-of-process bridge path (extraction)
- **CodexDaemonDriver** — new intra-process path via a sidecar HTTP daemon

A new runtime value `"codex-daemon"` (persisted per-session in SessionStore) selects the CodexDaemonDriver. Config flag `codex.intraProcess` controls which runtime is resolved at spawn time, but the runtime is persisted on the session so that nudge/shutdown/inspect always route to the correct backend — even after config changes or in mixed fleets.

## AgentDriver Interface

```typescript
// src/drivers/types.ts

interface SpawnContext {
  config: OverstoryConfig;
  session: AgentSession;
  overlayConfig: OverlayConfig;
  worktreePath: string;
  branchName: string;
  tmuxSessionName: string;
  runId: string;
}

interface SpawnResult {
  pid: number;
  driverState?: Record<string, unknown>;
}

interface AgentInspection {
  state: AgentState;
  lastActivity: string;
  recentToolCalls?: Array<{ name: string; startedAt: string; durationMs?: number }>;
  tmuxCapture?: string;
  activeThreadId?: string;
  tokenUsage?: { input: number; output: number; total: number };
}

interface NudgeOptions {
  /** Skip debounce check (required for watchdog escalation nudges) */
  force?: boolean;
}

/** Nudge delivery result — preserves watchdog telemetry contract */
interface NudgeResult {
  delivered: boolean;
  reason?: string;
}

interface AgentDriver {
  readonly name: string;
  spawn(ctx: SpawnContext): Promise<SpawnResult>;
  nudge(agentName: string, message: string, from: string, opts?: NudgeOptions): Promise<NudgeResult>;
  steer(agentName: string, input: string): Promise<boolean>;
  inspect(agentName: string): Promise<AgentInspection>;
  shutdown(agentName: string): Promise<void>;
  close(): Promise<void>;
}
```

### Key decisions

1. **sling owns steps 1-11** (config, validation, worktree, overlay, identity, session recording). Drivers only handle step 12+ (runtime-specific spawn and lifecycle).

2. **nudge vs steer**: `nudge` = "wake up and check mail" (indirect), `steer` = "inject text into active turn" (direct). ClaudeDriver maps both to tmux sendKeys. CodexBridgeDriver maps nudge to SIGUSR1 and steer falls back to nudge. CodexDaemonDriver maps steer to `turn/steer` RPC (zero-latency).

3. **`steer` returns boolean**: `true` if delivered to active turn, `false` if no turn active (caller should fall back to mail).

4. **nudge has NudgeOptions**: The `force` flag is required for watchdog escalation nudges which must bypass debounce. Without it, the watchdog's progressive escalation (daemon.ts:543) would be silently suppressed.

5. **`close()` does NOT stop the daemon for regular callers.** Only explicit `overstory daemon stop` or `overstory clean` stops it. The CodexDaemonDriver is ref-counted: `spawn()` increments, agent completion decrements. `close()` only sends `/shutdown` when the ref count reaches zero AND the caller is the coordinator/clean command. CLI commands that resolve a driver for a one-shot operation (nudge, inspect) get a lightweight client that never calls `close()`.

## Driver Resolution

Two resolution paths:

**At spawn time** (`resolveRuntimeForSpawn`): Uses config to determine runtime. This is where `codex.intraProcess` is consulted. The resolved runtime (`"claude" | "codex" | "codex-daemon"`) is persisted on the AgentSession.

**At operation time** (`resolveDriverForSession`): Reads the persisted `session.runtime` and returns the correct driver. Never consults `codex.intraProcess` — the session knows which driver spawned it.

```typescript
// src/drivers/resolve.ts

/** At spawn time: config determines runtime, result is persisted on session */
function resolveRuntimeForSpawn(
  capability: string,
  config: OverstoryConfig,
  runtimeFlag?: AgentRuntime,
): AgentRuntime {
  const base = runtimeFlag ?? config.codex?.defaultRuntime[capability] ?? "claude";
  if (base === "codex" && config.codex?.intraProcess) return "codex-daemon";
  return base;
}

/** At operation time: session.runtime determines driver */
function resolveDriverForSession(runtime: AgentRuntime, config: OverstoryConfig): AgentDriver {
  switch (runtime) {
    case "claude":       return new ClaudeDriver(/* deps */);
    case "codex":        return new CodexBridgeDriver(/* deps */);
    case "codex-daemon": return getCodexDaemonDriver(config); // singleton
  }
}
```

This ensures that nudge/shutdown/inspect always route to the backend that actually spawned the agent, even if `codex.intraProcess` was toggled between spawns or across mixed fleets.

## ClaudeDriver

Extraction of existing Claude Code path from `sling.ts`.

| Method | Implementation |
|--------|---------------|
| spawn | Create tmux session with `claude --model X --dangerously-skip-permissions`, send beacon via sendKeys |
| nudge | tmux send-keys (existing nudge.ts logic) |
| steer | tmux send-keys (same as nudge — Claude Code has no steer/nudge distinction) |
| inspect | tmux capture-pane + SessionStore state |
| shutdown | Kill tmux session |
| close | no-op |

## CodexBridgeDriver

Extraction of existing out-of-process bridge path from `sling.ts`.

| Method | Implementation |
|--------|---------------|
| spawn | Start App Server, spawn bridge.ts in tmux with env vars |
| nudge | SIGUSR1 to bridge PID |
| steer | Falls back to nudge (bridge checks mail on SIGUSR1) |
| inspect | Read events.db + tmux capture-pane of bridge |
| shutdown | SIGTERM to bridge PID |
| close | no-op |

## CodexDaemonDriver

New intra-process approach via sidecar HTTP daemon.

| Method | Implementation |
|--------|---------------|
| spawn | POST /agents to daemon (starts daemon if not running) |
| nudge | POST /agents/:name/nudge |
| steer | POST /agents/:name/steer (direct turn/steer RPC, zero latency) |
| inspect | GET /agents/:name (live state from daemon) |
| shutdown | DELETE /agents/:name |
| close | POST /shutdown to daemon |

## Daemon Architecture

### Process lifecycle

The daemon is a long-running Bun process started on first CodexDaemonDriver.spawn() call. It runs `Bun.serve()` on `codex.daemonPort` (default 21817). State file: `.overstory/daemon.json` with `{ pid, port, startedAt, url }`.

### Agent pool

```typescript
interface ManagedAgent {
  config: BridgeConfig;
  rpc: RpcClient;                    // Dedicated WS connection to App Server
  threadId: string;
  activeTurnId: string | null;
  deltaManager: DeltaBufferManager;
  itemStartTimes: Map<string, number>;
  modifiedFiles: Set<string>;
  lastProgressSummary: string;
  lastCheckpointSaveMs: number;
  lastMailCheckMs: number;
  state: "booting" | "working" | "completed" | "failed";
}
```

Each agent gets its own WebSocket connection to the App Server (one thread per connection). The pool manages lifecycle. The daemon reuses `runBridgeSession` (or a refactored version) for the per-agent event loop.

### HTTP API

```
POST   /agents              Spawn agent (body: BridgeConfig)
GET    /agents              List all agents (summary)
GET    /agents/:name        Inspect agent (live state)
POST   /agents/:name/nudge  Check mail + steer if active
POST   /agents/:name/steer  Inject text into active turn
DELETE /agents/:name        Graceful shutdown
POST   /shutdown            Drain all + exit
GET    /health              Liveness check
```

### Event handling

Same as bridge — notification handlers on each RPC client for item/started, item/completed, turn/completed, tokenUsage, contextCompaction, requestApproval. Events recorded to shared `events.db`.

### Approval escalation

Evaluated locally first (same as bridge). For escalation: mail to parent. Optimization: if parent is also daemon-managed, resolve internally without mail round-trip.

### Reconnection

Centralized. On App Server restart: detect disconnect on any agent, stagger reconnection (not all at once), rebuild each agent with checkpoint + `buildReconnectPrompt`. Agents that fail max attempts are marked failed.

### Shutdown

Per-agent: `performShutdownBookkeeping` (existing extracted function). Daemon-wide: drain all agents, stop App Server if last codex process, remove `.overstory/daemon.json`, exit.

## Configuration

```yaml
codex:
  enabled: true
  intraProcess: false    # false = bridge (current), true = daemon (new)
  daemonPort: 0          # 0 = dynamic (OS-assigned), >0 = fixed port
  model: gpt-5.3-codex
  serverPort: 21816
  compactionThreshold: 0.8
  maxDeltaBufferBytes: 1048576
  approvalTimeoutMs: 60000
  defaultRuntime:
    builder: codex
    reviewer: codex
```

## File Layout

### New files

```
src/drivers/
  types.ts                  # AgentDriver interface + types
  resolve.ts                # resolveDriver factory
  claude.ts                 # ClaudeDriver
  codex-bridge.ts           # CodexBridgeDriver
  codex-daemon.ts           # CodexDaemonDriver (HTTP client)
  *.test.ts                 # Colocated tests

src/codex/daemon/
  server.ts                 # Bun.serve() HTTP server + routing
  pool.ts                   # AgentPool (ManagedAgent lifecycle)
  session.ts                # Per-agent session runner (refactored from bridge.ts)
  *.test.ts                 # Colocated tests
```

### Modified files

```
src/types.ts                # Extend AgentRuntime, add intraProcess + daemonPort to CodexConfig
src/config.ts               # Parse new codex fields, default daemonPort to 0
src/sessions/store.ts       # Allow tmuxSession sentinel for daemon agents
src/watchdog/health.ts      # Add runtime-aware health evaluation (skip tmux for daemon agents)
src/watchdog/daemon.ts       # Resolve driver for nudge calls instead of direct nudgeAgent()
src/commands/sling.ts       # Replace if/else with driver.spawn(ctx), persist resolved runtime
src/commands/nudge.ts       # Replace if/else with driver.nudge()
src/commands/status.ts      # Optional: driver.inspect() for richer status
src/codex/bridge.ts         # Ensure runBridgeSession is importable (already is)
config.yaml.sample          # Add intraProcess + daemonPort
```

### Refactoring scope

**sling.ts**: Steps 1-11 stay. Steps 12+ become `driver.spawn(ctx)`. The big if/else block for claude vs codex paths is replaced by a single driver dispatch.

**nudge.ts**: Runtime-specific SIGUSR1 vs sendKeys becomes `driver.nudge()`.

## Amendments (v2 — Codex Review Responses)

### [P0] Session/Watchdog Model: Runtime-Aware Health

**Problem:** `tmuxSession` is `TEXT NOT NULL` in `sessions.db` schema (store.ts:84), and the watchdog's ZFC Rule 1 (health.ts:126) marks any agent with a dead tmux session as zombie immediately. Daemon-managed agents have no tmux session.

**Solution:**

1. **Extend `AgentRuntime`** to `"claude" | "codex" | "codex-daemon"`. Persisted per-session in SessionStore.

2. **Make `tmuxSession` nullable in schema.** Daemon-managed agents set `tmuxSession = NULL`. Migration: `ALTER TABLE sessions ALTER COLUMN tmux_session DROP NOT NULL` (SQLite doesn't support ALTER COLUMN, so we use the existing migration pattern: check column info, recreate table if needed, or just allow empty string as sentinel value `"daemon:<agent-name>"`).

   **Decision:** Use sentinel value `"daemon:<agent-name>"` rather than NULL. This avoids a schema migration and keeps existing queries working. The watchdog checks for the `daemon:` prefix to skip tmux liveness.

3. **Add runtime-aware health evaluation in `health.ts`.** Before the ZFC tmux check:

   ```typescript
   // Skip tmux liveness for daemon-managed agents — use daemon HTTP health instead
   if (session.runtime === "codex-daemon") {
     return evaluateDaemonHealth(session, daemonUrl);
   }
   ```

   `evaluateDaemonHealth()` calls `GET /agents/:name` on the daemon and uses the response state. If the daemon itself is unreachable, mark the agent as zombie (same severity as tmux dead).

4. **Watchdog daemon.ts must resolve the correct driver** for nudge calls. Currently it calls `nudgeAgent()` directly (daemon.ts:539). After refactor, it should resolve the driver from `session.runtime` and call `driver.nudge()`.

### [P0] Per-Session Driver Persistence

**Problem:** `AgentRuntime = "claude" | "codex"` doesn't distinguish bridge from daemon. If `intraProcess` is toggled, existing sessions route to the wrong backend.

**Solution:**

1. Add `"codex-daemon"` to `AgentRuntime` type: `export type AgentRuntime = "claude" | "codex" | "codex-daemon";`
2. `resolveRuntimeForSpawn()` (see Driver Resolution above) maps `codex + intraProcess=true → "codex-daemon"` at spawn time.
3. The resolved runtime is stored on `AgentSession.runtime` and persisted in SessionStore.
4. All operation-time lookups (nudge, inspect, shutdown) read `session.runtime` and resolve the driver from that — never from config.
5. **Mixed fleets are explicitly supported.** Some agents can be `"codex"` (bridge) and others `"codex-daemon"` (daemon) in the same run. This is the natural state during migration.

### [P1] Nudge Force Flag

**Problem:** Watchdog passes `force=true` to `nudgeAgent()` (daemon.ts:543) to bypass debounce. The AgentDriver.nudge interface had no force parameter.

**Solution:** Added `NudgeOptions` to the interface (see updated interface above). All driver implementations honor `opts.force` by skipping their internal debounce when set. The daemon HTTP endpoint `/agents/:name/nudge` accepts `{ message, force }` in the body.

### [P1] close() Ownership and Daemon Lifetime

**Problem:** Singleton driver + any caller can close() = kills all active agents.

**Solution:** Daemon lifetime is independent of driver instances.

1. **The daemon is started explicitly** by `overstory daemon start` (called by CodexDaemonDriver.spawn() if not running) and **stopped explicitly** by `overstory daemon stop` or `overstory clean`.
2. **CodexDaemonDriver.close() is a no-op for normal usage.** The driver is a thin HTTP client — it doesn't own the daemon process.
3. **Daemon self-drains** when the last managed agent completes (same pattern as `stopServer` in bridge.ts:269-287 — check active codex-daemon sessions, stop if zero).
4. **Coordinator shutdown** sends `POST /shutdown` to the daemon as part of its cleanup sequence.
5. **`overstory clean --all`** force-stops the daemon regardless of active agents.

### [P1] Control Plane Security

**Problem:** HTTP API on localhost with no auth. Any local process can spawn/steer/shutdown agents.

**Solution:**

1. **Bearer token.** On daemon startup, generate a random 32-byte token, write it to `.overstory/daemon.json` alongside pid/port/url. The daemon validates `Authorization: Bearer <token>` on all mutation endpoints (POST, DELETE). GET /health is unauthenticated (liveness only, no sensitive data).
2. **File permissions.** `daemon.json` is created with mode `0600` (owner read/write only).
3. **CodexDaemonDriver reads the token** from `daemon.json` and includes it in all HTTP requests.
4. **Localhost binding.** Daemon binds to `127.0.0.1` only (not `0.0.0.0`).

### [P1] Port Allocation and Multi-Project

**Problem:** Fixed `daemonPort: 21817` collides across projects.

**Solution:**

1. **Dynamic port allocation.** When `daemonPort` is `0` (or omitted), the daemon binds to port 0 and lets the OS assign a free port. The actual port is written to `daemon.json`.
2. **Default: 0 (dynamic).** Change the default from `21817` to `0`. Users who want a fixed port can set one explicitly.
3. **Project-scoped state file.** `daemon.json` lives in `.overstory/` (project-local), so each project has its own daemon instance and state.
4. **Race-safe startup.** On spawn, `CodexDaemonDriver` uses a file lock (`.overstory/daemon.lock`) to prevent parallel CLI invocations from starting duplicate daemons. Pattern: acquire lock → check daemon.json → start if needed → write daemon.json → release lock.

### [P1] Failure Isolation and Daemon Crash Recovery

**Problem:** Bridge-per-agent gives process isolation. Daemon centralizes failure. Plan has no crash-restart contract.

**Solution:**

1. **Watchdog monitors daemon process.** Add a health check in `health.ts` that verifies the daemon PID from `daemon.json` is alive. If dead, the watchdog restarts it via `overstory daemon start`.
2. **Agent recovery after daemon restart.** When the daemon starts, it reads `sessions.db` for active `codex-daemon` sessions. For each, it reconnects to the App Server, creates a new thread, and resumes with checkpoint data (same as bridge reconnection). Agents that can't be recovered are marked `"failed"`.
3. **Checkpoint persistence.** The daemon saves checkpoints to disk (same `agents/<name>/checkpoint.json` path as bridge), so recovery data survives daemon crashes.
4. **No journal replay.** The daemon's in-memory state (delta buffers, item start times) is lost on crash. This is acceptable — the checkpoint captures progress summary, modified files, and branch. The model re-reads AGENTS.md on recovery.
5. **Watchdog restart SLA.** Tier 0 check interval (default 30s) means daemon crash is detected within 30s. Restart + agent reconnection adds another 5-10s per agent.

### [P2] Approval Audit Trail

**Problem:** Internal approval short-circuit bypasses mail traceability.

**Solution:** Internal approval resolution MUST still:
1. Record the approval decision in `events.db` as a `tool_end` event with `toolName: "Approval"` (same as bridge does for external approvals).
2. Optionally mirror to mail with `type: "status"` for operators who filter on mail for audit. This is configurable: `codex.auditApprovalsToMail: true` (default false for v1).

The short-circuit optimization is about latency (skip the mail round-trip for the decision), not about skipping the audit record.

### [P2] Additional Test Scenarios

Add to the testing strategy:

- **Concurrent /agents POST**: Two parallel spawn calls must not create duplicate agents. Test with Promise.all.
- **Mixed bridge+daemon fleet**: Spawn one codex (bridge) and one codex-daemon agent. Verify nudge/inspect routes correctly.
- **Daemon crash mid-turn**: Kill daemon PID during an active turn. Verify watchdog detects + restarts, agents recover from checkpoint.
- **Config flip during active sessions**: Change `intraProcess` while agents are running. Verify existing agents continue working (routing uses persisted runtime, not config).
- **Token validation**: Requests without valid bearer token return 401 on mutation endpoints.
- **Port race**: Two sling calls racing to start daemon. Verify file lock prevents double-start.

### [P2] Rollout Plan

**Phase A: Driver Extraction (no behavior change)**
- Extract ClaudeDriver and CodexBridgeDriver from sling.ts/nudge.ts.
- All existing tests pass. `intraProcess` defaults to `false`.
- Ship and validate in production. This is the safe rollback point.

**Phase B: Daemon Infrastructure (behind flag)**
- Build daemon pool, server, lifecycle. Add CodexDaemonDriver.
- `intraProcess: false` by default. Daemon code exists but is never activated.
- Ship. No behavior change for anyone.

**Phase C: Opt-in Daemon Mode**
- Set `intraProcess: true` in a single test project.
- Run a mixed fleet (some bridge, some daemon agents) to validate interop.
- Monitor: daemon stability, approval latency improvement, watchdog behavior.
- Canary criteria: zero zombie misclassifications, approval latency <500ms, daemon uptime >99%.

**Phase D: Default Flip**
- Change default to `intraProcess: true` after canary passes for 1 week.
- Rollback trigger: any daemon crash that loses agent progress, or zombie misclassification rate >0.

**Migration handling:** Existing `"codex"` sessions in SessionStore are bridge sessions. New daemon sessions are `"codex-daemon"`. The two coexist. No migration of running sessions is needed — they complete naturally on their original backend.

## Testing Strategy

- **ClaudeDriver/CodexBridgeDriver tests**: Verify they produce the same tmux/subprocess calls as the current inline code. Mock tmux (real tmux interferes with dev sessions).
- **CodexDaemonDriver tests**: Mock HTTP calls to daemon. Verify request/response shapes.
- **Pool tests**: Use real SQLite (in-memory) for events/mail/sessions. Mock RPC client (WS connections).
- **Daemon server tests**: Use real Bun.serve on random port. Test HTTP API with fetch.
- **Integration**: Covered by existing bridge-integration.integration.ts pattern. Add daemon-integration.integration.ts.
