# Codex App Server Integration — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Codex CLI App Server as an optional execution backend for overstory worker agents, achieving full functional parity with the existing Claude Code path.

**Architecture:** A bridge adapter process (per-worker, in tmux) mediates between overstory and a shared Codex App Server via JSON-RPC 2.0 over WebSocket. The bridge implements approval gateway (replaces PreToolUse hooks), event normalization (replaces PostToolUse hooks), and lifecycle management (replaces SessionStart/Stop hooks). All events are normalized into the existing EventStore/SessionStore/MetricsStore schema so downstream systems are runtime-agnostic.

**Tech Stack:** Bun (TypeScript, bun:sqlite, Bun.spawn), WebSocket (Bun built-in), JSON-RPC 2.0 (hand-rolled, zero deps)

**Reference:** See `docs/plans/CODEX-CLAUDE-MAPPINGS.md` for the full design rationale, gap analysis, and parity mappings.

---

## Phase 1: Foundation Types & Config

### Task 1: Add `runtime` field to AgentSession and related types

**Files:**
- Modify: `src/types.ts`
- Test: `src/config.test.ts` (existing tests still pass)

**Step 1: Write the failing test**

Add to an existing or new test that validates AgentSession includes `runtime`:

```typescript
// In a new file src/codex/types.test.ts or inline assertion
import type { AgentSession } from "../types";

// Type-level test: this should compile
const session: AgentSession = {
  id: "test",
  agentName: "test",
  capability: "builder",
  worktreePath: "/tmp/test",
  branchName: "test",
  beadId: "test-123",
  tmuxSession: "overstory-test-test",
  state: "booting",
  pid: null,
  parentAgent: null,
  depth: 0,
  runId: null,
  startedAt: new Date().toISOString(),
  lastActivity: new Date().toISOString(),
  escalationLevel: 0,
  stalledSince: null,
  runtime: "claude", // <-- new field
};
```

**Step 2: Run test to verify it fails**

Run: `bun run typecheck`
Expected: Error — `runtime` does not exist on type `AgentSession`

**Step 3: Add types to `src/types.ts`**

Add after the existing `AgentSession` interface (around line 100):

```typescript
/** Execution runtime for an agent */
export type AgentRuntime = "claude" | "codex";
```

Add to `AgentSession` interface:

```typescript
runtime: AgentRuntime;
```

Add new `CodexConfig` type and extend `OverstoryConfig`:

```typescript
export interface CodexConfig {
  /** Whether Codex backend is enabled */
  enabled: boolean;
  /** Default runtime per capability (fallback: "claude") */
  defaultRuntime: Partial<Record<string, AgentRuntime>>;
  /** WebSocket port for shared app-server */
  serverPort: number;
  /** Model to use for Codex agents (OpenAI model ID) */
  model: string;
  /** Token usage threshold (0-1) to trigger checkpoint before compaction */
  compactionThreshold: number;
  /** Max delta buffer size in bytes before truncation */
  maxDeltaBufferBytes: number;
  /** Approval escalation timeout in ms */
  approvalTimeoutMs: number;
}
```

Add `codex` field to `OverstoryConfig`:

```typescript
codex: CodexConfig;
```

**Step 4: Run typecheck to verify it passes**

Run: `bun run typecheck`
Expected: PASS (after fixing any downstream references that now need `runtime` and `codex`)

**Step 5: Commit**

```bash
git add src/types.ts
git commit -m "feat: add AgentRuntime, CodexConfig types to shared types"
```

---

### Task 2: Add CodexConfig defaults and parsing to config.ts

**Files:**
- Modify: `src/config.ts`
- Modify: `src/types.ts` (if not done in Task 1)
- Test: `src/config.test.ts`

**Step 1: Write the failing test**

Add to `src/config.test.ts`:

```typescript
test("DEFAULT_CONFIG includes codex section", () => {
  expect(DEFAULT_CONFIG.codex).toBeDefined();
  expect(DEFAULT_CONFIG.codex.enabled).toBe(false);
  expect(DEFAULT_CONFIG.codex.serverPort).toBe(21816);
  expect(DEFAULT_CONFIG.codex.model).toBe("o3");
  expect(DEFAULT_CONFIG.codex.compactionThreshold).toBe(0.8);
  expect(DEFAULT_CONFIG.codex.maxDeltaBufferBytes).toBe(1_048_576);
  expect(DEFAULT_CONFIG.codex.approvalTimeoutMs).toBe(60_000);
  expect(DEFAULT_CONFIG.codex.defaultRuntime).toEqual({});
});

test("config.yaml with codex section parses correctly", () => {
  // Write a config.yaml with codex section to temp dir
  const yaml = `project:
  name: test-project
  root: /tmp/test
  canonicalBranch: main
codex:
  enabled: true
  serverPort: 9999
  model: o3-pro
  defaultRuntime:
    builder: codex
    scout: claude
`;
  // ... parse and validate ...
  expect(config.codex.enabled).toBe(true);
  expect(config.codex.serverPort).toBe(9999);
  expect(config.codex.model).toBe("o3-pro");
  expect(config.codex.defaultRuntime.builder).toBe("codex");
  expect(config.codex.defaultRuntime.scout).toBe("claude");
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/config.test.ts`
Expected: FAIL — `DEFAULT_CONFIG.codex` is undefined

**Step 3: Add defaults and parsing**

In `src/config.ts`, add to `DEFAULT_CONFIG` (around line 9):

```typescript
codex: {
  enabled: false,
  defaultRuntime: {},
  serverPort: 21816,
  model: "o3",
  compactionThreshold: 0.8,
  maxDeltaBufferBytes: 1_048_576,
  approvalTimeoutMs: 60_000,
},
```

In `validateConfig()`, add codex validation:

```typescript
if (config.codex) {
  if (typeof config.codex.enabled !== "boolean") {
    errors.push("codex.enabled must be a boolean");
  }
  if (typeof config.codex.serverPort !== "number" || config.codex.serverPort < 1 || config.codex.serverPort > 65535) {
    errors.push("codex.serverPort must be a number between 1 and 65535");
  }
  if (typeof config.codex.compactionThreshold !== "number" || config.codex.compactionThreshold < 0 || config.codex.compactionThreshold > 1) {
    errors.push("codex.compactionThreshold must be a number between 0 and 1");
  }
  // Validate defaultRuntime values
  for (const [key, value] of Object.entries(config.codex.defaultRuntime)) {
    if (value !== "claude" && value !== "codex") {
      errors.push(`codex.defaultRuntime.${key} must be "claude" or "codex"`);
    }
  }
}
```

**Step 4: Run tests**

Run: `bun test src/config.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit -m "feat: add codex config section with defaults and validation"
```

---

### Task 3: Add `runtime` column to sessions.db

**Files:**
- Modify: `src/sessions/store.ts`
- Test: `src/sessions/store.test.ts` (if exists, else colocated)

**Step 1: Write the failing test**

```typescript
test("session with runtime field persists and retrieves", () => {
  const store = openSessionStore(":memory:");
  store.upsert({
    id: "sess-1",
    agentName: "test-agent",
    capability: "builder",
    worktreePath: "/tmp/test",
    branchName: "test-branch",
    beadId: "test-123",
    tmuxSession: "overstory-test-test-agent",
    state: "booting",
    pid: null,
    parentAgent: null,
    depth: 0,
    runId: null,
    startedAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    escalationLevel: 0,
    stalledSince: null,
    runtime: "codex",
  });
  const session = store.getByName("test-agent");
  expect(session?.runtime).toBe("codex");
  store.close();
});

test("session defaults runtime to claude when not specified", () => {
  const store = openSessionStore(":memory:");
  // Insert without explicit runtime
  store.upsert({
    // ... all fields ...
    runtime: "claude",
  });
  const session = store.getByName("test-agent");
  expect(session?.runtime).toBe("claude");
  store.close();
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/sessions/store.test.ts`
Expected: FAIL — `runtime` not in schema or type

**Step 3: Add runtime column**

In `src/sessions/store.ts`, update the CREATE TABLE statement to include:

```sql
runtime TEXT DEFAULT 'claude'
```

Update `rowToSession()` to include:

```typescript
runtime: (row.runtime as AgentRuntime) ?? "claude",
```

Update the INSERT/UPDATE statement in `upsert()` to include the `runtime` column.

Add migration for existing databases (check if column exists, ALTER TABLE ADD COLUMN if not):

```typescript
function migrateRuntimeColumn(db: Database): void {
  const columns = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
  const hasRuntime = columns.some((c) => c.name === "runtime");
  if (!hasRuntime) {
    db.exec("ALTER TABLE sessions ADD COLUMN runtime TEXT DEFAULT 'claude'");
  }
}
```

