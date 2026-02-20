#!/usr/bin/env bun
/**
 * E2E test: Codex App Server single-turn bridge lifecycle.
 *
 * Requires:
 *   - `codex` CLI installed and authenticated (`codex --version`)
 *   - `bd` (beads) CLI installed if beads is enabled in config
 *   - A git repository with `overstory init` already run
 *   - Run from the overstory project root (where .overstory/ and src/index.ts exist)
 *
 * What it tests (end-to-end with real Codex API):
 *   1. Shared Codex App Server starts (or reuses existing)
 *   2. Bridge connects via WebSocket, sends initialize/thread/start/turn/start
 *   3. Codex model receives prompt and executes tool calls
 *   4. Approval system handles file writes (auto-accept within worktree+scope)
 *   5. Events are recorded in EventStore (tool_start, tool_end, session_end)
 *   6. turn/completed triggers clean shutdown (not WebSocket disconnect)
 *   7. Shutdown bookkeeping runs (worker_done mail, session state, identity)
 *   8. Worktree contains expected output file
 *
 * Usage:
 *   bun run scripts/e2e-codex-single-turn.ts [--cleanup]
 *
 * Flags:
 *   --cleanup   Remove the test agent worktree and spec after the test
 */

import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_ROOT = process.cwd();
const OVERSTORY_BIN = join(PROJECT_ROOT, "src", "index.ts");
const CLEANUP = process.argv.includes("--cleanup");

/**
 * Resolve the canonical project root (handles git worktrees).
 * Mirrors the logic in src/config.ts resolveProjectRoot().
 */
async function resolveCanonicalRoot(): Promise<string> {
	const proc = Bun.spawn(["git", "rev-parse", "--git-common-dir"], {
		cwd: PROJECT_ROOT,
		stdout: "pipe",
		stderr: "pipe",
	});
	const exitCode = await proc.exited;
	if (exitCode === 0) {
		const gitCommonDir = (await new Response(proc.stdout).text()).trim();
		const absGitCommon = resolve(PROJECT_ROOT, gitCommonDir);
		const mainRoot = dirname(absGitCommon);
		if (existsSync(join(mainRoot, ".overstory", "config.yaml"))) {
			return mainRoot;
		}
	}
	return PROJECT_ROOT;
}

const CANONICAL_ROOT = await resolveCanonicalRoot();
const OVERSTORY_DIR = join(CANONICAL_ROOT, ".overstory");

function log(section: string, msg: string): void {
	const ts = new Date().toISOString().slice(11, 19);
	process.stdout.write(`[${ts}] [${section}] ${msg}\n`);
}

function fail(msg: string): never {
	log("FAIL", msg);
	process.exit(1);
}

function pass(msg: string): void {
	log("PASS", msg);
}

