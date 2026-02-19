/**
 * CLI command: overstory daemon start|stop|status
 *
 * Manages the Codex daemon sidecar process. The daemon runs as a long-lived
 * background process, managing a pool of Codex agents via multiplexed WebSocket
 * connections to the Codex App Server.
 *
 * State is persisted in .overstory/daemon.json (mode 0600) so multiple CLI
 * invocations can inspect and control the same daemon process.
 */

import { join } from "node:path";
import {
	ensureDaemonRunning,
	isDaemonAlive,
	readDaemonStateSync,
	stopDaemon,
} from "../codex/daemon/lifecycle.ts";
import { loadConfig } from "../config.ts";
import { ConfigError, ValidationError } from "../errors.ts";

function hasFlag(args: string[], flag: string): boolean {
	return args.includes(flag);
}

function getSubcommand(args: string[]): string | undefined {
	return args.find((a) => !a.startsWith("-"));
}

/**
 * Start the Codex daemon sidecar.
 * If already running, prints the existing daemon URL and exits cleanly.
 */
async function startDaemon(args: string[]): Promise<void> {
	const json = hasFlag(args, "--json");
	const cwd = process.cwd();
	const config = await loadConfig(cwd);

	if (!config.codex) {
		throw new ConfigError("codex section is required in config to manage the daemon", {
			field: "codex",
		});
	}

	const overstoryDir = join(config.project.root, ".overstory");
	const state = await ensureDaemonRunning(overstoryDir, {
		port: config.codex.daemonPort,
		codexServerUrl: `ws://127.0.0.1:${config.codex.serverPort}`,
		projectRoot: config.project.root,
	});

	if (json) {
		process.stdout.write(`${JSON.stringify({ started: true, ...state, token: "[REDACTED]" })}\n`);
	} else {
		process.stdout.write("Codex daemon running\n");
		process.stdout.write(`  PID:     ${state.pid}\n`);
		process.stdout.write(`  Port:    ${state.port}\n`);
		process.stdout.write(`  URL:     ${state.url}\n`);
		process.stdout.write(`  Started: ${state.startedAt}\n`);
	}
}

/**
 * Stop the Codex daemon sidecar.
 * Sends POST /shutdown with bearer auth, falls back to SIGTERM.
 */
async function stopDaemonCmd(args: string[]): Promise<void> {
	const json = hasFlag(args, "--json");
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const overstoryDir = join(config.project.root, ".overstory");

	const stopped = await stopDaemon(overstoryDir);

	if (json) {
		process.stdout.write(`${JSON.stringify({ stopped })}\n`);
	} else {
		if (stopped) {
			process.stdout.write("Codex daemon stopped\n");
		} else {
			process.stdout.write("No Codex daemon was running\n");
		}
	}
}

/**
 * Show the current status of the Codex daemon sidecar.
 * Reads daemon.json, checks process liveness, and pings /health.
 */
async function statusDaemon(args: string[]): Promise<void> {
	const json = hasFlag(args, "--json");
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const overstoryDir = join(config.project.root, ".overstory");

	const state = readDaemonStateSync(overstoryDir);

	if (!state) {
		if (json) {
			process.stdout.write(`${JSON.stringify({ running: false })}\n`);
		} else {
			process.stdout.write("Codex daemon is not running\n");
		}
		return;
	}

	const alive = isDaemonAlive(state);

	// Ping /health for agent count
	let agentCount: number | undefined;
	if (alive) {
		try {
			const res = await fetch(`${state.url}/health`);
			if (res.ok) {
				const body = (await res.json()) as { agents?: number };
				agentCount = body.agents;
			}
		} catch {
			// Non-fatal — just skip agent count
		}
	}

	if (json) {
		process.stdout.write(
			`${JSON.stringify({
				running: alive,
				pid: state.pid,
				port: state.port,
				url: state.url,
				startedAt: state.startedAt,
				agents: agentCount,
			})}\n`,
		);
	} else {
		const label = alive ? "running" : "dead (stale state file)";
		process.stdout.write(`Codex daemon: ${label}\n`);
		process.stdout.write(`  PID:     ${state.pid}\n`);
		process.stdout.write(`  Port:    ${state.port}\n`);
		process.stdout.write(`  URL:     ${state.url}\n`);
		process.stdout.write(`  Started: ${state.startedAt}\n`);
		if (agentCount !== undefined) {
			process.stdout.write(`  Agents:  ${agentCount}\n`);
		}
	}
}

const DAEMON_HELP = `overstory daemon — Manage the Codex daemon sidecar

Usage: overstory daemon <subcommand> [flags]

Subcommands:
  start                    Start the Codex daemon sidecar
  stop                     Stop the Codex daemon sidecar
  status                   Show Codex daemon state

General options:
  --json                   Output as JSON
  --help, -h               Show this help

The Codex daemon manages a pool of Codex agents via multiplexed WebSocket
connections to the Codex App Server. One daemon is shared across all
codex-daemon agents in a project. State is persisted in .overstory/daemon.json
(mode 0600 — contains bearer token).`;

/**
 * Entry point for \`overstory daemon <subcommand>\`.
 *
 * @param args - CLI arguments after "daemon"
 */
export async function daemonCommand(args: string[]): Promise<void> {
	if (hasFlag(args, "--help") || hasFlag(args, "-h") || args.length === 0) {
		process.stdout.write(`${DAEMON_HELP}\n`);
		return;
	}

	const subcommand = getSubcommand(args);
	const subArgs = args.slice(1);

	switch (subcommand) {
		case "start":
			await startDaemon(subArgs);
			break;
		case "stop":
			await stopDaemonCmd(subArgs);
			break;
		case "status":
			await statusDaemon(subArgs);
			break;
		default:
			throw new ValidationError(
				`Unknown daemon subcommand: ${subcommand}. Run 'overstory daemon --help' for usage.`,
				{ field: "subcommand", value: subcommand },
			);
	}
}