Call `migrateRuntimeColumn(db)` after table creation in `openSessionStore()`.

**Step 4: Run tests**

Run: `bun test src/sessions/store.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/sessions/store.ts src/sessions/store.test.ts
git commit -m "feat: add runtime column to sessions store with migration"
```

---

## Phase 2: Codex-Specific Types

### Task 4: Create `src/codex/types.ts` with all Codex protocol types

**Files:**
- Create: `src/codex/types.ts`
- Test: `src/codex/types.test.ts`

**Step 1: Write the type-level test**

```typescript
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  ThreadStartParams,
  TurnStartParams,
  TurnSteerParams,
  ApprovalRequest,
  ApprovalResponse,
  DeltaBuffer,
  BridgeConfig,
  CodexItemType,
} from "./types";

// Type-level tests — these just need to compile
const req: JsonRpcRequest = {
  jsonrpc: "2.0",
  id: 1,
  method: "thread/start",
  params: {} as ThreadStartParams,
};

const notif: JsonRpcNotification = {
  jsonrpc: "2.0",
  method: "item/completed",
  params: { itemId: "test" },
};

const buf: DeltaBuffer = {
  itemId: "item-1",
  itemType: "commandExecution",
  startedAt: new Date().toISOString(),
  outputChunks: [],
  totalBytes: 0,
};
```

**Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: FAIL — module not found

**Step 3: Create the types file**

```typescript
// src/codex/types.ts
// All Codex App Server protocol types. Zero runtime code — types only.

/** JSON-RPC 2.0 base types */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

/** Thread lifecycle */
export interface ThreadStartParams {
  instructions?: string;
  model?: string;
  cwd?: string;
  sandboxPolicy?: SandboxPolicy;
  approvalPolicy?: "on-request" | "unless-allowed" | "never";
}

export interface ThreadStartResult {
  threadId: string;
}

export interface SandboxPolicy {
  type: "dangerFullAccess" | "readOnly" | "workspaceWrite";
  writableRoots?: string[];
  networkAccess?: boolean;
}

/** Turn lifecycle */
export interface TurnStartParams {
  threadId: string;
  input: string;
}

export interface TurnSteerParams {
  threadId: string;
  turnId: string;
  input: string;
}

export interface TurnCompletedParams {
  threadId: string;
  turnId: string;
  status: "completed" | "failed" | "interrupted" | "cancelled";
  error?: string;
}

/** Approval workflow */
export type ApprovalItemType = "commandExecution" | "fileChange";

export interface ApprovalRequest {
  threadId: string;
  turnId: string;
  itemId: string;
  type: ApprovalItemType;
  command?: string;          // For commandExecution
  changes?: FileChange[];    // For fileChange
}

export interface FileChange {
  path: string;
  kind: "add" | "update" | "delete";
  content?: string;
}

export type ApprovalDecision =
  | "accept"
  | "acceptForSession"
  | "decline"
  | "cancel";

export interface ApprovalResponse {
  decision: ApprovalDecision;
  reason?: string;
}

/** Item events */
export type CodexItemType =
  | "commandExecution"
  | "fileChange"
  | "agentMessage"
  | "reasoning"
  | "mcpToolCall"
  | "webSearch"
  | "contextCompaction";

export interface ItemStartedParams {
  threadId: string;
  turnId: string;
  itemId: string;
  itemType: CodexItemType;
  data?: Record<string, unknown>;
}

export interface ItemCompletedParams {
  threadId: string;
  turnId: string;
  itemId: string;
  itemType: CodexItemType;
  status: "completed" | "failed" | "cancelled";
  data?: Record<string, unknown>;
}

export interface OutputDeltaParams {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

/** Token usage */
export interface TokenUsageParams {
  threadId: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  contextWindowSize: number;
}

/** Delta buffering */
export interface DeltaBuffer {
  itemId: string;
  itemType: CodexItemType;
  startedAt: string;          // ISO 8601
  outputChunks: string[];
  totalBytes: number;
}

/** Bridge configuration (passed as CLI flags or env vars) */
export interface BridgeConfig {
  agentName: string;
  worktreePath: string;
  branchName: string;
  beadId: string;
  capability: string;
  parentAgent: string | null;
  depth: number;
  runId: string | null;
  sessionId: string;
  serverUrl: string;           // ws://127.0.0.1:<port>
  model: string;
  compactionThreshold: number;
  maxDeltaBufferBytes: number;
  approvalTimeoutMs: number;
  fileScope: string[];
  projectRoot: string;         // Canonical repo root (for .overstory/ access)
}

/** Server state file (.overstory/codex-server.json) */
export interface CodexServerState {
  pid: number;
  port: number;
  startedAt: string;
  url: string;
}
```

**Step 4: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

**Step 5: Commit**

```bash
git add src/codex/types.ts src/codex/types.test.ts
git commit -m "feat: add Codex App Server protocol types"
```

---

## Phase 3: Approval Gateway

### Task 5: Create approval gateway with safe/danger/capability logic

**Files:**
- Create: `src/codex/approval.ts`
- Test: `src/codex/approval.test.ts`

This is the TypeScript equivalent of all guard logic in `src/agents/hooks-deployer.ts`. Import the existing constants (`SAFE_BASH_PREFIXES`, `DANGEROUS_BASH_PATTERNS`, etc.) directly from hooks-deployer to maintain a single source of truth.

**Step 1: Write the failing tests**

```typescript
// src/codex/approval.test.ts
import { describe, test, expect } from "bun:test";
import { evaluateCommandApproval, evaluateFileChangeApproval } from "./approval";

describe("evaluateCommandApproval", () => {
  const builderCtx = {
    capability: "builder",
    agentName: "builder-1",
    worktreePath: "/repo/.overstory/worktrees/builder-1",
    fileScope: ["src/foo.ts", "src/bar.ts"],
  };

  const scoutCtx = {
    capability: "scout",
    agentName: "scout-1",
    worktreePath: "/repo/.overstory/worktrees/scout-1",
    fileScope: [],
  };

  test("auto-approves safe prefixes", () => {
    const result = evaluateCommandApproval("overstory mail check --agent test", builderCtx);
    expect(result.decision).toBe("accept");
  });

  test("auto-approves bun test", () => {
    const result = evaluateCommandApproval("bun test src/foo.test.ts", builderCtx);
    expect(result.decision).toBe("accept");
  });

  test("declines git push", () => {
    const result = evaluateCommandApproval("git push origin main", builderCtx);
    expect(result.decision).toBe("decline");
    expect(result.reason).toContain("push");
  });

  test("declines git reset --hard", () => {
    const result = evaluateCommandApproval("git reset --hard HEAD~1", builderCtx);
    expect(result.decision).toBe("decline");
  });

  test("declines file-modifying bash for scout", () => {
    const result = evaluateCommandApproval("sed -i 's/foo/bar/' file.txt", scoutCtx);
    expect(result.decision).toBe("decline");
    expect(result.reason).toContain("scout");
  });

  test("allows overstory spec write for scout", () => {
    const result = evaluateCommandApproval("overstory spec write task-123 --body 'test'", scoutCtx);
    expect(result.decision).toBe("accept");
  });

  test("allows git add/commit for coordinator", () => {
    const coordCtx = { ...scoutCtx, capability: "coordinator" };
    expect(evaluateCommandApproval("git add .beads/", coordCtx).decision).toBe("accept");
    expect(evaluateCommandApproval("git commit -m 'sync'", coordCtx).decision).toBe("accept");
  });

  test("returns escalate for unknown commands", () => {
    const result = evaluateCommandApproval("curl https://example.com", builderCtx);
    expect(result.decision).toBe("escalate");
  });
});

describe("evaluateFileChangeApproval", () => {
  const builderCtx = {
    capability: "builder",
    agentName: "builder-1",
    worktreePath: "/repo/.overstory/worktrees/builder-1",
    fileScope: ["src/foo.ts", "src/bar.ts"],
  };

  test("approves file change within scope", () => {
    const result = evaluateFileChangeApproval(
      [{ path: "/repo/.overstory/worktrees/builder-1/src/foo.ts", kind: "update" }],
      builderCtx,
    );
    expect(result.decision).toBe("accept");
  });

  test("declines file change outside worktree", () => {
    const result = evaluateFileChangeApproval(
      [{ path: "/repo/src/foo.ts", kind: "update" }],
      builderCtx,
    );
    expect(result.decision).toBe("decline");
  });

  test("declines all file changes for non-implementation capability", () => {
    const scoutCtx = { ...builderCtx, capability: "scout" };
    const result = evaluateFileChangeApproval(
      [{ path: "/repo/.overstory/worktrees/builder-1/src/foo.ts", kind: "update" }],
      scoutCtx,
    );
    expect(result.decision).toBe("decline");
  });

  test("escalates file change within worktree but outside scope", () => {
    const result = evaluateFileChangeApproval(
      [{ path: "/repo/.overstory/worktrees/builder-1/src/other.ts", kind: "add" }],
      builderCtx,
    );
    expect(result.decision).toBe("escalate");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/codex/approval.test.ts`