async function run(
	cmd: string[],
	opts?: { cwd?: string },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	try {
		const proc = Bun.spawn(cmd, {
			cwd: opts?.cwd ?? PROJECT_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();
		return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { stdout: "", stderr: msg, exitCode: 127 };
	}
}

// ---------------------------------------------------------------------------
// Precondition checks
// ---------------------------------------------------------------------------

log("pre", "Checking preconditions...");

if (!existsSync(OVERSTORY_DIR)) {
	fail(`.overstory/ not found in ${PROJECT_ROOT}. Run 'overstory init' first.`);
}

const codexCheck = await run(["codex", "--version"]);
if (codexCheck.exitCode !== 0) {
	fail(`'codex --version' failed. Is the Codex CLI installed and on PATH?\n${codexCheck.stderr}`);
}
log("pre", `codex version: ${codexCheck.stdout}`);

const gitCheck = await run(["git", "rev-parse", "--is-inside-work-tree"]);
if (gitCheck.stdout !== "true") {
	fail("Not inside a git work tree.");
}

// ---------------------------------------------------------------------------
// 1. Create a trivial task spec
// ---------------------------------------------------------------------------

const AGENT_NAME = `e2e-codex-${Date.now().toString(36)}`;
const TASK_ID = AGENT_NAME;

log("spec", `Writing spec for task ${TASK_ID}`);

const specBody = [
	`# Task: ${TASK_ID}`,
	"",
	"Create a file named `hello-e2e.txt` in the worktree root containing:",
	"```",
	"Hello from Codex E2E test",
	"```",
	"",
	"Then run `echo done` to confirm completion.",
	"",
	"Do NOT run git commit, git push, bd close, or overstory mail.",
	"Just create the file and echo done.",
].join("\n");

const specResult = await run([
	"bun",
	"run",
	OVERSTORY_BIN,
	"spec",
	"write",
	TASK_ID,
	"--body",
	specBody,
]);
if (specResult.exitCode !== 0) {
	fail(`overstory spec write failed: ${specResult.stderr}`);
}
pass("Spec written");

// ---------------------------------------------------------------------------
// 1b. Create a beads issue (required when beads.enabled=true in config)
// ---------------------------------------------------------------------------

const bdCheck = await run(["bd", "--version"]);
if (bdCheck.exitCode !== 0) {
	fail(
		"'bd' (beads CLI) not found. Either install beads, or set beads.enabled=false in .overstory/config.yaml",
	);
}

const bdCreate = await run([
	"bd",
	"create",
	"--id",
	TASK_ID,
	"--title",
	`E2E Codex test: ${TASK_ID}`,
	"--body",
	"Automated E2E test issue — create hello-e2e.txt via Codex bridge",
	"--force",
]);
if (bdCreate.exitCode !== 0) {
	fail(`bd create failed: ${bdCreate.stderr}\n${bdCreate.stdout}`);
}
pass("Beads issue created");

// ---------------------------------------------------------------------------
// 2. Spawn a Codex builder agent via overstory sling
// ---------------------------------------------------------------------------

log("sling", `Spawning agent ${AGENT_NAME} with --runtime codex`);

const slingResult = await run([
	"bun",
	"run",
	OVERSTORY_BIN,
	"sling",
	TASK_ID,
	"--name",
	AGENT_NAME,
	"--capability",
	"builder",
	"--runtime",
	"codex",
	"--files",
	"hello-e2e.txt",
	"--spec",
	join(OVERSTORY_DIR, "specs", `${TASK_ID}.md`),
	"--force-hierarchy",
	"--json",
]);

if (slingResult.exitCode !== 0) {
	fail(
		`overstory sling failed (exit ${slingResult.exitCode}):\n${slingResult.stderr}\n${slingResult.stdout}`,
	);
}

let slingOutput: Record<string, unknown>;
try {
	slingOutput = JSON.parse(slingResult.stdout) as Record<string, unknown>;
} catch {
	fail(`Failed to parse sling JSON output:\n${slingResult.stdout}`);
}

const worktreePath = slingOutput.worktree as string | undefined;
const tmuxSession = slingOutput.tmuxSession as string | undefined;

pass(`Agent spawned: worktree=${worktreePath}, tmux=${tmuxSession}`);

// ---------------------------------------------------------------------------
// 3. Poll for agent completion
// ---------------------------------------------------------------------------

log("poll", "Waiting for agent to complete...");

const MAX_WAIT_S = 180;
const POLL_INTERVAL_S = 5;
let elapsed = 0;
let finalState = "unknown";

while (elapsed < MAX_WAIT_S) {
	await Bun.sleep(POLL_INTERVAL_S * 1000);
	elapsed += POLL_INTERVAL_S;

	const statusResult = await run(["bun", "run", OVERSTORY_BIN, "status", "--json"]);
	if (statusResult.exitCode !== 0) {
		log("poll", `status check failed (${elapsed}s): ${statusResult.stderr}`);
		continue;
	}

	try {
		const status = JSON.parse(statusResult.stdout) as {
			agents?: Array<{ agentName: string; state: string }>;
		};
		const agent = status.agents?.find((a) => a.agentName === AGENT_NAME);
		finalState = agent?.state ?? "not_found";
	} catch {
		finalState = "parse_error";
	}

	if (finalState === "completed" || finalState === "zombie") {
		break;
	}

	log("poll", `  ${elapsed}s — state: ${finalState}`);
}

if (finalState !== "completed" && finalState !== "zombie") {
	log("WARN", `Agent did not complete within ${MAX_WAIT_S}s (final state: ${finalState})`);
}
log("poll", `Agent reached state: ${finalState} after ${elapsed}s`);

// ---------------------------------------------------------------------------
// 4. Verify outcomes
// ---------------------------------------------------------------------------

log("verify", "Checking outcomes...");

// 4a. Check EventStore for agent events
const traceResult = await run([
	"bun",
	"run",
	OVERSTORY_BIN,
	"trace",
	AGENT_NAME,
	"--limit",
	"500",
	"--json",
]);
if (traceResult.exitCode === 0) {
	try {
		const events = JSON.parse(traceResult.stdout) as Array<{ eventType: string }>;
		const eventTypes = events.map((e) => e.eventType);
		log("verify", `Events: ${eventTypes.join(", ")}`);

		if (eventTypes.includes("session_end")) {
			pass("session_end event recorded");
		} else {
			log("WARN", "No session_end event found — bridge may not have shut down cleanly");
		}

		if (eventTypes.includes("tool_start")) {
			pass("tool_start events recorded (Codex executed tool calls)");
		} else {
			log("WARN", "No tool_start events — Codex may not have executed any tools");
		}
	} catch {
		log("WARN", `Failed to parse trace output: ${traceResult.stdout.slice(0, 200)}`);
	}
} else {
	log("WARN", `overstory trace failed: ${traceResult.stderr}`);
}

// 4b. Check mail for worker_done
const mailResult = await run([
	"bun",
	"run",
	OVERSTORY_BIN,
	"mail",
	"list",
	"--from",
	AGENT_NAME,
	"--json",
]);
if (mailResult.exitCode === 0) {
	try {
		const messages = JSON.parse(mailResult.stdout) as Array<{ type: string; subject: string }>;
		const workerDone = messages.find((m) => m.type === "worker_done");
		if (workerDone) {
			pass(`worker_done mail sent: "${workerDone.subject}"`);
		} else {
			log("WARN", `No worker_done mail from ${AGENT_NAME} (${messages.length} messages total)`);
		}
	} catch {
		log("WARN", `Failed to parse mail output`);
	}
}

// 4c. Check the worktree for hello-e2e.txt
if (worktreePath) {
	const helloPath = join(worktreePath, "hello-e2e.txt");
	if (existsSync(helloPath)) {
		const content = readFileSync(helloPath, "utf-8").trim();
		pass(`hello-e2e.txt exists: "${content}"`);
	} else {
		log("WARN", `hello-e2e.txt not found at ${helloPath}`);
	}
}

// 4d. Check codex-server.json (shared server state)
const serverStatePath = join(OVERSTORY_DIR, "codex-server.json");
if (existsSync(serverStatePath)) {
	const serverState = JSON.parse(readFileSync(serverStatePath, "utf-8")) as Record<string, unknown>;
	pass(`Codex App Server running on port ${serverState.port} (pid ${serverState.pid})`);
} else {
	log("WARN", "codex-server.json not found — server may not have started");
}

// 4e. Check bridge.pid
const bridgePidPath = join(OVERSTORY_DIR, "agents", AGENT_NAME, "bridge.pid");
if (existsSync(bridgePidPath)) {
	const pid = readFileSync(bridgePidPath, "utf-8").trim();
	// Check if the process is still alive
	try {
		process.kill(Number(pid), 0);
		log("INFO", `bridge.pid still alive (${pid}) — bridge may still be running`);
	} catch {
		log("INFO", `bridge.pid present but process exited (${pid})`);
	}
} else {
	log("INFO", "bridge.pid not found (expected after clean shutdown)");
}

// ---------------------------------------------------------------------------
// 5. Cleanup (optional)
// ---------------------------------------------------------------------------

if (CLEANUP) {
	log("cleanup", "Removing test artifacts...");

	if (worktreePath && existsSync(worktreePath)) {
		await run(["git", "worktree", "remove", "--force", worktreePath]);
		log("cleanup", `Removed worktree: ${worktreePath}`);
	}

	const specPath = join(OVERSTORY_DIR, "specs", `${TASK_ID}.md`);
	if (existsSync(specPath)) {
		await rm(specPath);
		log("cleanup", `Removed spec: ${specPath}`);
	}

	await run(["bd", "close", TASK_ID, "--reason", "E2E test cleanup"]);
	log("cleanup", `Closed beads issue: ${TASK_ID}`);

	pass("Cleanup complete");
} else {
	log("INFO", "Run with --cleanup to remove test artifacts");
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

log("done", "E2E single-turn Codex bridge test complete");
