/**
 * CLI command: overstory codex start|stop|status
 *
 * Manages the shared Codex App Server lifecycle. The server runs as a background
 * process listening on a WebSocket port, accepting JSON-RPC connections from
 * Codex agent bridge instances.
 *
 * State is persisted in .overstory/codex-server.json so multiple CLI invocations
 * can inspect and control the same server process.
 */

import { join } from "node:path";
import { isServerAlive, readServerState, startServer, stopServer } from "../codex/server.ts";
import { loadConfig } from "../config.ts";
import { ConfigError, ValidationError } from "../errors.ts";

function hasFlag(args: string[], flag: string): boolean {
	return args.includes(flag);
}

function getSubcommand(args: string[]): string | undefined {
	return args.find((a) => !a.startsWith("-"));
}

/**
 * Start the Codex App Server.
 * If already running, prints the existing server URL and exits cleanly.
 */
async function startCodexServer(args: string[]): Promise<void> {
	const json = hasFlag(args, "--json");
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	if (!config.codex) {
		throw new ConfigError("codex section is required in config to manage the app server", {
			field: "codex",
		});
	}
	const overstoryDir = join(config.project.root, ".overstory");
	const port = config.codex.serverPort;

	const state = await startServer(overstoryDir, port);

	if (json) {
		process.stdout.write(`${JSON.stringify({ started: true, ...state })}\n`);
	} else {
		process.stdout.write(`Codex App Server running\n`);
		process.stdout.write(`  PID:     ${state.pid}\n`);
		process.stdout.write(`  Port:    ${state.port}\n`);
		process.stdout.write(`  URL:     ${state.url}\n`);
		process.stdout.write(`  Started: ${state.startedAt}\n`);
	}
}

/**
 * Stop the Codex App Server.
 * Sends SIGTERM to the server process and removes the state file.
 */
async function stopCodexServer(args: string[]): Promise<void> {
	const json = hasFlag(args, "--json");
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const overstoryDir = join(config.project.root, ".overstory");

	const stopped = await stopServer(overstoryDir);

	if (json) {
		process.stdout.write(`${JSON.stringify({ stopped })}\n`);
	} else {
		if (stopped) {
			process.stdout.write("Codex App Server stopped\n");
		} else {
			process.stdout.write("No Codex App Server was running\n");
		}
	}
}

/**
 * Show the current status of the Codex App Server.
 * Reads state file and checks process liveness.
 */
async function statusCodexServer(args: string[]): Promise<void> {
	const json = hasFlag(args, "--json");
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const overstoryDir = join(config.project.root, ".overstory");

	const state = await readServerState(overstoryDir);

	if (!state) {
		if (json) {
			process.stdout.write(`${JSON.stringify({ running: false })}\n`);
		} else {
			process.stdout.write("Codex App Server is not running\n");
		}
		return;
	}

	const alive = isServerAlive(state);

	if (json) {
		process.stdout.write(`${JSON.stringify({ running: alive, ...state })}\n`);
	} else {
		const label = alive ? "running" : "dead (stale state file)";
		process.stdout.write(`Codex App Server: ${label}\n`);
		process.stdout.write(`  PID:     ${state.pid}\n`);
		process.stdout.write(`  Port:    ${state.port}\n`);
		process.stdout.write(`  URL:     ${state.url}\n`);
		process.stdout.write(`  Started: ${state.startedAt}\n`);
	}
}

const CODEX_HELP = `overstory codex — Manage the shared Codex App Server

Usage: overstory codex <subcommand> [flags]

Subcommands:
  start                    Start the Codex App Server
  stop                     Stop the Codex App Server
  status                   Show Codex App Server state

General options:
  --json                   Output as JSON
  --help, -h               Show this help

The Codex App Server accepts WebSocket JSON-RPC connections from Codex agent
bridge instances. One server is shared across all Codex agents in a project.
Server state is persisted in .overstory/codex-server.json.`;

/**
 * Entry point for \`overstory codex <subcommand>\`.
 *
 * @param args - CLI arguments after "codex"
 */
export async function codexCommand(args: string[]): Promise<void> {
	if (hasFlag(args, "--help") || hasFlag(args, "-h") || args.length === 0) {
		process.stdout.write(`${CODEX_HELP}\n`);
		return;
	}

	const subcommand = getSubcommand(args);
	const subArgs = args.slice(1);

	switch (subcommand) {
		case "start":
			await startCodexServer(subArgs);
			break;
		case "stop":
			await stopCodexServer(subArgs);
			break;
		case "status":
			await statusCodexServer(subArgs);
			break;
		default:
			throw new ValidationError(
				`Unknown codex subcommand: ${subcommand}. Run 'overstory codex --help' for usage.`,
				{ field: "subcommand", value: subcommand },
			);
	}
}
