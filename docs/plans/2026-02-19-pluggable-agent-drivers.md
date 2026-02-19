# Pluggable Agent Drivers

**Date:** 2026-02-19
**Status:** Approved
**Branch:** TBD (will be created in worktree)

## Problem

The Codex App Server integration currently runs as a separate bridge process per agent, spawned in tmux. This adds latency (mail-based approval escalation takes 2-7s), operational overhead (N bridge processes to monitor), and makes coordinator-to-agent communication indirect.

The coordinator communicates with Codex agents entirely through mail (async, eventually-consistent), while Claude Code agents benefit from direct tmux interaction. We want an intra-process alternative where the coordinator's sidecar daemon manages Codex agents directly via multiplexed WebSocket connections.

Additionally, the spawn and lifecycle logic for both runtimes (Claude Code, Codex bridge) is hardcoded as inline if/else branches in `sling.ts` and `nudge.ts`. Adding a third runtime path would make this worse.

## Solution

Introduce a pluggable `AgentDriver` interface (strategy pattern) that covers the full agent lifecycle. Three implementations:

- **ClaudeDriver** — existing Claude Code tmux path (extraction)
- **CodexBridgeDriver** — existing out-of-process bridge path (extraction)
- **CodexDaemonDriver** — new intra-process path via a sidecar HTTP daemon

A config flag (`codex.intraProcess`) selects between CodexBridgeDriver and CodexDaemonDriver when the runtime is `"codex"`.

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

interface AgentDriver {
  readonly name: string;
  spawn(ctx: SpawnContext): Promise<SpawnResult>;
  nudge(agentName: string, message: string, from: string): Promise<void>;
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

4. **`close()`** for driver-level cleanup. CodexDaemonDriver stops the sidecar. Others are no-op.

## Driver Resolution

```typescript
// src/drivers/resolve.ts
function resolveDriver(runtime: AgentRuntime, config: OverstoryConfig): AgentDriver {
  switch (runtime) {
    case "claude":
      return new ClaudeDriver();
    case "codex":
      return config.codex?.intraProcess
        ? getCodexDaemonDriver(config) // singleton, starts daemon if needed
        : new CodexBridgeDriver(config);
  }
}
```

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
  daemonPort: 21817      # HTTP port for daemon API
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
src/types.ts                # Add intraProcess + daemonPort to CodexConfig
src/config.ts               # Parse new codex fields
src/commands/sling.ts       # Replace if/else with driver.spawn(ctx)
src/commands/nudge.ts       # Replace if/else with driver.nudge()
src/commands/status.ts      # Optional: driver.inspect() for richer status
src/codex/bridge.ts         # Ensure runBridgeSession is importable (already is)
config.yaml.sample          # Add intraProcess + daemonPort
```

### Refactoring scope

**sling.ts**: Steps 1-11 stay. Steps 12+ become `driver.spawn(ctx)`. The big if/else block for claude vs codex paths is replaced by a single driver dispatch.

**nudge.ts**: Runtime-specific SIGUSR1 vs sendKeys becomes `driver.nudge()`.

## Testing Strategy

- **ClaudeDriver/CodexBridgeDriver tests**: Verify they produce the same tmux/subprocess calls as the current inline code. Mock tmux (real tmux interferes with dev sessions).
- **CodexDaemonDriver tests**: Mock HTTP calls to daemon. Verify request/response shapes.
- **Pool tests**: Use real SQLite (in-memory) for events/mail/sessions. Mock RPC client (WS connections).
- **Daemon server tests**: Use real Bun.serve on random port. Test HTTP API with fetch.
- **Integration**: Covered by existing bridge-integration.integration.ts pattern. Add daemon-integration.integration.ts.