Expected: FAIL — module not found

**Step 3: Implement approval gateway**

```typescript
// src/codex/approval.ts
import {
  NON_IMPLEMENTATION_CAPABILITIES,
  COORDINATION_CAPABILITIES,
  COORDINATION_SAFE_PREFIXES,
  SAFE_BASH_PREFIXES,
  DANGEROUS_BASH_PATTERNS,
} from "../agents/hooks-deployer";
import type { FileChange } from "./types";

export interface ApprovalContext {
  capability: string;
  agentName: string;
  worktreePath: string;
  fileScope: string[];
}

export type ApprovalResult =
  | { decision: "accept"; reason?: string }
  | { decision: "acceptForSession"; reason?: string }
  | { decision: "decline"; reason: string }
  | { decision: "escalate"; reason: string };

/** Scout-specific write exception */
const SCOUT_WRITE_PREFIXES = ["overstory spec write"];

/**
 * Evaluate a command execution approval request.
 * Mirrors the guard logic in hooks-deployer.ts but with structured input.
 */
export function evaluateCommandApproval(
  command: string,
  ctx: ApprovalContext,
): ApprovalResult {
  const trimmed = command.trim();

  // 1. Check safe prefixes first (whitelist-first, same as buildBashFileGuardScript)
  const allSafePrefixes = [...SAFE_BASH_PREFIXES];
  if (COORDINATION_CAPABILITIES.has(ctx.capability)) {
    allSafePrefixes.push(...COORDINATION_SAFE_PREFIXES);
  }
  if (ctx.capability === "scout") {
    allSafePrefixes.push(...SCOUT_WRITE_PREFIXES);
  }
  for (const prefix of allSafePrefixes) {
    if (trimmed.startsWith(prefix)) {
      return { decision: "accept" };
    }
  }

  // 2. Check danger patterns (all agents)
  for (const pattern of DANGEROUS_BASH_PATTERNS) {
    if (new RegExp(pattern).test(trimmed)) {
      // Allow git add/commit for coordination capabilities
      if (COORDINATION_CAPABILITIES.has(ctx.capability)) {
        if (trimmed.startsWith("git add") || trimmed.startsWith("git commit")) {
          return { decision: "accept" };
        }
      }
      return {
        decision: "decline",
        reason: `Blocked: command matches dangerous pattern "${pattern}" for ${ctx.capability} agent`,
      };
    }
  }

  // 3. For non-implementation agents, block file-modifying commands
  if (NON_IMPLEMENTATION_CAPABILITIES.has(ctx.capability)) {
    // FILE_MODIFYING_BASH_PATTERNS is not exported from hooks-deployer,
    // but the DANGEROUS_BASH_PATTERNS already covers most of them.
    // The safe prefix check above already passed, so if we're here
    // it's an unknown command — escalate.
  }

  // 4. Unknown command — escalate to parent
  return {
    decision: "escalate",
    reason: `Unknown command requires parent approval: ${trimmed.slice(0, 80)}`,
  };
}

/**
 * Evaluate a file change approval request.
 * Mirrors path boundary + file scope guards from hooks-deployer.ts.
 */
export function evaluateFileChangeApproval(
  changes: ReadonlyArray<Pick<FileChange, "path" | "kind">>,
  ctx: ApprovalContext,
): ApprovalResult {
  // Non-implementation agents cannot modify files
  if (NON_IMPLEMENTATION_CAPABILITIES.has(ctx.capability)) {
    return {
      decision: "decline",
      reason: `${ctx.capability} agents cannot modify files`,
    };
  }

  // Check each change path
  for (const change of changes) {
    const resolved = change.path.startsWith("/")
      ? change.path
      : `${ctx.worktreePath}/${change.path}`;

    // Must be within worktree
    if (!resolved.startsWith(ctx.worktreePath)) {
      return {
        decision: "decline",
        reason: `Path outside worktree: ${change.path}`,
      };
    }

    // Check file scope
    const relative = resolved.slice(ctx.worktreePath.length + 1);
    if (ctx.fileScope.length > 0 && !ctx.fileScope.includes(relative)) {
      return {
        decision: "escalate",
        reason: `File outside scope (${relative}), needs parent approval`,
      };
    }
  }

  return { decision: "accept" };
}
```

**Step 4: Run tests**

Run: `bun test src/codex/approval.test.ts`
Expected: PASS

**Step 5: Run all quality gates**

Run: `bun test && bun run lint && bun run typecheck`
Expected: PASS

**Step 6: Commit**

```bash
git add src/codex/approval.ts src/codex/approval.test.ts
git commit -m "feat: add Codex approval gateway with command and file change evaluation"
```

---

## Phase 4: JSON-RPC WebSocket Client

### Task 6: Create JSON-RPC 2.0 WebSocket client

**Files:**
- Create: `src/codex/rpc-client.ts`
- Test: `src/codex/rpc-client.test.ts`

**Step 1: Write the failing test**

Tests use a mock WebSocket server (Bun.serve with websocket upgrade) since this requires a real socket:

```typescript
// src/codex/rpc-client.test.ts
import { describe, test, expect, afterEach } from "bun:test";
import { createRpcClient } from "./rpc-client";

let server: ReturnType<typeof Bun.serve> | null = null;

afterEach(() => {
  server?.stop(true);
  server = null;
});

function startMockServer(handler: (ws: any, message: string) => void): number {
  const port = 30000 + Math.floor(Math.random() * 10000);
  server = Bun.serve({
    port,
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined;
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      message(ws, message) {
        handler(ws, String(message));
      },
    },
  });
  return port;
}

test("sends JSON-RPC request and receives response", async () => {
  const port = startMockServer((ws, msg) => {
    const req = JSON.parse(msg);
    ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id: req.id,
      result: { threadId: "thread-1" },
    }));
  });

  const client = await createRpcClient(`ws://127.0.0.1:${port}`);
  const result = await client.request("thread/start", { model: "o3" });
  expect(result).toEqual({ threadId: "thread-1" });
  client.close();
});

test("receives notifications via onNotification", async () => {
  const port = startMockServer((ws, msg) => {
    const req = JSON.parse(msg);
    // Send response
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: {} }));
    // Then send notification
    ws.send(JSON.stringify({
      jsonrpc: "2.0",
      method: "item/started",
      params: { itemId: "item-1" },
    }));
  });

  const notifications: Array<{ method: string; params: unknown }> = [];
  const client = await createRpcClient(`ws://127.0.0.1:${port}`);
  client.onNotification((method, params) => {
    notifications.push({ method, params });
  });
  await client.request("initialize", {});
  // Wait for notification delivery
  await Bun.sleep(100);
  expect(notifications.length).toBe(1);
  expect(notifications[0]?.method).toBe("item/started");
  client.close();
});

test("rejects on JSON-RPC error response", async () => {
  const port = startMockServer((ws, msg) => {
    const req = JSON.parse(msg);
    ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32600, message: "Invalid request" },
    }));
  });

  const client = await createRpcClient(`ws://127.0.0.1:${port}`);
  expect(client.request("bad/method", {})).rejects.toThrow("Invalid request");
  client.close();
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/codex/rpc-client.test.ts`
Expected: FAIL — module not found

**Step 3: Implement RPC client**

```typescript
// src/codex/rpc-client.ts
import type { JsonRpcRequest, JsonRpcResponse, JsonRpcNotification } from "./types";

