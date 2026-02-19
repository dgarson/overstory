/**
 * CLI command: overstory mcp start|stop|status
 *
 * Manages the MCP server lifecycle. The MCP server exposes overstory tools
 * (send_message, check_messages, advance_task, etc.) as MCP tools that
 * Claude Code agents can call directly instead of using CLI commands.
 *
 * Unlike coordinator/supervisor, the MCP server:
 * - Has no tmux session (runs as a detached background process)
 * - Serves all agents in the project via HTTP
 * - State is persisted to .overstory/mcp-server.json
 */

import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { isServerAlive, readServerState } from "../mcp/state.ts";

const DEFAULT_MCP_PORT = 21817;

/**
 * Start the MCP server.
 *
 * 1. Load config, find overstoryDir
 * 2. Read state file — if server is alive, print info and return
 * 3. Spawn `bun src/mcp/server.ts` as detached process from the project root
 * 4. Poll for the state file to appear (retry up to 10 times, 500ms each)
 * 5. Print server info
 */
async function startMcp(args: string[]): Promise<void> {
	const json = args.includes("--json");
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const projectRoot = config.project.root;
	const overstoryDir = join(projectRoot, ".overstory");

	// Check if already running
	const existing = await readServerState(overstoryDir);
	if (existing && isServerAlive(existing)) {
		if (json) {
			process.stdout.write(
				`${JSON.stringify({ running: true, pid: existing.pid, port: existing.port, url: existing.url })}\n`,
			);
		} else {
			process.stdout.write(
				`MCP server already running on port ${existing.port} (pid ${existing.pid})\n`,
			);
		}
		return;
	}

	// Spawn the MCP server as a detached process
	const serverScript = join(projectRoot, "src", "mcp", "server.ts");
	const proc = Bun.spawn(["bun", serverScript], {
		cwd: projectRoot,
		detached: true,
		stdout: "ignore",
		stderr: "ignore",
		stdin: "ignore",
		env: {
			...process.env,
			OVERSTORY_MCP_PORT: String(config.mcp.port ?? DEFAULT_MCP_PORT),
		},
	});

	// Unref the process so our CLI can exit without waiting for it
	proc.unref();

	// Poll for the state file to appear (retry up to 10 times, 500ms each)
	let state = null;
	for (let attempt = 0; attempt < 10; attempt++) {
		await Bun.sleep(500);
		state = await readServerState(overstoryDir);
		if (state && isServerAlive(state)) {
			break;
		}
		state = null;
	}

	if (!state) {
		process.stderr.write("MCP server failed to start (state file not created within 5 seconds)\n");
		process.exit(1);
	}

	if (json) {
		process.stdout.write(
			`${JSON.stringify({ started: true, pid: state.pid, port: state.port, url: state.url })}\n`,
		);
	} else {
		process.stdout.write(
			`MCP server started on http://127.0.0.1:${state.port}/mcp (pid ${state.pid})\n`,
		);
	}
}

/**
 * Stop the MCP server.
 *
 * 1. Load config, find overstoryDir
 * 2. Read state file — if not found or not alive, print "not running"
 * 3. Send SIGTERM to the PID
 * 4. Wait up to 3 seconds for state file to be deleted
 * 5. Print confirmation
 */
async function stopMcp(args: string[]): Promise<void> {
	const json = args.includes("--json");
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const projectRoot = config.project.root;
	const overstoryDir = join(projectRoot, ".overstory");

	const state = await readServerState(overstoryDir);

	if (!state || !isServerAlive(state)) {
		if (json) {
			process.stdout.write(`${JSON.stringify({ running: false, stopped: false })}\n`);
		} else {
			process.stdout.write("MCP server is not running\n");
		}
		return;
	}

	// Send SIGTERM
	try {
		process.kill(state.pid, 15);
	} catch {
		// Process may have already died
	}

	// Wait up to 3 seconds for the state file to be deleted
	let stopped = false;
	for (let attempt = 0; attempt < 6; attempt++) {
		await Bun.sleep(500);
		const current = await readServerState(overstoryDir);
		if (!current || !isServerAlive(current)) {
			stopped = true;
			break;
		}
	}

	if (json) {
		process.stdout.write(`${JSON.stringify({ stopped, pid: state.pid, port: state.port })}\n`);
	} else {
		process.stdout.write("MCP server stopped\n");
	}
}

/**
 * Show MCP server status.
 *
 * 1. Load config, find overstoryDir
 * 2. Read state file — if not found, print "not running"
 * 3. Check isServerAlive — if dead, print "not running (stale state file)"
 * 4. Print server info
 */
async function statusMcp(args: string[]): Promise<void> {
	const json = args.includes("--json");
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const projectRoot = config.project.root;
	const overstoryDir = join(projectRoot, ".overstory");

	const state = await readServerState(overstoryDir);

	if (!state) {
		if (json) {
			process.stdout.write(`${JSON.stringify({ running: false })}\n`);
		} else {
			process.stdout.write("MCP server is not running\n");
		}
		return;
	}

	const alive = isServerAlive(state);

	if (!alive) {
		if (json) {
			process.stdout.write(
				`${JSON.stringify({ running: false, stale: true, pid: state.pid, port: state.port })}\n`,
			);
		} else {
			process.stdout.write("MCP server is not running (stale state file)\n");
		}
		return;
	}

	if (json) {
		process.stdout.write(
			`${JSON.stringify({ running: true, pid: state.pid, port: state.port, startedAt: state.startedAt, url: state.url })}\n`,
		);
	} else {
		process.stdout.write("MCP server: running\n");
		process.stdout.write(`  PID:       ${state.pid}\n`);
		process.stdout.write(`  Port:      ${state.port}\n`);
		process.stdout.write(`  URL:       ${state.url}\n`);
		process.stdout.write(`  Started:   ${state.startedAt}\n`);
	}
}

const MCP_HELP = `overstory mcp — Manage the MCP server

Usage: overstory mcp <subcommand> [flags]

Subcommands:
  start                    Start the MCP server (detached background process)
  stop                     Stop the MCP server
  status                   Show MCP server state

General options:
  --json                   Output as JSON
  --help, -h               Show this help

The MCP server exposes overstory tools as MCP-compatible tools that Claude Code
agents can call directly instead of using CLI commands. State is persisted to
.overstory/mcp-server.json.`;

/**
 * Entry point for `overstory mcp <subcommand>`.
 *
 * @param args - CLI arguments after "mcp"
 */
export async function mcpCommand(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h") || args.length === 0) {
		process.stdout.write(`${MCP_HELP}\n`);
		return;
	}

	const subcommand = args[0];
	const subArgs = args.slice(1);

	switch (subcommand) {
		case "start":
			await startMcp(subArgs);
			break;
		case "stop":
			await stopMcp(subArgs);
			break;
		case "status":
			await statusMcp(subArgs);
			break;
		default:
			throw new ValidationError(
				`Unknown mcp subcommand: ${subcommand}. Run 'overstory mcp --help' for usage.`,
				{ field: "subcommand", value: subcommand },
			);
	}
}
