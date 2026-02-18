# Codex App Server / Claude Code Hook Mappings

Comprehensive mapping of every Claude Code hook, event, guard, and lifecycle mechanism used by overstory to its Codex App Server equivalent. This document establishes that full functional parity is achievable through a bridge adapter that translates between the two execution backends, normalizing internal events so the rest of overstory operates identically regardless of which runtime powers a given agent.

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Hook-Level Mappings](#hook-level-mappings)
3. [Guard Mappings (PreToolUse)](#guard-mappings-pretooluse)
4. [Event Stream Mappings (PostToolUse)](#event-stream-mappings-posttooluse)
5. [Approval Gateway](#approval-gateway)
6. [Compaction Strategy](#compaction-strategy)
7. [Instruction Injection](#instruction-injection)
8. [Process Lifecycle](#process-lifecycle)
9. [Observability Surface](#observability-surface)
10. [Tool Name Normalization](#tool-name-normalization)
11. [Sandbox Parity](#sandbox-parity)
12. [Event Normalization Layer](#event-normalization-layer)
13. [Gap Assessment Summary](#gap-assessment-summary)
14. [Design Decisions](#design-decisions)

---

## Architecture Overview

Overstory currently spawns Claude Code agents in tmux sessions and governs them through two mechanisms:

1. **Hooks** (`.claude/settings.local.json`) -- lifecycle callbacks that run shell commands on events like SessionStart, PreToolUse, PostToolUse, Stop, etc.
2. **CLAUDE.md overlay** -- per-agent instruction files that define the agent's assignment, file scope, constraints, and workflow.

The Codex integration replaces both mechanisms with a single **bridge adapter process** that communicates with a shared Codex App Server via JSON-RPC 2.0 over WebSocket. The bridge implements the same governance logic (guards, logging, mail routing, compaction handling) in TypeScript rather than bash scripts, and normalizes all events into overstory's existing internal format so that SessionStore, EventStore, MetricsStore, mail, watchdog, dashboard, and all other subsystems work identically.

```
Claude Code Path (existing):
  tmux session → claude --dangerously-skip-permissions
    ├── .claude/settings.local.json (hooks)
    │     ├── SessionStart → overstory prime
    │     ├── UserPromptSubmit → overstory mail check --inject
    │     ├── PreToolUse → guards (path boundary, capability, danger)
    │     ├── PostToolUse → overstory log tool-end + mail check
    │     ├── Stop → overstory log session-end + mulch learn
    │     └── PreCompact → overstory prime --compact
    └── .claude/CLAUDE.md (overlay)

Codex Path (new):
  tmux session → bun run src/codex/bridge.ts
    ├── WebSocket → shared codex app-server
    │     ├── thread/start → creates sandboxed thread
    │     ├── turn/start → sends prompt (with pre-turn mail injection)
    │     ├── requestApproval → approval gateway (TypeScript guards)
    │     ├── item/* events → event normalization → EventStore
    │     ├── turn/completed → post-turn mail check + session bookkeeping
    │     ├── thread/tokenUsage/updated → compaction threshold monitoring
    │     └── contextCompaction → checkpoint recovery injection
    └── AGENTS.md (overlay, equivalent to CLAUDE.md)
```

Both paths produce identical normalized events in EventStore, identical session records in SessionStore, and identical mail traffic. The rest of overstory (dashboard, status, inspect, trace, replay, errors, feed, merge, watchdog, costs, metrics) operates without modification.

---

## Hook-Level Mappings

### SessionStart

| Aspect | Claude Code | Codex App Server |
|--------|-------------|-------------------|
| **Trigger** | Claude Code fires `SessionStart` hook when TUI initializes | Bridge receives `thread/started` notification after `thread/start` RPC |
| **Overstory action** | Runs `overstory prime --agent <name>` which outputs identity, activation context, and expertise to stdout for context injection | Bridge performs equivalent logic inline: loads identity from `.overstory/agents/{name}/identity.yaml`, reads checkpoint if resuming, loads bound task from SessionStore |
| **Context delivery** | Hook stdout is injected into Claude Code's conversation context | Static context is in the AGENTS.md overlay (always loaded by Codex). Dynamic context (identity, activation) is included in the initial `turn/start` prompt |
| **Side effects** | Auto-heals `.overstory/.gitignore`, registers orchestrator tmux session | Bridge performs the same side effects at startup |
| **Parity** | **Full.** AGENTS.md carries the static assignment context that CLAUDE.md overlay carries for Claude Code. Dynamic priming is injected via the initial turn prompt. The bridge can run the same `loadIdentity()`, `loadCheckpoint()`, and `openSessionStore()` calls that `prime.ts` uses. |

### UserPromptSubmit

| Aspect | Claude Code | Codex App Server |
|--------|-------------|-------------------|
| **Trigger** | Claude Code fires `UserPromptSubmit` before each user message is processed | Bridge controls when `turn/start` is called -- it IS the user prompt submission |
| **Overstory action** | Runs `overstory mail check --inject --agent <name>` which checks the agent's inbox and prints unread messages to stdout for context injection | Bridge calls the same mail check logic (via `MailClient.check()`) before each `turn/start`. Unread messages are prepended to the turn input |
| **Timing** | Hook runs after user submits but before the model processes | Bridge checks mail, then calls `turn/start` with mail content prepended. Deterministic ordering -- mail is always checked before the model sees the prompt |
| **Mid-turn injection** | Not possible -- hooks only fire between tool calls, not during model reasoning | For urgent/high-priority mail (from watchdog, parent escalation), bridge uses `turn/steer` to inject content mid-turn without waiting for the current turn to complete. Normal-priority mail continues to use between-turn `turn/start` injection |
| **Parity** | **Full (stronger).** With Claude Code, the hook runs on a best-effort basis and the timing relative to model processing is hook-implementation-dependent. With the bridge, the sequence is deterministic: mail check always completes before `turn/start` is sent. The bridge is the host -- it controls the exact moment the model receives input. Additionally, `turn/steer` enables mid-turn injection for urgent messages -- a capability that does not exist in Claude Code. |

### PreToolUse

| Aspect | Claude Code | Codex App Server |
|--------|-------------|-------------------|
| **Trigger** | Claude Code fires `PreToolUse` before each tool invocation, passing `{tool_name, tool_input, session_id, ...}` as JSON on stdin | App Server sends `item/commandExecution/requestApproval` for shell commands and `item/fileChange/requestApproval` for file modifications as JSON-RPC requests |
| **Blocking** | Hook can return `{"decision":"block","reason":"..."}` to prevent tool execution | Bridge responds to the JSON-RPC request with `decline` (+ reason) to prevent execution, or `accept`/`acceptForSession` to allow |
| **Overstory action** | Runs multiple guard scripts (path boundary, danger, capability, bash file guard) implemented as bash one-liners with `sed`, `grep`, pattern matching | Bridge runs equivalent guard logic implemented in TypeScript with full access to overstory's config, manifest, and session state |
| **Guard granularity** | Matchers target specific tool names (`Write`, `Edit`, `Bash`, `NotebookEdit`) | Two approval types: `commandExecution` (covers all shell commands) and `fileChange` (covers all file modifications). See [Guard Mappings](#guard-mappings-pretooluse) for detailed per-guard mapping |
| **Parity** | **Full (stronger).** See detailed guard mapping below. Every current PreToolUse guard maps to an equivalent approval gateway check. The TypeScript implementation is more robust than bash/sed pattern matching and has access to richer request context (structured JSON vs. stdin parsing). |

### PostToolUse

| Aspect | Claude Code | Codex App Server |
|--------|-------------|-------------------|
| **Trigger** | Claude Code fires `PostToolUse` after each tool completes, passing tool result JSON on stdin | App Server emits `item/completed` notification for each completed item, plus streaming deltas (`item/commandExecution/outputDelta`, `item/fileChange/outputDelta`) during execution |
| **Overstory action (logging)** | Runs `overstory log tool-end --agent <name> --stdin` which parses the tool result, records to EventStore, and captures token snapshots | Bridge receives structured `item/completed` events with typed item data (command, exit code, output, file paths, changes). Normalizes and writes to EventStore using the same schema |
| **Overstory action (mail)** | Runs `overstory mail check --inject --agent <name> --debounce <ms>` at two intervals (500ms fast, 30000ms slow) | Bridge implements equivalent debounced mail checks after relevant `item/completed` events. Two-tier debounce logic replicated in the bridge's event loop |
| **Data richness** | Hook receives raw JSON from Claude Code's tool result format. Tool args must be parsed from the PreToolUse stdin (separate hook invocation) | `item/completed` includes the full item with command text, exit code, output, file paths, change kinds, and status -- all in one structured notification. `item/started` provides the equivalent of PreToolUse logging |
| **Parity** | **Full (richer).** The App Server's event stream provides more structured data than Claude Code's hook stdin. Tool start and end are correlated by item ID rather than heuristic matching. Output is streamed via deltas rather than captured only at completion. |

### Stop

| Aspect | Claude Code | Codex App Server |
|--------|-------------|-------------------|
| **Trigger** | Claude Code fires `Stop` when the session ends (user exits, `/exit` command, or process termination) | Bridge observes `turn/completed` with status `completed`/`failed`/`interrupted`, or detects app-server disconnection, or receives shutdown signal |
| **Overstory action** | Runs `overstory log session-end --agent <name> --stdin` which: transitions session state to completed, increments identity.sessionsCompleted, records metrics, runs `mulch learn` for auto-expertise, records EventStore entry, auto-nudges coordinator if agent is a lead, completes run if agent is coordinator, clears session marker | Bridge performs the same shutdown sequence by calling the same underlying functions: `SessionStore.upsert()`, `updateIdentity()`, `MetricsStore.recordSession()`, `mulchClient.learn()`, `EventStore.insert()` |
| **mulch learn** | Run as a subprocess via `Bun.spawn(["mulch", "learn"])` | Bridge runs the same subprocess call |
| **Parity** | **Full.** The bridge has access to all the same stores and clients. The shutdown sequence is identical -- only the trigger mechanism differs. |

### PreCompact

| Aspect | Claude Code | Codex App Server |
|--------|-------------|-------------------|
| **Trigger** | Claude Code fires `PreCompact` just before context compaction begins | No direct pre-compaction hook exists in Codex. Bridge monitors `thread/tokenUsage/updated` notifications to detect approaching compaction, and observes `contextCompaction` item lifecycle events when compaction occurs |
| **Overstory action** | Runs `overstory prime --agent <name> --compact` which injects: (1) agent identity, (2) activation context (bound task ID), (3) checkpoint recovery (progress summary, files modified, pending work, current branch). Skips expertise to save tokens | Bridge implements a two-phase strategy: **Phase 1 (pre-compaction checkpoint):** when token usage crosses a configurable threshold (default 80%), save checkpoint from accumulated event history. **Phase 2 (post-compaction recovery):** when `contextCompaction` event fires, load checkpoint and inject recovery context via next `turn/start` |
| **Static context survival** | CLAUDE.md is part of conversation context and may be partially summarized during compaction | AGENTS.md is loaded as a system-level instruction file by Codex, separate from conversation history. It survives compaction intact |
| **Dynamic context** | Checkpoint recovery section is injected before compaction so it becomes part of the compacted context | Checkpoint is saved before compaction (at threshold), then injected as fresh context after compaction. This means the recovery content is guaranteed to be in the live context window, not subject to compaction summarization |
| **Parity** | **Full (superior).** Three advantages: (1) AGENTS.md persists through compaction automatically (CLAUDE.md may be summarized). (2) The bridge builds checkpoints from structured event data (richer than agent-saved checkpoints). (3) Post-compaction injection guarantees the recovery context is fully present, whereas Claude Code's PreCompact injection is itself subject to compaction pressure. Additionally, the bridge can trigger `thread/compact/start` proactively at controlled moments rather than waiting for auto-compaction to interrupt mid-task. |

---

## Guard Mappings (PreToolUse)

Every PreToolUse guard currently deployed by `src/agents/hooks-deployer.ts` maps to an equivalent check in the Codex bridge's approval gateway.

### Path Boundary Guards

**Claude Code implementation:** `buildPathBoundaryGuardScript()` in `hooks-deployer.ts`. Registered as PreToolUse hooks for `Write`, `Edit`, `NotebookEdit`. Reads JSON from stdin, extracts `file_path`/`notebook_path` via sed, checks if the path starts with `$OVERSTORY_WORKTREE_PATH`.

**Codex mapping:**

| Layer | Mechanism | Coverage |
|-------|-----------|----------|
| **Sandbox** | `dangerFullAccess` -- no OS-level filesystem restrictions, matching Claude Code's `--dangerously-skip-permissions` model | Sandbox is permissive. Enforcement is handled entirely by the approval gateway |
| **Approval gateway** | `item/fileChange/requestApproval` handler validates `changes[].path` against worktree boundary. `item/commandExecution/requestApproval` validates file-modifying commands against worktree path | Sole enforcement layer. Declines any file change or command targeting paths outside the worktree |

**Parity: Full.** The approval gateway performs the same path validation as Claude Code's bash guards. Both runtimes use the same enforcement model: no OS sandbox, with a programmatic gateway as the sole enforcement layer. The TypeScript approval gateway is more robust than bash `sed`/`grep` pattern matching (structured JSON input, proper error handling).

### Danger Guards

**Claude Code implementation:** `buildBashGuardScript()` in `hooks-deployer.ts`. Registered as PreToolUse hook for `Bash`. Extracts command via sed, checks three patterns:

| Pattern | Block reason |
|---------|-------------|
| `git push` | Agents must never push to remote |
| `git reset --hard` | Destroys uncommitted work |
| `git checkout -b` with wrong naming | Branch must follow `overstory/{agentName}/{bead-id}` convention |

**Codex mapping:**

| Guard | Codex mechanism | How |
|-------|----------------|-----|
| `git push` block | Approval gateway | Pattern-matches `git push` and declines. Same enforcement model as Claude Code's bash grep. |
| `git reset --hard` block | Approval gateway | Pattern-matches `git reset --hard` and declines. |
| Branch naming convention | Approval gateway | Inspects `git checkout -b` commands and validates the branch name matches `overstory/{agentName}/{beadId}` pattern. Same regex, TypeScript instead of bash. |

**Parity: Full.** Same enforcement model (programmatic gateway as sole enforcement). TypeScript implementation is more robust than bash grep for pattern matching.

### Capability Guards (Non-Implementation)

**Claude Code implementation:** `getCapabilityGuards()` in `hooks-deployer.ts`. For non-implementation capabilities (scout, reviewer, lead, coordinator, supervisor, monitor):
- Blocks `Write`, `Edit`, `NotebookEdit` tools entirely via PreToolUse `{"decision":"block"}`
- Blocks file-modifying bash commands via `buildBashFileGuardScript()` which matches 30+ dangerous patterns (sed -i, echo >, mv, rm, mkdir, etc.) against a safe-prefix whitelist

**Codex mapping:**

| Guard | Codex mechanism |
|-------|----------------|
| Block Write/Edit/NotebookEdit | Approval gateway declines all `item/fileChange/requestApproval` requests for non-implementation capabilities. Same logic as Claude Code's PreToolUse `{"decision":"block"}` for Write/Edit/NotebookEdit |
| Block file-modifying bash | Approval gateway applies the same safe-prefix whitelist and dangerous-pattern blocklist from `hooks-deployer.ts`. Commands matching `FILE_MODIFY_PATTERNS` (sed -i, echo >, mv, rm, mkdir, touch, chmod, etc.) are declined unless they match a safe prefix |
| Coordination capabilities (coordinator, supervisor) get `git add`/`git commit` whitelisted | Approval gateway auto-approves `git add` and `git commit` for coordination capabilities while declining other file-modifying commands. Same whitelist as `COORDINATION_CAPABILITIES` in hooks-deployer |

**Parity: Full.** Same enforcement model as Claude Code. Both runtimes rely on a programmatic gateway (bash guards for CC, TypeScript approval gateway for Codex) to block write operations for non-implementation agents. The TypeScript implementation is more robust (structured JSON vs. sed/grep on stdin) and more testable.

### Capability Guards (Implementation)

**Claude Code implementation:** For implementation capabilities (builder, merger):
- Write/Edit tools are allowed (no PreToolUse block)
- `buildBashPathBoundaryScript()` checks file-modifying bash commands for absolute paths outside the worktree
- Known limitations: variable expansion, cd + relative, subshells

**Codex mapping:**

| Guard | Codex mechanism |
|-------|----------------|
| Allow file writes within worktree | Approval gateway auto-approves `item/fileChange/requestApproval` when all `changes[].path` values are within the worktree path AND within the agent's file scope |
| Bash path boundary | Approval gateway inspects file-modifying commands for target paths, validates they resolve to within the worktree. Same validation as `buildBashPathBoundaryScript()` but with structured JSON input instead of sed extraction |
| File scope (specific files within worktree) | `item/fileChange/requestApproval` handler validates `changes[].path` against the agent's file scope list. Auto-declines changes to files outside scope |

**Parity: Full.** Same enforcement model -- approval gateway validates paths just as Claude Code's bash guards do. The TypeScript implementation handles structured JSON input rather than parsing stdin with sed, providing the same coverage with better error handling.

### Native Team Tool Guards

**Claude Code implementation:** Blocks Claude Code's native team/task tools (`Task`, `TeamCreate`, `TeamDelete`, `SendMessage`, `TaskCreate`, `TaskUpdate`, `TaskList`, `TaskGet`, `TaskOutput`, `TaskStop`) to force agents to use `overstory sling` for delegation.

**Codex mapping:** Not applicable. Codex does not have these tools. There is nothing to block.

**Parity: N/A.** The guard exists to prevent agents from bypassing overstory's orchestration. Codex agents cannot bypass overstory because they have no native orchestration tools -- all coordination goes through the bridge.

---

## Event Stream Mappings (PostToolUse)

The bridge normalizes Codex App Server events into overstory's existing EventStore schema.

### Tool Start Events

| Claude Code | Codex App Server | Normalized |
|-------------|-------------------|------------|
| PreToolUse hook fires → `overstory log tool-start` receives `{tool_name, tool_input}` on stdin | `item/started` notification with item type and initial data | EventStore `tool_start` event with `tool_name` (normalized), `tool_args` (filtered), `agent_name`, `session_id`, `run_id` |

### Tool End Events

| Claude Code | Codex App Server | Normalized |
|-------------|-------------------|------------|
| PostToolUse hook fires → `overstory log tool-end` receives `{tool_name, tool_result}` on stdin | `item/completed` notification with final item state (command, exit_code, output, file changes, status) | EventStore `tool_end` event with `tool_name` (normalized), `tool_duration_ms` (calculated from start/end), `tool_args`, `data` (output summary) |

### Session End Events

| Claude Code | Codex App Server | Normalized |
|-------------|-------------------|------------|
| Stop hook fires → `overstory log session-end` | `turn/completed` with terminal status, or app-server disconnect, or bridge shutdown | EventStore `session_end` event with final metrics |

### Streaming Data (Codex-Only Enhancement)

The App Server provides granular streaming data that has no Claude Code equivalent:

| Event | Data | Use |
|-------|------|-----|
| `item/commandExecution/outputDelta` | Streaming stdout/stderr from shell commands | Real-time command output for dashboard/inspect without tmux capture-pane |
| `item/fileChange/outputDelta` | Streaming file change patches | Real-time diff visibility |
| `item/agentMessage/delta` | Streaming agent text | Real-time agent reasoning visibility |
| `item/reasoning/summaryTextDelta` | Streaming reasoning summaries | Insight into agent decision-making |
| `turn/diff/updated` | Aggregated unified diff across all file changes in a turn | Turn-level diff snapshot |
| `turn/plan/updated` | Agent's step-by-step plan with per-step status | Plan visibility (not available in Claude Code) |
| `thread/tokenUsage/updated` | Real-time token consumption | Cost tracking and compaction threshold monitoring |

These events are logged to EventStore as additional event types when available, enhancing observability for Codex workers without affecting Claude Code workers.

### Delta Buffering (PostToolUse Parity)

**Critical design element.** Claude Code's PostToolUse hook fires once per tool completion with the full tool result. The Codex App Server streams output incrementally via `outputDelta` events during execution, then sends `item/completed` when done. To achieve PostToolUse parity, the bridge maintains a per-item delta buffer:

```typescript
interface DeltaBuffer {
  itemId: string;
  itemType: "commandExecution" | "fileChange" | "mcpToolCall";
  startedAt: string;         // ISO 8601 from item/started
  outputChunks: string[];    // Accumulated outputDelta text
  totalBytes: number;        // Running output size
}

// Bridge state
const activeBuffers = new Map<string, DeltaBuffer>();
```

**Lifecycle:**

1. **`item/started`** → Create new `DeltaBuffer`, record `itemId`, `itemType`, `startedAt`. Write `tool_start` event to EventStore.
2. **`item/*/outputDelta`** → Append delta text to `outputChunks`, increment `totalBytes`. No EventStore write (buffering).
3. **`item/completed`** → Flush buffer:
   - Calculate `tool_duration_ms` from `startedAt` to now
   - Join `outputChunks` into final output (truncated if > max size)
   - Write `tool_end` event to EventStore with full tool data
   - Trigger debounced mail check (same as PostToolUse hook behavior)
   - Delete buffer from `activeBuffers`
4. **Buffer overflow protection** → If `totalBytes` exceeds configurable max (default 1MB), stop accumulating and mark as truncated. Prevents memory issues from long-running commands with verbose output.

This produces identical `tool_end` events in EventStore regardless of whether the source was a Claude Code PostToolUse hook or a Codex bridge buffer flush. All downstream consumers (dashboard, inspect, trace, replay, feed) see the same data.

---

## Approval Gateway

The approval gateway is the bridge's TypeScript implementation of the guard logic currently implemented as bash scripts in `hooks-deployer.ts`. It receives `requestApproval` JSON-RPC requests from the App Server and returns structured decisions.

### Decision Flow

```
requestApproval received
  │
  ├─ commandExecution approval:
  │    │
  │    ├─ command matches SAFE_PREFIXES?
  │    │    (overstory, bd, git status/log/diff/show/blame/branch,
  │    │     mulch, bun test/lint/typecheck/biome)
  │    │    → accept
  │    │
  │    ├─ command matches DANGER_PATTERNS?
  │    │    (git push, git reset --hard, git checkout -b with wrong naming,
  │    │     npm install, bun install/add, runtime eval flags)
  │    │    → decline with reason
  │    │
  │    ├─ non-implementation capability + command matches FILE_MODIFY_PATTERNS?
  │    │    (sed -i, echo >, mv, rm, mkdir, touch, chmod, etc.)
  │    │    → decline with reason
  │    │
  │    ├─ coordination capability + command is git add/commit?
  │    │    → accept (whitelisted for beads/mulch sync)
  │    │
  │    └─ unknown/ambiguous command?
  │         → escalate to parent agent via mail
  │         → await parent response or timeout
  │         → accept/decline based on parent's answer
  │
  └─ fileChange approval:
       │
       ├─ non-implementation capability?
       │    → decline (sole enforcement -- matches CC's PreToolUse block
       │       for Write/Edit/NotebookEdit on non-impl agents)
       │
       ├─ changes[].path all within file scope?
       │    → accept
       │
       ├─ changes[].path outside file scope but within worktree?
       │    → escalate to parent agent via mail
       │
       └─ changes[].path outside worktree?
            → decline (sole enforcement -- matches CC's path
               boundary guard)
```

### Response Types

| Response | Meaning | When used |
|----------|---------|-----------|
| `accept` | Allow this specific invocation | Known-safe commands, in-scope file changes |
| `acceptForSession` | Allow this and all future similar invocations | Repeated safe patterns (e.g., after first `bun test` approval, auto-approve all subsequent) |
| `decline` | Block this invocation with reason | Dangerous patterns, out-of-scope changes |
| `cancel` | Cancel the entire turn | Unrecoverable policy violation |
| `acceptWithExecpolicyAmendment` | Accept and modify execution policy | Adjusting sandbox for specific commands |

### Escalation Protocol

When a command is ambiguous (not in safe or danger lists), the bridge:

1. Sends a `question` mail to the parent agent: `"Approval needed: agent {name} wants to run: {command}. Accept or decline?"`
2. Waits for parent response with a configurable timeout (default: 60s)
3. If parent approves → `accept` (or `acceptForSession` if parent says "always allow")
4. If parent declines → `decline` with parent's reason
5. If timeout → `decline` with reason "approval timeout"

This matches the user's chosen approval mode: "auto-approve safe, auto-decline dangerous, escalate unknown."

### Comparison with Claude Code Guards

| Aspect | Claude Code (bash) | Codex bridge (TypeScript) |
|--------|-------------------|---------------------------|
| Pattern matching | `grep -qE` with regex fragments | TypeScript regex or exact string matching |
| JSON parsing | `sed` extraction of fields from stdin JSON | Structured JSON-RPC params with typed fields |
| Config access | Environment variables only (`$OVERSTORY_AGENT_NAME`, `$OVERSTORY_WORKTREE_PATH`) | Full access to overstory config, manifest, session state, file scope lists |
| Error handling | Silent failures (guard exits 0 on parse errors, allowing the action) | TypeScript try/catch with explicit error-to-decline fallback |
| Testability | Difficult to unit test bash one-liners | Standard TypeScript unit tests with typed inputs/outputs |
| Session-level learning | Not possible -- every invocation is independent | `acceptForSession` eliminates repeated approval overhead for safe patterns |

---

## Compaction Strategy

### Claude Code Approach

1. Context approaches limit → Claude Code auto-triggers compaction
2. `PreCompact` hook fires → runs `overstory prime --agent <name> --compact`
3. Compact prime outputs: identity + activation + checkpoint recovery (progress, files modified, pending work, branch)
4. This output is injected into context *before* compaction
5. Compacted context includes (a summarized version of) the recovery payload

**Limitations:**
- The recovery payload is itself subject to compaction summarization
- Checkpoint data depends on what the agent previously saved (may be stale)
- No control over compaction timing

### Codex Bridge Approach

**Phase 1: Threshold Monitoring**
1. Bridge receives `thread/tokenUsage/updated` notifications with current token counts
2. Bridge knows the model's context window size (from `model/list` at initialization)
3. When usage ratio crosses configurable threshold (default 80%), bridge saves checkpoint:
   - Builds progress summary from accumulated `item/completed` events
   - Lists files modified from `item/fileChange` events
   - Captures last agent message from `item/agentMessage` events
   - Saves to `.overstory/agents/{name}/checkpoint.json`
4. Optionally triggers `thread/compact/start` proactively (configurable)

**Phase 2: Post-Compaction Recovery**
1. Bridge observes `contextCompaction` item in event stream
2. Loads saved checkpoint from Phase 1
3. On next `turn/start`, prepends recovery context:
   ```
   [CONTEXT RECOVERY] Your conversation was compacted.
   Progress: {checkpoint.progressSummary}
   Files modified: {checkpoint.filesModified}
   Pending work: {checkpoint.pendingWork}
   Branch: {checkpoint.currentBranch}
   Continue working on task {beadId}.
   ```

**Advantages over Claude Code:**
1. AGENTS.md survives compaction intact (system-level instruction, not conversation history)
2. Checkpoint built from structured event data, not agent self-reporting
3. Recovery context injected *after* compaction, guaranteed to be in live context window
4. Optional proactive compaction at controlled moments

---

## Instruction Injection

### CLAUDE.md vs AGENTS.md

| Aspect | Claude Code | Codex |
|--------|-------------|-------|
| **File name** | `.claude/CLAUDE.md` | `AGENTS.md` (project root or subdirectory) |
| **Override file** | None | `AGENTS.override.md` takes precedence |
| **Cascading** | Walks directories | Walks from git root to CWD, concatenating |
| **Global instructions** | `~/.claude/CLAUDE.md` | `~/.codex/AGENTS.md` |
| **Context survival** | Part of conversation history, subject to compaction | System-level instruction, survives compaction intact |
| **Size limit** | No documented limit | `project_doc_max_bytes` (default 32 KiB) |
| **Fallback** | None | `project_doc_fallback_filenames` config key (can include `CLAUDE.md`) |

### Overlay Generation

The existing `src/agents/overlay.ts` generates CLAUDE.md overlays from `templates/overlay.md.tmpl`. The Codex path generates an equivalent AGENTS.md overlay from a parallel template (`templates/agents-overlay.md.tmpl`). Content is identical -- same sections:

- Base agent definition (builder.md, scout.md, etc.)
- Assignment (agent name, task ID, spec path, branch, worktree, parent, depth)
- File scope
- Quality gates
- Communication instructions
- Constraints

The only differences are:
- Tool name references (shell_tool/apply_patch instead of Bash/Read/Write/Edit)
- Runtime-specific instructions (no `--dangerously-skip-permissions`, no `.claude/` references)
- Communication examples adjusted for Codex context

### Additional Instruction Channels

Codex provides additional instruction injection mechanisms not available in Claude Code:

| Mechanism | Purpose | Overstory use |
|-----------|---------|---------------|
| `developer_instructions` config key | Injected as developer-role message | Could carry short constraint reminders |
| `.codex/config.toml` in worktree | Project-level config with sandbox/approval settings | Auto-generated by bridge for each worktree |
| `turn/start` input | Per-turn prompt text | Mail injection, recovery context, beacon prompt |

---

## Process Lifecycle

### Claude Code Agent Lifecycle

```
overstory sling --runtime claude
  1. Create worktree
  2. Generate CLAUDE.md overlay
  3. Deploy hooks (settings.local.json)
  4. Create tmux session: claude --model <m> --dangerously-skip-permissions
  5. Record session in SessionStore
  6. Sleep 3s (TUI init)
  7. Send beacon via tmux send-keys
  8. Agent works autonomously (hooks govern behavior)
  9. Agent exits → Stop hook fires → session-end bookkeeping
```

### Codex Agent Lifecycle

```
overstory sling --runtime codex
  1. Create worktree
  2. Generate AGENTS.md overlay
  3. Generate .codex/config.toml in worktree
  4. Ensure shared app-server is running (start if needed)
  5. Create tmux session: bun run src/codex/bridge.ts <flags>
  6. Record session in SessionStore
  7. Bridge connects to app-server via WebSocket
  8. Bridge sends initialize + initialized handshake
  9. Bridge calls thread/start (cwd=worktree, sandbox, approval, model)
  10. Bridge sends beacon via turn/start (equivalent to tmux send-keys)
  11. Bridge event loop:
      a. item/* events → log to EventStore
      b. requestApproval → approval gateway
      c. turn/completed → mail check → next turn/start or shutdown
      d. tokenUsage/updated → compaction threshold check
      e. contextCompaction → recovery injection
  12. Bridge detects completion → session-end bookkeeping
  13. Bridge exits → tmux session closes
```

### Shared App Server Lifecycle

```
overstory codex server start
  1. Check if already running (.overstory/codex-server.json)
  2. Spawn: codex app-server --listen ws://127.0.0.1:<port>
  3. Write PID + port to .overstory/codex-server.json
  4. Verify WebSocket is accepting connections

overstory codex server stop
  1. Read .overstory/codex-server.json
  2. Kill process
  3. Remove codex-server.json

overstory codex server status
  1. Read .overstory/codex-server.json
  2. Check if PID is alive
  3. Check if WebSocket is accepting
  4. Report thread count, uptime
```

### Process Monitoring

The watchdog monitors Codex agents the same way it monitors Claude Code agents:

| Check | Claude Code | Codex |
|-------|-------------|-------|
| Process alive | `tmux has-session -t <name>` | Same -- bridge runs in tmux |
| Activity detection | `lastActivity` updated by PostToolUse hook | `lastActivity` updated by bridge on each `item/completed` |
| Stall detection | `staleThresholdMs` since last `lastActivity` | Same threshold, same mechanism |
| Nudge | `tmux send-keys` to Claude Code TUI | Runtime-aware: mail with `--priority high` + SIGUSR1 to bridge PID (wakes bridge event loop to process mail immediately). If a turn is active, bridge uses `turn/steer` to inject the nudge content mid-turn. Between turns, bridge injects via next `turn/start` |
| Kill | `killProcessTree()` on tmux session | Same -- killing the bridge tmux session terminates the bridge, which disconnects from app-server (thread becomes idle) |

### Runtime-Aware Nudge Transport

The `nudge.ts` command currently hardcodes `tmux send-keys` for message delivery. With dual-runtime support, `resolveTargetSession()` must also return the runtime type and (for Codex) the bridge PID:

```
nudgeAgent(agentName, message)
  │
  ├─ resolveTargetSession(agentName) → { tmuxSession, runtime, bridgePid? }
  │
  ├─ runtime === "claude"?
  │    → tmux send-keys -t <tmuxSession> "<message>" Enter
  │    (existing behavior, unchanged)
  │
  └─ runtime === "codex"?
       → overstory mail send --to <agentName> --subject "nudge" \
           --body "<message>" --type status --priority high
       → kill -SIGUSR1 <bridgePid>  (wake bridge event loop)
```

The bridge registers a SIGUSR1 handler at startup that triggers an immediate mail check + `turn/steer` injection if a turn is active. This gives nudges the same immediacy as `tmux send-keys` without depending on tmux's text input mechanism.

---

## Observability Surface

All overstory observability tools work identically for both runtimes because events are normalized before reaching the stores.

### EventStore

| Event type | Claude Code source | Codex source | Normalized schema |
|-----------|-------------------|-------------|-------------------|
| `tool_start` | PreToolUse hook stdin | `item/started` notification | `{agent_name, tool_name, tool_args, run_id, session_id, created_at}` |
| `tool_end` | PostToolUse hook stdin | `item/completed` notification | `{agent_name, tool_name, tool_args, tool_duration_ms, data, run_id, session_id, created_at}` |
| `session_end` | Stop hook | Bridge shutdown | `{agent_name, data: {transcript_path}, run_id, session_id, created_at}` |
| `mail_sent` | Mail client | Mail client (same) | `{agent_name, data: {to, subject, type}, run_id, session_id, created_at}` |
| `approval` | N/A (new) | Approval gateway | `{agent_name, data: {command, decision, reason}, run_id, session_id, created_at}` |
| `compaction` | N/A (new) | `contextCompaction` event | `{agent_name, data: {tokens_before, tokens_after}, run_id, session_id, created_at}` |

### SessionStore

Identical schema. The `AgentSession` record is created by sling (same for both runtimes) and updated by the bridge (Codex) or hooks (Claude Code).

### MetricsStore

| Metric | Claude Code source | Codex source |
|--------|-------------------|-------------|
| Token usage | Parsed from transcript JSONL (`~/.claude/projects/{key}/{session}.jsonl`) | `thread/tokenUsage/updated` events (structured, real-time) |
| Session duration | `startedAt` to Stop hook timestamp | `startedAt` to bridge shutdown timestamp |
| Tool counts | Aggregated from EventStore | Same |
| Cost estimation | Calculated from token counts + model pricing | Same (model pricing lookup may differ for OpenAI models) |

### Dashboard / Status / Inspect / Trace / Replay / Feed

All these commands read from EventStore, SessionStore, and MetricsStore. Since events are normalized at the bridge layer, these commands produce consistent output regardless of runtime. The only visible difference is tool names (normalized -- see [Tool Name Normalization](#tool-name-normalization)).

---

## Tool Name Normalization

Codex and Claude Code use different tool names for equivalent operations. The bridge normalizes Codex tool names to overstory's canonical names before writing to EventStore.

| Canonical (overstory) | Claude Code | Codex App Server |
|----------------------|-------------|-------------------|
| `Bash` | `Bash` tool | `commandExecution` item type (shell_tool) |
| `Write` | `Write` tool | `fileChange` item with `kind: "add"` |
| `Edit` | `Edit` tool | `fileChange` item with `kind: "update"` (apply_patch) |
| `Read` | `Read` tool | `commandExecution` running `cat`/`head`/`less` (or Codex's internal file read) |
| `Glob` | `Glob` tool | `commandExecution` running `find`/`ls`/`fd` |
| `Grep` | `Grep` tool | `commandExecution` running `grep`/`rg` |
| `WebSearch` | `WebSearch` tool | `webSearch` item type |
| `McpToolCall` | MCP tool calls | `mcpToolCall` item type |
| `FileDelete` | N/A | `fileChange` item with `kind: "delete"` |

The normalization layer maps Codex item types to canonical tool names so that EventStore queries, tool stats, and dashboard displays are consistent.

---

## Sandbox Parity

### Design Principle: Approval Gateway as Sole Enforcement

Claude Code runs with `--dangerously-skip-permissions` -- there is no OS-level sandbox. All enforcement is through PreToolUse hooks (bash guard scripts). The Codex integration mirrors this exactly:

- **All capabilities** use `dangerFullAccess` sandbox (no OS-level restrictions)
- **All capabilities** use `approvalPolicy: "on-request"` (approval gateway decides every action)
- The **approval gateway** (`src/codex/approval.ts`) is the sole enforcement layer, replicating all PreToolUse guard logic in TypeScript

This is a deliberate design choice. All agent capabilities (scout, builder, coordinator, etc.) run CLI commands (`bd close`, `overstory mail send`, `mulch record`) that write to infrastructure directories at the canonical repo root (`.beads/`, `.overstory/`, `.mulch/`). A restrictive OS sandbox (e.g., `readOnly` or `workspaceWrite`) would block these commands at the kernel level, breaking core agent workflows. Since Claude Code has no OS sandbox, the Codex path does not add one.

### Per-Capability Approval Configuration

All capabilities share the same sandbox (`dangerFullAccess`) and approval policy (`on-request`). The differentiation happens entirely in the approval gateway's decision logic:

| Capability | Approval gateway behavior |
|-----------|---------------------------|
| **scout** | Declines Write/Edit/file-modifying bash. Auto-approves read-only commands, `overstory` CLI, `bd`, `mulch`. One exception: `overstory spec write` is allowed (the only write scouts perform) |
| **reviewer** | Same as scout, without the `spec write` exception |
| **builder** | Auto-approves file changes within file scope and worktree. Declines changes outside scope. Declines dangerous patterns (`git push`, `git reset --hard`, etc.) |
| **merger** | Same as builder |
| **lead** | Declines Write/Edit/file-modifying bash. Auto-approves read-only commands, `overstory sling` (for spawning sub-workers), `overstory` CLI, `bd`, `mulch` |
| **coordinator** | Declines Write/Edit/file-modifying bash except `git add`/`git commit` (whitelisted for beads/mulch sync). Auto-approves `overstory` CLI, `bd`, `mulch` |
| **supervisor** | Same as coordinator |
| **monitor** | Same as coordinator |

### Parity Summary

| Aspect | Claude Code | Codex |
|--------|-------------|-------|
| **OS sandbox** | None (`--dangerously-skip-permissions`) | None (`dangerFullAccess`) |
| **Enforcement layer** | PreToolUse bash guard scripts | Approval gateway (TypeScript) |
| **Write blocking** | `sed`/`grep` pattern matching on tool JSON | Structured JSON-RPC request inspection |
| **Path validation** | Bash regex on extracted `file_path` | TypeScript path comparison on `changes[].path` |
| **Infrastructure writes** | Allowed (no sandbox blocks CLI tools) | Allowed (no sandbox blocks CLI tools) |

### Protected Paths

| Path | Claude Code | Codex |
|------|-------------|-------|
| `.git/` | Not specifically protected (relies on agent instructions) | Not specifically protected (relies on approval gateway + agent instructions) |
| `.claude/` | Not specifically protected | N/A |
| `.codex/` | N/A | Not specifically protected (Codex protects `.codex/` internally) |
| `.overstory/` | Not specifically protected (worktree isolation prevents access since `.overstory/` is at canonical root, not in worktrees) | Same -- worktrees don't contain `.overstory/` |

---

## Event Normalization Layer

The bridge implements an event normalization layer that translates Codex App Server events into overstory's internal event format. This layer is the key to non-invasive integration -- the rest of overstory never needs to know which runtime powered a given agent.

### Normalization Contract

```typescript
interface NormalizedEvent {
  runId: string;
  agentName: string;
  sessionId: string;
  eventType: "tool_start" | "tool_end" | "session_end" | "mail_sent" | "approval" | "compaction" | "custom";
  toolName: string | null;    // Canonical tool name (see normalization table)
  toolArgs: string | null;    // Filtered args (same filtering as tool-filter.ts)
  toolDurationMs: number | null;
  level: "info" | "warn" | "error";
  data: Record<string, unknown> | null;
  createdAt: string;          // ISO 8601
}
```

### Normalization Functions

| Codex event | Normalized to | Key transformations |
|-------------|--------------|---------------------|
| `item/started` (commandExecution) | `tool_start` with `toolName: "Bash"` | Extract `command` field, apply `tool-filter.ts` equivalent |
| `item/started` (fileChange) | `tool_start` with `toolName: "Edit"` or `"Write"` | Map `kind` to canonical name |
| `item/completed` (commandExecution) | `tool_end` with `toolName: "Bash"` | Calculate duration from start event, capture exit code |
| `item/completed` (fileChange) | `tool_end` with `toolName: "Edit"` or `"Write"` | Capture changed paths |
| `item/completed` (mcpToolCall) | `tool_end` with `toolName: "McpToolCall"` | Capture server_name, tool_name, result summary |
| `item/completed` (webSearch) | `tool_end` with `toolName: "WebSearch"` | Capture query |
| `turn/completed` (terminal) | `session_end` | Capture final status, error if failed |
| Approval decision | `approval` (new event type) | Capture command/path, decision, reason |
| `contextCompaction` | `compaction` (new event type) | Capture token counts if available |

### Integration Points

The normalization layer writes to the same stores via the same APIs:

```
Codex event stream
  → Bridge event loop
    → Normalization layer (src/codex/events.ts)
      → EventStore.insert() (same as overstory log tool-end)
      → SessionStore.upsert() (same as updateLastActivity)
      → MetricsStore.recordTokenSnapshot() (same as token snapshot in log.ts)
      → MailClient.check() (same as mail debounce in PostToolUse hook)
```

No changes required to EventStore, SessionStore, MetricsStore, MailStore, or any query commands (trace, replay, errors, feed, costs, metrics, dashboard, inspect, status).

---

## Gap Assessment Summary

| Capability | Claude Code | Codex App Server | Parity |
|-----------|-------------|-------------------|--------|
| Pre-execution tool blocking | PreToolUse hook returns `{"decision":"block"}` | `requestApproval` responds with `decline` | **Full** |
| Post-execution event logging | PostToolUse hook captures tool result | `item/completed` event with structured data | **Full (richer)** |
| Session startup priming | SessionStart hook runs `overstory prime` | AGENTS.md overlay + initial `turn/start` prompt | **Full** |
| Pre-turn mail injection | UserPromptSubmit hook runs `overstory mail check --inject` | Bridge checks mail before calling `turn/start` | **Full (deterministic)** |
| Post-turn mail check | PostToolUse hook with debounce | Bridge checks mail after `item/completed` with debounce | **Full** |
| Session end bookkeeping | Stop hook runs `overstory log session-end` + `mulch learn` | Bridge runs same bookkeeping on `turn/completed` or disconnect | **Full** |
| Context compaction recovery | PreCompact hook injects compact prime | Token threshold monitoring + post-compaction recovery injection | **Full (superior)** |
| Worktree path isolation | Bash path boundary guards (known bypasses) | Approval gateway path validation (structured JSON) | **Full** |
| File scope enforcement | Bash path checking + overlay instructions | Approval gateway path checking + AGENTS.md instructions | **Full** |
| Git push prevention | Bash grep for `git push` | Approval gateway pattern match | **Full** |
| Dangerous command blocking | Bash grep for 30+ patterns | Approval gateway pattern match | **Full** |
| Non-implementation write block | PreToolUse blocks Write/Edit tools | Approval gateway declines Write/Edit for non-impl capabilities | **Full** |
| Native team tool blocking | PreToolUse blocks Task/TeamCreate/etc | N/A -- tools don't exist in Codex | **N/A** |
| Branch naming enforcement | Bash regex on `git checkout -b` | Approval gateway regex | **Full** |
| Streaming command output | Not available (only captured at completion) | `item/commandExecution/outputDelta` | **Codex-only enhancement** |
| Agent plan visibility | Not available | `turn/plan/updated` | **Codex-only enhancement** |
| Real-time token tracking | Parsed from transcript JSONL (periodic, 30s throttle) | `thread/tokenUsage/updated` (real-time) | **Codex-only enhancement** |
| Turn-level unified diff | Not available | `turn/diff/updated` | **Codex-only enhancement** |
| Mid-turn steering | Not possible | `turn/steer` for urgent mail injection and watchdog nudges | **Codex-only enhancement** |
| Proactive compaction control | Not possible (auto-compaction only) | `thread/compact/start` | **Codex-only enhancement** |
| Delta buffering for PostToolUse parity | Captured only at tool completion | Per-item `DeltaBuffer` flushed on `item/completed` | **Full (richer)** |

**Conclusion:** Zero functional gaps. Every overstory capability supported by Claude Code hooks is achievable through the Codex App Server protocol. Both runtimes use the same enforcement model: no OS sandbox, with a programmatic gateway (PreToolUse hooks for Claude Code, approval gateway for Codex) as the sole enforcement layer. Several capabilities are richer in the Codex path (structured approvals, real-time token tracking, delta buffering). New capabilities become available exclusively through the Codex path (plan visibility, mid-turn steering, proactive compaction).

---

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Execution model | App Server protocol (JSON-RPC 2.0) | Richest control surface. Approval workflow replaces PreToolUse. Event stream replaces PostToolUse. Thread lifecycle replaces session management |
| Process model | Hybrid: shared app-server, per-worker bridge | Resource efficiency of shared server. Failure isolation of per-worker bridges. Each bridge owns one thread on the shared server |
| Transport | WebSocket (`codex app-server --listen ws://...`) | Enables multiple bridge connections to one server. Port stored in `.overstory/codex-server.json` |
| Dispatch strategy | Config-driven defaults with `--runtime` sling override | `config.yaml` maps capabilities to default runtimes. Coordinator/lead can override per-task via `--runtime codex\|claude` |
| Approval mode | Auto-approve safe, auto-decline dangerous, escalate unknown to parent | Matches existing guard behavior. Escalation adds a safety net for novel commands without blocking known-safe patterns |
| Instruction file | AGENTS.md overlay (parallel to CLAUDE.md overlay) | Same content structure, adapted for Codex tool names and runtime context. Generated by `src/codex/overlay.ts` |
| Compaction strategy | Token threshold monitoring + post-compaction recovery | Superior to PreCompact: richer checkpoint data, guaranteed context survival, optional proactive compaction control |
| Event normalization | Bridge-side normalization before store writes | Keeps all downstream systems (EventStore, MetricsStore, dashboard, trace, etc.) runtime-agnostic. No changes to query commands |
| Sandbox model | `dangerFullAccess` + `approvalPolicy: "on-request"` for ALL capabilities | Matches Claude Code's `--dangerously-skip-permissions` model exactly. Approval gateway is sole enforcement layer. All agents run CLI commands (`bd`, `overstory`, `mulch`) that write to infrastructure dirs at canonical root -- OS sandbox would break these |
| Nudge transport | Runtime-aware: tmux send-keys (CC) / mail + SIGUSR1 (Codex) | Each runtime uses its native input mechanism. Bridge SIGUSR1 handler gives nudges the same immediacy as tmux text input |
| Mid-turn mail injection | `turn/steer` for urgent/high-priority messages (Codex-only) | Normal mail injected between turns via `turn/start`. Urgent mail injected mid-turn via `turn/steer`. Not possible in Claude Code (enhancement) |
| Delta buffering | Per-item `DeltaBuffer` flushed on `item/completed` | Produces identical EventStore `tool_end` events regardless of runtime. Prevents memory issues with 1MB overflow protection |
| Thread fork/rollback | Excluded from scope | Available in App Server protocol but not integrated. Can be added later if use cases emerge |
| Dependencies | Zero new npm dependencies | JSON-RPC 2.0 over WebSocket uses Bun built-in `WebSocket`. JSONL parsing is trivial. Maintains overstory's zero-runtime-deps rule |