export interface RpcClient {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  onNotification(handler: (method: string, params: unknown) => void): void;
  close(): void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export async function createRpcClient(
  url: string,
  opts?: { timeoutMs?: number },
): Promise<RpcClient> {
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  let nextId = 1;
  const pending = new Map<number | string, PendingRequest>();
  const notificationHandlers: Array<(method: string, params: unknown) => void> = [];

  const ws = new WebSocket(url);

  // Wait for connection
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("WebSocket connection timeout")), 10_000);
    ws.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve();
    });
    ws.addEventListener("error", (e) => {
      clearTimeout(timeout);
      reject(new Error(`WebSocket connection failed: ${e}`));
    });
  });

  ws.addEventListener("message", (event) => {
    const data = JSON.parse(String(event.data));

    // Response (has id)
    if ("id" in data && data.id != null) {
      const req = pending.get(data.id);
      if (!req) return;
      pending.delete(data.id);
      clearTimeout(req.timer);
      if (data.error) {
        req.reject(new Error(data.error.message ?? "JSON-RPC error"));
      } else {
        req.resolve(data.result);
      }
      return;
    }

    // Notification (no id)
    if ("method" in data) {
      for (const handler of notificationHandlers) {
        handler(data.method, data.params);
      }
    }
  });

  return {
    request(method, params) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`RPC timeout: ${method}`));
        }, timeoutMs);

        pending.set(id, { resolve, reject, timer });

        const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method };
        if (params) msg.params = params;
        ws.send(JSON.stringify(msg));
      });
    },

    onNotification(handler) {
      notificationHandlers.push(handler);
    },

    close() {
      for (const [id, req] of pending) {
        clearTimeout(req.timer);
        req.reject(new Error("Client closed"));
      }
      pending.clear();
      ws.close();
    },
  };
}
```

**Step 4: Run tests**

Run: `bun test src/codex/rpc-client.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/codex/rpc-client.ts src/codex/rpc-client.test.ts
git commit -m "feat: add JSON-RPC 2.0 WebSocket client for Codex App Server"
```

---

## Phase 5: Event Normalization & Delta Buffering

### Task 7: Create event normalization layer with delta buffering

**Files:**
- Create: `src/codex/events.ts`
- Test: `src/codex/events.test.ts`

**Step 1: Write the failing tests**

```typescript
// src/codex/events.test.ts
import { describe, test, expect } from "bun:test";
import {
  normalizeItemStarted,
  normalizeItemCompleted,
  createDeltaBufferManager,
  normalizeToolName,
} from "./events";

describe("normalizeToolName", () => {
  test("maps commandExecution to Bash", () => {
    expect(normalizeToolName("commandExecution")).toBe("Bash");
  });

  test("maps fileChange add to Write", () => {
    expect(normalizeToolName("fileChange", "add")).toBe("Write");
  });

  test("maps fileChange update to Edit", () => {
    expect(normalizeToolName("fileChange", "update")).toBe("Edit");
  });

  test("maps webSearch to WebSearch", () => {
    expect(normalizeToolName("webSearch")).toBe("WebSearch");
  });
});

describe("createDeltaBufferManager", () => {
  test("accumulates deltas and flushes on complete", () => {
    const mgr = createDeltaBufferManager(1_048_576);

    mgr.start("item-1", "commandExecution", "2024-01-01T00:00:00Z");
    mgr.appendDelta("item-1", "hello ");
    mgr.appendDelta("item-1", "world");

    const result = mgr.flush("item-1");
    expect(result).toBeDefined();
    expect(result!.output).toBe("hello world");
    expect(result!.totalBytes).toBe(11);
    expect(result!.truncated).toBe(false);
  });

  test("truncates when exceeding max buffer size", () => {
    const mgr = createDeltaBufferManager(10); // 10 byte max

    mgr.start("item-1", "commandExecution", "2024-01-01T00:00:00Z");
    mgr.appendDelta("item-1", "12345678901234567890");

    const result = mgr.flush("item-1");
    expect(result).toBeDefined();
    expect(result!.truncated).toBe(true);
    expect(result!.totalBytes).toBe(20);
  });

  test("returns null for unknown item", () => {
    const mgr = createDeltaBufferManager(1_048_576);
    expect(mgr.flush("nonexistent")).toBeNull();
  });
});

describe("normalizeItemStarted", () => {
  test("normalizes commandExecution to tool_start", () => {
    const event = normalizeItemStarted({
      agentName: "builder-1",
      sessionId: "sess-1",
      runId: "run-1",
      itemId: "item-1",
      itemType: "commandExecution",
      data: { command: "bun test" },
    });
    expect(event.eventType).toBe("tool_start");
    expect(event.toolName).toBe("Bash");
    expect(event.toolArgs).toContain("bun test");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/codex/events.test.ts`
Expected: FAIL — module not found

**Step 3: Implement event normalization**

```typescript
// src/codex/events.ts
import type { CodexItemType, DeltaBuffer } from "./types";
import type { StoredEvent } from "../types";

/** Map Codex item types to overstory canonical tool names */
export function normalizeToolName(
  itemType: CodexItemType,
  fileChangeKind?: string,
): string {
  switch (itemType) {
    case "commandExecution":
      return "Bash";
    case "fileChange":
      return fileChangeKind === "add" ? "Write" : "Edit";
    case "mcpToolCall":
      return "McpToolCall";
    case "webSearch":
      return "WebSearch";
    case "agentMessage":
      return "AgentMessage";
    case "reasoning":
      return "Reasoning";
    case "contextCompaction":
      return "Compaction";
    default:
      return String(itemType);
  }
}

/** Build InsertEvent from item/started notification */
export function normalizeItemStarted(params: {
  agentName: string;
  sessionId: string;
  runId: string | null;
  itemId: string;
  itemType: CodexItemType;
  data?: Record<string, unknown>;
}): {
  eventType: string;
  agentName: string;
  sessionId: string;
  runId: string | null;
  toolName: string;
  toolArgs: string | null;
  level: string;
  data: string | null;
} {
  const toolName = normalizeToolName(params.itemType);
  let toolArgs: string | null = null;

  if (params.data) {
    // Extract command for Bash, path for file changes
    const command = params.data.command as string | undefined;
    const path = params.data.path as string | undefined;
    toolArgs = command
      ? `bash: ${String(command).slice(0, 200)}`
      : path
        ? `${toolName.toLowerCase()}: ${path}`
        : JSON.stringify(params.data).slice(0, 200);
  }

  return {
    eventType: "tool_start",
    agentName: params.agentName,
    sessionId: params.sessionId,
    runId: params.runId,
    toolName,
    toolArgs,
    level: "info",
    data: params.data ? JSON.stringify({ itemId: params.itemId, ...params.data }) : null,
  };
}

/** Build InsertEvent from item/completed notification + flushed delta buffer */
export function normalizeItemCompleted(params: {
  agentName: string;
  sessionId: string;
  runId: string | null;
  itemId: string;
  itemType: CodexItemType;
  status: string;
  data?: Record<string, unknown>;
  deltaOutput?: { output: string; totalBytes: number; truncated: boolean } | null;
  durationMs: number | null;
}): {
  eventType: string;
  agentName: string;
  sessionId: string;
  runId: string | null;
  toolName: string;
  toolArgs: string | null;
  toolDurationMs: number | null;
  level: string;
  data: string | null;
} {
  const kind = params.data?.kind as string | undefined;
  const toolName = normalizeToolName(params.itemType, kind);

  let toolArgs: string | null = null;
  if (params.data) {
    const command = params.data.command as string | undefined;
    const path = params.data.path as string | undefined;
    toolArgs = command
      ? `bash: ${String(command).slice(0, 200)}`
      : path
        ? `${toolName.toLowerCase()}: ${path}`
        : JSON.stringify(params.data).slice(0, 200);
  }

  const eventData: Record<string, unknown> = {
    itemId: params.itemId,
    status: params.status,
  };
  if (params.data) Object.assign(eventData, params.data);
  if (params.deltaOutput) {
    eventData.outputSize = params.deltaOutput.totalBytes;
    eventData.outputTruncated = params.deltaOutput.truncated;
    // Include first 1000 chars of output for quick visibility
    eventData.outputPreview = params.deltaOutput.output.slice(0, 1000);
  }

  return {
    eventType: "tool_end",
    agentName: params.agentName,
    sessionId: params.sessionId,
    runId: params.runId,
    toolName,
    toolArgs,
    toolDurationMs: params.durationMs,
    level: params.status === "failed" ? "error" : "info",
    data: JSON.stringify(eventData),
  };
}

/** Delta buffer manager — accumulates outputDelta events per item */
export function createDeltaBufferManager(maxBytes: number) {
  const buffers = new Map<string, DeltaBuffer>();

  return {
    start(itemId: string, itemType: CodexItemType, startedAt: string): void {
      buffers.set(itemId, {
        itemId,
        itemType,
        startedAt,
        outputChunks: [],
        totalBytes: 0,
      });
    },

    appendDelta(itemId: string, delta: string): void {
      const buf = buffers.get(itemId);
      if (!buf) return;
      buf.totalBytes += delta.length;
      if (buf.totalBytes <= maxBytes) {
        buf.outputChunks.push(delta);
      }
      // If over max, stop accumulating but keep tracking totalBytes
    },

    flush(
      itemId: string,
    ): { output: string; totalBytes: number; truncated: boolean; startedAt: string } | null {
      const buf = buffers.get(itemId);
      if (!buf) return null;
      buffers.delete(itemId);
      const output = buf.outputChunks.join("");
      return {
        output,
        totalBytes: buf.totalBytes,
        truncated: buf.totalBytes > maxBytes,
        startedAt: buf.startedAt,
      };
    },

    /** Number of active buffers (for monitoring) */
    get size(): number {
      return buffers.size;
    },
  };
}
```

**Step 4: Run tests**

Run: `bun test src/codex/events.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/codex/events.ts src/codex/events.test.ts
git commit -m "feat: add Codex event normalization and delta buffer manager"
```

---

## Phase 6: AGENTS.md Overlay & Config Generation

### Task 8: Create AGENTS.md overlay template and generator

**Files:**
- Create: `templates/agents-overlay.md.tmpl`
- Create: `src/codex/overlay.ts`
- Test: `src/codex/overlay.test.ts`

This mirrors `src/agents/overlay.ts` and `templates/overlay.md.tmpl` but adapted for Codex's AGENTS.md format. The content is structurally identical — same sections (assignment, file scope, quality gates, constraints, communication) — but with Codex-specific tool names and runtime instructions.

**Step 1: Write the failing test**

```typescript
// src/codex/overlay.test.ts
import { describe, test, expect } from "bun:test";
import { generateAgentsOverlay } from "./overlay";
import type { OverlayConfig } from "../types";

const baseConfig: OverlayConfig = {
  agentName: "builder-1",
  beadId: "task-123",
  specPath: "/repo/.overstory/specs/task-123.md",
  branchName: "overstory/builder-1/task-123",
  worktreePath: "/repo/.overstory/worktrees/builder-1",
  fileScope: ["src/foo.ts", "src/bar.ts"],
  mulchDomains: ["cli"],
  parentAgent: "lead-1",
  depth: 2,
  canSpawn: false,
  capability: "builder",
  baseDefinition: "# Builder Agent\n\nYou are a builder.",
};

test("generates AGENTS.md with agent name", async () => {
  const content = await generateAgentsOverlay(baseConfig);
  expect(content).toContain("builder-1");
  expect(content).toContain("task-123");
  expect(content).toContain("src/foo.ts");
});

test("does not reference CLAUDE.md or Claude Code tools", async () => {
  const content = await generateAgentsOverlay(baseConfig);
  expect(content).not.toContain(".claude/CLAUDE.md");
  expect(content).not.toContain("--dangerously-skip-permissions");
});

test("includes worktree path in constraints", async () => {
  const content = await generateAgentsOverlay(baseConfig);
  expect(content).toContain("/repo/.overstory/worktrees/builder-1");
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/codex/overlay.test.ts`
Expected: FAIL — module not found

**Step 3: Create the template and generator**

Create `templates/agents-overlay.md.tmpl` — same structure as `templates/overlay.md.tmpl` but:
- Replaces `.claude/CLAUDE.md` references with `AGENTS.md`
- Removes Claude Code-specific tool references
- Communication uses `overstory mail` (same — runtime-agnostic)

Create `src/codex/overlay.ts`:

```typescript
// src/codex/overlay.ts
import type { OverlayConfig } from "../types";
import { join, resolve } from "node:path";

// Reuse formatting helpers from the Claude Code overlay module
import {
  formatFileScope,
  formatMulchDomains,
  formatMulchExpertise,
  formatQualityGates,
  formatConstraints,
  formatCanSpawn,
} from "../agents/overlay";

function getTemplatePath(): string {
  return resolve(join(import.meta.dir, "../../templates/agents-overlay.md.tmpl"));
}

export async function generateAgentsOverlay(config: OverlayConfig): Promise<string> {
  const templatePath = getTemplatePath();
  const file = Bun.file(templatePath);
  if (!(await file.exists())) {
    throw new Error(`AGENTS.md template not found at ${templatePath}`);
  }
  let content = await file.text();

  // Same placeholder replacement as overlay.ts
  const replacements: Record<string, string> = {
    "{{BASE_DEFINITION}}": config.baseDefinition,
    "{{AGENT_NAME}}": config.agentName,
    "{{BEAD_ID}}": config.beadId,
    "{{SPEC_PATH}}": config.specPath ?? "No spec provided",
    "{{BRANCH_NAME}}": config.branchName,
    "{{WORKTREE_PATH}}": config.worktreePath,
    "{{PARENT_AGENT}}": config.parentAgent ?? "orchestrator",
    "{{DEPTH}}": String(config.depth),
    "{{FILE_SCOPE}}": formatFileScope(config.fileScope),
    "{{MULCH_DOMAINS}}": formatMulchDomains(config.mulchDomains),
    "{{MULCH_EXPERTISE}}": formatMulchExpertise(config.mulchExpertise),
    "{{CAN_SPAWN}}": formatCanSpawn(config),
    "{{QUALITY_GATES}}": formatQualityGates(config),
    "{{CONSTRAINTS}}": formatConstraints(config),
    "{{SPEC_INSTRUCTION}}": config.specPath
      ? `Read your task spec at the path above.`
      : `No task spec provided. Check mail for instructions.`,
  };

  for (const [key, value] of Object.entries(replacements)) {
    while (content.includes(key)) {
      content = content.replace(key, value);
    }
  }

  return content;
}

export async function writeAgentsOverlay(
  worktreePath: string,
  config: OverlayConfig,
  canonicalRoot: string,
): Promise<void> {
  const resolved = resolve(worktreePath);
  if (resolved === resolve(canonicalRoot)) {
    throw new Error("Cannot write AGENTS.md overlay to canonical root");
  }

  const content = await generateAgentsOverlay(config);
  const overlayPath = join(worktreePath, "AGENTS.md");
  await Bun.write(overlayPath, content);
}
```

**Note:** The formatting functions (`formatFileScope`, `formatMulchDomains`, etc.) need to be exported from `src/agents/overlay.ts` if they aren't already. Check and add `export` keyword to each.

**Step 4: Run tests**

Run: `bun test src/codex/overlay.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add templates/agents-overlay.md.tmpl src/codex/overlay.ts src/codex/overlay.test.ts
git commit -m "feat: add AGENTS.md overlay generator for Codex agents"
```

---

### Task 9: Create `.codex/config.toml` generator

**Files:**
- Create: `src/codex/config-gen.ts`
- Test: `src/codex/config-gen.test.ts`

**Step 1: Write the failing test**

```typescript
// src/codex/config-gen.test.ts
import { describe, test, expect } from "bun:test";
import { generateCodexConfig } from "./config-gen";

test("generates valid TOML with dangerFullAccess and on-request", () => {
  const toml = generateCodexConfig({
    model: "o3",
    approvalPolicy: "on-request",
  });
  expect(toml).toContain('model = "o3"');
  expect(toml).toContain('sandbox_policy = "dangerFullAccess"');
  expect(toml).toContain('approval_policy = "on-request"');
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/codex/config-gen.test.ts`
Expected: FAIL

**Step 3: Implement**

```typescript
// src/codex/config-gen.ts
import { join } from "node:path";

interface CodexConfigOptions {
  model: string;
  approvalPolicy: "on-request" | "unless-allowed" | "never";
}

/** Generate .codex/config.toml content */
export function generateCodexConfig(opts: CodexConfigOptions): string {
  return `# Auto-generated by overstory. Do not edit.
model = "${opts.model}"
sandbox_policy = "dangerFullAccess"
approval_policy = "${opts.approvalPolicy}"
`;
}

/** Write .codex/config.toml to a worktree */
export async function writeCodexConfig(
  worktreePath: string,
  opts: CodexConfigOptions,
): Promise<void> {
  const dir = join(worktreePath, ".codex");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, "config.toml"), generateCodexConfig(opts));
}
```

**Step 4: Run tests**

Run: `bun test src/codex/config-gen.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/codex/config-gen.ts src/codex/config-gen.test.ts
git commit -m "feat: add .codex/config.toml generator"
```

---

## Phase 7: App Server Lifecycle

### Task 10: Create app-server management and `overstory codex` CLI command

**Files:**
- Create: `src/codex/server.ts`
- Create: `src/commands/codex.ts`
- Test: `src/codex/server.test.ts`
- Modify: `src/index.ts` (add `codex` case to command router)

**Step 1: Write the failing test**

```typescript
// src/codex/server.test.ts
import { describe, test, expect } from "bun:test";
import { parseServerState, isServerAlive } from "./server";

test("parseServerState validates required fields", () => {
  const valid = { pid: 1234, port: 21816, startedAt: "2024-01-01T00:00:00Z", url: "ws://127.0.0.1:21816" };
  expect(parseServerState(JSON.stringify(valid))).toEqual(valid);
});

test("parseServerState returns null for invalid JSON", () => {
  expect(parseServerState("not json")).toBeNull();
  expect(parseServerState('{"pid":"string"}')).toBeNull();
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/codex/server.test.ts`
Expected: FAIL

**Step 3: Implement server lifecycle**

```typescript
// src/codex/server.ts
import type { CodexServerState } from "./types";
import { join } from "node:path";

const STATE_FILE = "codex-server.json";

export function getServerStatePath(overstoryDir: string): string {
  return join(overstoryDir, STATE_FILE);
}

export function parseServerState(raw: string): CodexServerState | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof parsed.pid !== "number" ||
      typeof parsed.port !== "number" ||
      typeof parsed.startedAt !== "string" ||
      typeof parsed.url !== "string"
    ) {
      return null;
    }
    return parsed as unknown as CodexServerState;
  } catch {
    return null;
  }
}

/** Check if the server process is still alive */
export function isServerAlive(state: CodexServerState): boolean {
  try {
    process.kill(state.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Read server state from .overstory/codex-server.json */
export async function readServerState(overstoryDir: string): Promise<CodexServerState | null> {
  const path = getServerStatePath(overstoryDir);
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  const raw = await file.text();
  return parseServerState(raw);
}

/** Start the shared Codex App Server */
export async function startServer(
  overstoryDir: string,
  port: number,
): Promise<CodexServerState> {
  // Check if already running
  const existing = await readServerState(overstoryDir);
  if (existing && isServerAlive(existing)) {
    return existing;
  }

  // Spawn: codex app-server --listen ws://127.0.0.1:<port>
  const url = `ws://127.0.0.1:${port}`;
  const proc = Bun.spawn(["codex", "app-server", "--listen", url], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: overstoryDir,
  });

  // Give server time to bind
  await Bun.sleep(2000);

  // Verify it's alive
  if (!proc.pid) {
    throw new Error("Failed to start Codex App Server: no PID");
  }

  const state: CodexServerState = {
    pid: proc.pid,
    port,
    startedAt: new Date().toISOString(),
    url,
  };

  await Bun.write(getServerStatePath(overstoryDir), JSON.stringify(state, null, "\t"));
  return state;
}

/** Stop the shared Codex App Server */
export async function stopServer(overstoryDir: string): Promise<boolean> {
  const state = await readServerState(overstoryDir);
  if (!state) return false;

  if (isServerAlive(state)) {
    try {
      process.kill(state.pid, "SIGTERM");
    } catch {
      // Already dead
    }
  }

  const { unlink } = await import("node:fs/promises");
  try {
    await unlink(getServerStatePath(overstoryDir));
  } catch {
    // File may not exist
  }
  return true;
}
```

Create `src/commands/codex.ts` following the existing CLI command patterns (switch on subcommand: `start`, `stop`, `status`). Reference `src/commands/coordinator.ts` for the pattern.

Add to `src/index.ts` command router:

```typescript
case "codex":
  await codexCommand(commandArgs);
  break;
```

**Step 4: Run tests**

Run: `bun test src/codex/server.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/codex/server.ts src/codex/server.test.ts src/commands/codex.ts src/index.ts
git commit -m "feat: add Codex App Server lifecycle management and CLI command"
```

---

## Phase 8: Bridge Process

### Task 11: Create the bridge adapter process

**Files:**
- Create: `src/codex/bridge.ts`
- Test: `src/codex/bridge.test.ts`

This is the largest and most complex file. It is the per-worker process that runs in tmux and mediates between overstory and the shared App Server.

**Architecture:**

```
bridge.ts (entry point, runs in tmux)
  ├── Parse BridgeConfig from CLI flags / env vars
  ├── Connect to shared app-server via RPC client
  ├── Send initialize + initialized handshake
  ├── Call thread/start (cwd=worktree, dangerFullAccess, on-request, model)
  ├── Send initial beacon via turn/start
  └── Event loop:
       ├── item/started → DeltaBuffer.start() + EventStore tool_start
       ├── item/*/outputDelta → DeltaBuffer.appendDelta()
       ├── item/completed → DeltaBuffer.flush() + EventStore tool_end + mail check
       ├── item/*/requestApproval → evaluateCommandApproval/evaluateFileChangeApproval
       │     ├── accept/decline → respond immediately
       │     └── escalate → mail to parent, wait for response, respond
       ├── turn/completed → mail check → next turn/start or shutdown
       ├── thread/tokenUsage/updated → checkpoint threshold check
       ├── contextCompaction → save checkpoint, inject recovery on next turn
       └── SIGUSR1 → immediate mail check + turn/steer if turn active
```

**Step 1: Write focused tests for bridge helpers**

The bridge itself is hard to unit test (requires app-server). Focus on testing the parseBridgeConfig, event routing, and shutdown detection:

```typescript
// src/codex/bridge.test.ts
import { describe, test, expect } from "bun:test";
import { parseBridgeConfig, shouldShutdown } from "./bridge";

test("parseBridgeConfig from env vars", () => {
  const env = {
    OVERSTORY_AGENT_NAME: "builder-1",
    OVERSTORY_WORKTREE_PATH: "/repo/.overstory/worktrees/builder-1",
    OVERSTORY_BRANCH_NAME: "overstory/builder-1/task-123",
    OVERSTORY_BEAD_ID: "task-123",
    OVERSTORY_CAPABILITY: "builder",
    OVERSTORY_PARENT_AGENT: "lead-1",
    OVERSTORY_DEPTH: "2",
    OVERSTORY_RUN_ID: "run-2024",
    OVERSTORY_SESSION_ID: "sess-1",
    OVERSTORY_CODEX_SERVER_URL: "ws://127.0.0.1:21816",
    OVERSTORY_CODEX_MODEL: "o3",
    OVERSTORY_COMPACTION_THRESHOLD: "0.8",
    OVERSTORY_MAX_DELTA_BUFFER: "1048576",
    OVERSTORY_APPROVAL_TIMEOUT: "60000",
    OVERSTORY_FILE_SCOPE: "src/foo.ts,src/bar.ts",
    OVERSTORY_PROJECT_ROOT: "/repo",
  };

  const config = parseBridgeConfig(env);
  expect(config.agentName).toBe("builder-1");
  expect(config.capability).toBe("builder");
  expect(config.fileScope).toEqual(["src/foo.ts", "src/bar.ts"]);
  expect(config.compactionThreshold).toBe(0.8);
});

test("shouldShutdown returns true for terminal turn status", () => {
  expect(shouldShutdown("completed")).toBe(true);
  expect(shouldShutdown("failed")).toBe(true);
  expect(shouldShutdown("cancelled")).toBe(true);
  expect(shouldShutdown("interrupted")).toBe(false);
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/codex/bridge.test.ts`
Expected: FAIL

**Step 3: Implement bridge**

The bridge is a standalone Bun script. Key exports for testing:

```typescript
// src/codex/bridge.ts
import type { BridgeConfig } from "./types";

/** Parse bridge config from environment variables */
export function parseBridgeConfig(
  env: Record<string, string | undefined>,
): BridgeConfig {
  return {
    agentName: env.OVERSTORY_AGENT_NAME ?? "",
    worktreePath: env.OVERSTORY_WORKTREE_PATH ?? "",
    branchName: env.OVERSTORY_BRANCH_NAME ?? "",
    beadId: env.OVERSTORY_BEAD_ID ?? "",
    capability: env.OVERSTORY_CAPABILITY ?? "builder",
    parentAgent: env.OVERSTORY_PARENT_AGENT || null,
    depth: Number(env.OVERSTORY_DEPTH ?? "0"),
    runId: env.OVERSTORY_RUN_ID || null,
    sessionId: env.OVERSTORY_SESSION_ID ?? "",
    serverUrl: env.OVERSTORY_CODEX_SERVER_URL ?? "ws://127.0.0.1:21816",
    model: env.OVERSTORY_CODEX_MODEL ?? "o3",
    compactionThreshold: Number(env.OVERSTORY_COMPACTION_THRESHOLD ?? "0.8"),
    maxDeltaBufferBytes: Number(env.OVERSTORY_MAX_DELTA_BUFFER ?? "1048576"),
    approvalTimeoutMs: Number(env.OVERSTORY_APPROVAL_TIMEOUT ?? "60000"),
    fileScope: (env.OVERSTORY_FILE_SCOPE ?? "").split(",").filter(Boolean),
    projectRoot: env.OVERSTORY_PROJECT_ROOT ?? "",
  };
}

/** Determine if a turn status means the agent is done */
export function shouldShutdown(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

// Main bridge entry point (only runs when executed directly)
// ... full event loop implementation ...
```

The full bridge event loop implementation is extensive. It should:

1. Parse config from env
2. Open EventStore, SessionStore, MetricsStore, MailClient (all from `projectRoot/.overstory/`)
3. Create RPC client connecting to `serverUrl`
4. Send `initialize` + `initialized` handshake
5. Call `thread/start` with `dangerFullAccess` + `on-request`
6. Build beacon (reuse `buildBeacon` from `src/commands/sling.ts`)
7. Send initial `turn/start` with beacon + any pending mail
8. Register notification handlers for all event types
9. Register SIGUSR1 handler for nudge wakeup
10. Run event loop until `shouldShutdown` or disconnect
11. Run shutdown sequence (session-end bookkeeping, mulch learn, close stores)

**Step 4: Run tests**

Run: `bun test src/codex/bridge.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/codex/bridge.ts src/codex/bridge.test.ts
git commit -m "feat: add Codex bridge adapter process"
```

---

## Phase 9: Sling Integration

### Task 12: Add `--runtime` flag and Codex spawn path to sling

**Files:**
- Modify: `src/commands/sling.ts`
- Test: `src/commands/sling.test.ts` (add runtime-specific tests)

**Step 1: Write the failing test**

```typescript
test("sling with --runtime codex generates AGENTS.md instead of CLAUDE.md", async () => {
  // ... setup temp dir, config, manifest ...
  // Mock tmux, beads, etc.
  // Call sling with --runtime codex
  // Assert AGENTS.md exists in worktree
  // Assert .claude/CLAUDE.md does NOT exist
  // Assert .codex/config.toml exists
  // Assert session.runtime === "codex"
});

test("sling defaults to claude runtime when codex not configured", async () => {
  // ... call sling without --runtime ...
  // Assert .claude/CLAUDE.md exists
  // Assert session.runtime === "claude"
});

test("sling with --runtime codex uses config.codex.defaultRuntime", async () => {
  // Set config.codex.defaultRuntime.builder = "codex"
  // Call sling with --capability builder (no --runtime flag)
  // Assert session.runtime === "codex"
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/commands/sling.test.ts`
Expected: FAIL

**Step 3: Modify sling.ts**

Key changes to `src/commands/sling.ts`:

1. Add `--runtime` flag parsing (after line ~70):
   ```typescript
   const runtimeFlag = getFlag(args, "--runtime") as AgentRuntime | undefined;
   ```

2. Resolve runtime from flag → config default → "claude" (after config loading):
   ```typescript
   const runtime: AgentRuntime = runtimeFlag
     ?? config.codex?.defaultRuntime?.[capability]
     ?? "claude";
   ```

3. After worktree creation (step 7), fork based on runtime:

   **Claude Code path (existing, steps 8-12):**
   ```typescript
   if (runtime === "claude") {
     await writeOverlay(worktreePath, overlayConfig, projectRoot);
     await deployHooks(worktreePath, name, capability);
     const claudeCmd = `claude --model ${agentDef.model} --dangerously-skip-permissions`;
     pid = await createSession(tmuxName, worktreePath, claudeCmd, envVars);
   }
   ```

   **Codex path (new):**
   ```typescript
   if (runtime === "codex") {
     await writeAgentsOverlay(worktreePath, overlayConfig, projectRoot);
     await writeCodexConfig(worktreePath, { model: config.codex.model, approvalPolicy: "on-request" });
     const serverState = await ensureServerRunning(overstoryDir, config.codex.serverPort);
     const bridgeCmd = `bun run ${resolve(import.meta.dir, "../codex/bridge.ts")}`;
     pid = await createSession(tmuxName, worktreePath, bridgeCmd, {
       ...envVars,
       OVERSTORY_CODEX_SERVER_URL: serverState.url,
       OVERSTORY_CODEX_MODEL: config.codex.model,
       OVERSTORY_COMPACTION_THRESHOLD: String(config.codex.compactionThreshold),
       OVERSTORY_MAX_DELTA_BUFFER: String(config.codex.maxDeltaBufferBytes),
       OVERSTORY_APPROVAL_TIMEOUT: String(config.codex.approvalTimeoutMs),
       OVERSTORY_FILE_SCOPE: overlayConfig.fileScope.join(","),
       OVERSTORY_PROJECT_ROOT: projectRoot,
       OVERSTORY_BRANCH_NAME: branchName,
       OVERSTORY_BEAD_ID: beadId,
       OVERSTORY_CAPABILITY: capability,
       OVERSTORY_PARENT_AGENT: parentAgent ?? "",
       OVERSTORY_DEPTH: String(depth),
       OVERSTORY_SESSION_ID: sessionId,
       OVERSTORY_RUN_ID: runId ?? "",
     });
   }
   ```

4. Add `runtime` to the session record:
   ```typescript
   const session: AgentSession = {
     // ... existing fields ...
     runtime,
   };
   ```

5. For Codex, skip the beacon send via tmux (bridge handles its own beacon):
   ```typescript
   if (runtime === "claude") {
     await Bun.sleep(3000);
     await sendKeys(tmuxName, beacon);
     await Bun.sleep(500);
     await sendKeys(tmuxName, "");
   }
   // Codex bridge sends its own beacon via turn/start
   ```

**Step 4: Run tests**

Run: `bun test src/commands/sling.test.ts`
Expected: PASS

**Step 5: Run full quality gates**

Run: `bun test && bun run lint && bun run typecheck`
Expected: PASS

**Step 6: Commit**

```bash
git add src/commands/sling.ts src/commands/sling.test.ts
git commit -m "feat: add --runtime flag to sling with Codex spawn path"
```

---

## Phase 10: Nudge, Inspect, Status Updates

### Task 13: Add runtime-aware nudge transport

**Files:**
- Modify: `src/commands/nudge.ts`
- Test: `src/commands/nudge.test.ts`

**Step 1: Write the failing test**

```typescript
test("nudgeAgent uses mail + SIGUSR1 for codex runtime", async () => {
  // Setup: create session with runtime: "codex" and a known PID
  // Call nudgeAgent()
  // Assert: mail was sent with --priority high
  // Assert: SIGUSR1 was sent to PID
  // (mock process.kill to verify)
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/commands/nudge.test.ts`
Expected: FAIL

**Step 3: Modify nudge.ts**

Update `resolveTargetSession()` to return runtime and bridgePid:

```typescript
interface ResolvedTarget {
  tmuxSession: string;
  runtime: AgentRuntime;
  bridgePid: number | null;
}
```

Update `nudgeAgent()` to branch on runtime:

```typescript
if (target.runtime === "codex") {
  // Send high-priority mail
  const mailClient = createMailClient(openMailStore(overstoryDir));
  mailClient.send({
    from: "orchestrator",
    to: agentName,
    subject: "nudge",
    body: message,
    type: "status",
    priority: "high",
  });
  // Wake bridge via SIGUSR1
  if (target.bridgePid) {
    try { process.kill(target.bridgePid, "SIGUSR1"); } catch { /* dead */ }
  }
  mailClient.close();
  return { delivered: true };
} else {
  // Existing tmux send-keys path
  return sendNudgeWithRetry(target.tmuxSession, message);
}
```

**Step 4: Run tests**

Run: `bun test src/commands/nudge.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/commands/nudge.ts src/commands/nudge.test.ts
git commit -m "feat: add runtime-aware nudge transport (mail+SIGUSR1 for Codex)"
```

---

### Task 14: Auto-skip tmux capture-pane for Codex in inspect

**Files:**
- Modify: `src/commands/inspect.ts`

**Step 1: Identify the change**

In `gatherInspectData()` (around line 243), the tmux capture-pane logic should auto-skip when the session runtime is "codex":

```typescript
let tmuxOutput: string | null = null;
if (!opts.noTmux && session.tmuxSession && session.runtime !== "codex") {
  const lines = opts.tmuxLines ?? 30;
  tmuxOutput = await captureTmux(session.tmuxSession, lines);
}
```

This is a one-line change. No new test needed — the existing `--no-tmux` test covers the skip path.

**Step 2: Make the change**

Add `&& session.runtime !== "codex"` to the tmux capture condition.

**Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add src/commands/inspect.ts
git commit -m "fix: auto-skip tmux capture-pane for Codex agents in inspect"
```

---

### Task 15: Add runtime column to status display

**Files:**
- Modify: `src/commands/status.ts`

**Step 1: Identify the change**

In `printStatus()` (around line 221), add runtime to the agent display line:

```typescript
// Before:
// {marker} {name} [{capability}] {state} | {beadId} | {duration}
// After:
// {marker} {name} [{capability}/{runtime}] {state} | {beadId} | {duration}
const runtimeTag = agent.runtime === "codex" ? "/codex" : "";
const line = `  ${marker} ${agent.agentName} [${agent.capability}${runtimeTag}] ...`;
```

Only show the tag for codex agents (claude is default, no need to clutter).

**Step 2: Make the change and test visually**

Run: `bun run typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add src/commands/status.ts
git commit -m "feat: show runtime tag in status display for Codex agents"
```

---

## Phase 11: Doctor Check & Command Router

### Task 16: Add `codex` category to doctor

**Files:**
- Modify: `src/commands/doctor.ts` (or create `src/doctor/codex.ts`)

**Step 1: Write the failing test**

```typescript
test("codex doctor check reports codex not installed", async () => {
  // Run doctor with codex category
  // If codex CLI not in PATH, expect warn
});

test("codex doctor check reports server status", async () => {
  // If codex-server.json exists but PID dead, expect fail
});
```

**Step 2: Implement codex health check**

Create a new check function following the doctor pattern:

```typescript
async function checkCodex(
  config: OverstoryConfig,
  overstoryDir: string,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  // Check if codex CLI is installed
  const proc = Bun.spawn(["which", "codex"], { stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  checks.push({
    status: exitCode === 0 ? "pass" : "warn",
    message: exitCode === 0 ? "codex CLI found in PATH" : "codex CLI not found in PATH",
    category: "codex",
  });

  // Check server state if codex enabled
  if (config.codex.enabled) {
    const state = await readServerState(overstoryDir);
    if (state) {
      const alive = isServerAlive(state);
      checks.push({
        status: alive ? "pass" : "fail",
        message: alive
          ? `Codex App Server running (PID ${state.pid}, port ${state.port})`
          : `Codex App Server dead (PID ${state.pid} not responding)`,
        category: "codex",
      });
    } else {
      checks.push({
        status: "warn",
        message: "Codex enabled but App Server not started",
        category: "codex",
      });
    }
  }

  return checks;
}
```

Register in `ALL_CHECKS` array:

```typescript
{ category: "codex", fn: checkCodex },
```

Update the `DoctorCategory` type to include `"codex"`.

**Step 3: Run tests**

Run: `bun test src/commands/doctor.test.ts`
Expected: PASS (new check runs but may warn if codex not installed)

**Step 4: Commit**

```bash
git add src/commands/doctor.ts
git commit -m "feat: add codex health check category to doctor"
```

---

### Task 17: Add `codex` to command router and shell completions

**Files:**
- Modify: `src/index.ts`
- Modify: `src/commands/completions.ts`

**Step 1: Add to command router**

In `src/index.ts`, add the `codex` case (if not done in Task 10):

```typescript
case "codex":
  await codexCommand(commandArgs);
  break;
```

**Step 2: Add to completions**

In `src/commands/completions.ts`, add `"codex"` to the `COMMANDS` array.

**Step 3: Run tests**

Run: `bun test src/commands/completions.test.ts`
Expected: PASS (completions test should verify the new command)

**Step 4: Commit**

```bash
git add src/index.ts src/commands/completions.ts
git commit -m "feat: register codex command in router and shell completions"
```

---

## Phase 12: Integration Testing

### Task 18: End-to-end integration test for Codex spawn path

**Files:**
- Create: `src/codex/integration.test.ts`

This test validates the full sling → bridge → EventStore pipeline using mocks for the App Server WebSocket:

```typescript
// src/codex/integration.test.ts
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("codex integration", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  test("parseBridgeConfig → approval → event normalization pipeline", async () => {
    // 1. Parse config from env vars
    // 2. Evaluate a safe command → accept
    // 3. Evaluate a dangerous command → decline
    // 4. Create delta buffer, accumulate, flush
    // 5. Normalize to EventStore format
    // 6. Verify normalized event has correct fields
  });

  test("AGENTS.md overlay generated correctly for builder", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "overstory-codex-test-"));
    // Generate overlay
    // Verify content includes agent name, file scope, constraints
    // Verify no Claude Code references
  });
});
```

**Step 1: Write the integration test**

Focus on testing the pipeline of modules working together, without a real App Server.

**Step 2: Run test**

Run: `bun test src/codex/integration.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add src/codex/integration.test.ts
git commit -m "test: add integration tests for Codex spawn pipeline"
```

---

## Phase 13: Final Quality Gates

### Task 19: Run full quality gates and fix any issues

**Step 1: Run all tests**

Run: `bun test`
Expected: All tests pass

**Step 2: Run linter**

Run: `bun run lint`
Expected: Zero errors. Fix any biome issues with `bun run biome check --write .`

**Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: Zero errors

**Step 4: Commit any fixes**

```bash
git add -A
git commit -m "chore: fix lint and type errors from codex integration"
```

---

## File Inventory Summary

### New Files (12)

| File | Purpose |
|------|---------|
| `src/codex/types.ts` | All Codex App Server protocol types |
| `src/codex/types.test.ts` | Type-level compilation tests |
| `src/codex/approval.ts` | Approval gateway (command + file change evaluation) |
| `src/codex/approval.test.ts` | Approval gateway unit tests |
| `src/codex/rpc-client.ts` | JSON-RPC 2.0 WebSocket client |
| `src/codex/rpc-client.test.ts` | RPC client tests with mock WebSocket server |
| `src/codex/events.ts` | Event normalization + delta buffer manager |
| `src/codex/events.test.ts` | Normalization and delta buffer tests |
| `src/codex/overlay.ts` | AGENTS.md overlay generator |
| `src/codex/overlay.test.ts` | Overlay generation tests |
| `src/codex/config-gen.ts` | .codex/config.toml generator |
| `src/codex/config-gen.test.ts` | Config generation tests |
| `src/codex/server.ts` | App Server lifecycle (start/stop/status) |
| `src/codex/server.test.ts` | Server lifecycle tests |
| `src/codex/bridge.ts` | Per-worker bridge adapter process |
| `src/codex/bridge.test.ts` | Bridge helper tests |
| `src/codex/integration.test.ts` | End-to-end pipeline integration tests |
| `src/commands/codex.ts` | `overstory codex server start/stop/status` CLI |
| `templates/agents-overlay.md.tmpl` | AGENTS.md overlay template |

### Modified Files (8)

| File | Change |
|------|--------|
| `src/types.ts` | Add `AgentRuntime`, `CodexConfig`, `runtime` field to `AgentSession` |
| `src/config.ts` | Add `codex` section to DEFAULT_CONFIG and validation |
| `src/sessions/store.ts` | Add `runtime` column with migration |
| `src/commands/sling.ts` | Add `--runtime` flag, Codex spawn path |
| `src/commands/nudge.ts` | Runtime-aware nudge (mail+SIGUSR1 for Codex) |
| `src/commands/inspect.ts` | Auto-skip tmux capture for Codex agents |
| `src/commands/status.ts` | Show runtime tag for Codex agents |
| `src/commands/doctor.ts` | Add `codex` health check category |
| `src/index.ts` | Register `codex` command |
| `src/commands/completions.ts` | Add `codex` to completions |
| `src/agents/overlay.ts` | Export formatting helper functions for reuse |

### Unchanged Files (17+)

EventStore, MetricsStore, MailStore, dashboard, trace, replay, errors, feed, costs, metrics, merge queue, merge resolver, watchdog daemon, watchdog triage, mail broadcast, beads client, mulch client — all runtime-agnostic by design.

---

## Dependency Graph

```
Phase 1: types.ts, config.ts, sessions/store.ts
  │
  ▼
Phase 2: codex/types.ts
  │
  ├──────────────────┬────────────────┐
  ▼                  ▼                ▼
Phase 3:         Phase 4:        Phase 5:
approval.ts      rpc-client.ts   events.ts
  │                  │                │
  │    Phase 6:      │                │
  │    overlay.ts    │                │
  │    config-gen.ts │                │
  │         │        │                │
  ├─────────┼────────┤                │
  │         ▼        │                │
  │    Phase 7:      │                │
  │    server.ts     │                │
  │    codex.ts      │                │
  │         │        │                │
  ├─────────┼────────┼────────────────┤
  ▼         ▼        ▼                ▼
Phase 8: bridge.ts (depends on ALL above)
  │
  ▼
Phase 9: sling.ts (depends on bridge, overlay, config-gen, server)
  │
  ├──────────────────┐
  ▼                  ▼
Phase 10:        Phase 11:
nudge, inspect,  doctor, completions
status
  │                  │
  ├──────────────────┤
  ▼
Phase 12: Integration tests
  │
  ▼
Phase 13: Final quality gates
```

Tasks within the same phase can be parallelized. Tasks across phases must be sequential (earlier phases provide dependencies for later ones).
