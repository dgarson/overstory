/**
 * CLI command: overstory control start|stop|status|daemon
 *
 * Manages the per-project control daemon used for safe nudging and durable
 * cross-agent notification delivery.
 */

import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { runControlDaemon } from "../control/daemon.ts";
import {
	getControlServerStatePath,
	isControlServerAlive,
	readControlServerState,
	startControlServer,
	stopControlServer,
} from "../control/server.ts";
import type { ControlServerState } from "../control/types.ts";

function hasFlag(args: string[], flag: string): boolean {
	return args.includes(flag);
}

function getFlag(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	if (idx === -1 || idx + 1 >= args.length) return undefined;
	return args[idx + 1];
}

function getSubcommand(args: string[]): string | undefined {
	return args.find((a) => !a.startsWith("-"));
}

function randomToken(): string {
	const bytes = new Uint8Array(24);
	crypto.getRandomValues(bytes);
	return Buffer.from(bytes).toString("hex");
}

async function writeState(overstoryDir: string, state: ControlServerState): Promise<void> {
	await Bun.write(
		getControlServerStatePath(overstoryDir),
		`${JSON.stringify(state, null, "\t")}\n`,
	);
}

async function startCommand(args: string[]): Promise<void> {
	const json = hasFlag(args, "--json");
	const config = await loadConfig(process.cwd());
	if (!config.control.enabled) {
		if (json) {
			process.stdout.write(`${JSON.stringify({ started: false, reason: "control_disabled" })}\n`);
		} else {
			process.stdout.write("Control daemon is disabled in config (control.enabled=false)\n");
		}
		return;
	}

	const overstoryDir = join(config.project.root, ".overstory");
	const state = await startControlServer(config.project.root, overstoryDir, config.control.port);

	if (json) {
		process.stdout.write(`${JSON.stringify({ started: true, ...state })}\n`);
	} else {
		process.stdout.write(`Control daemon running\n`);
		process.stdout.write(`  PID:     ${state.pid}\n`);
		process.stdout.write(`  Port:    ${state.port}\n`);
		process.stdout.write(`  URL:     ${state.url}\n`);
		process.stdout.write(`  Started: ${state.startedAt}\n`);
	}
}

async function stopCommand(args: string[]): Promise<void> {
	const json = hasFlag(args, "--json");
	const config = await loadConfig(process.cwd());
	const overstoryDir = join(config.project.root, ".overstory");
	const stopped = await stopControlServer(overstoryDir);
	if (json) {
		process.stdout.write(`${JSON.stringify({ stopped })}\n`);
	} else {
		process.stdout.write(stopped ? "Control daemon stopped\n" : "No control daemon was running\n");
	}
}

async function statusCommand(args: string[]): Promise<void> {
	const json = hasFlag(args, "--json");
	const config = await loadConfig(process.cwd());
	const overstoryDir = join(config.project.root, ".overstory");
	const state = await readControlServerState(overstoryDir);
	if (!state) {
		if (json) {
			process.stdout.write(`${JSON.stringify({ running: false })}\n`);
		} else {
			process.stdout.write("Control daemon is not running\n");
		}
		return;
	}
	const alive = isControlServerAlive(state);
	if (json) {
		process.stdout.write(`${JSON.stringify({ running: alive, ...state })}\n`);
	} else {
		process.stdout.write(`Control daemon: ${alive ? "running" : "dead (stale state file)"}\n`);
		process.stdout.write(`  PID:     ${state.pid}\n`);
		process.stdout.write(`  Port:    ${state.port}\n`);
		process.stdout.write(`  URL:     ${state.url}\n`);
		process.stdout.write(`  Started: ${state.startedAt}\n`);
	}
}

async function daemonCommand(args: string[]): Promise<void> {
	const config = await loadConfig(process.cwd());
	const overstoryDir = join(config.project.root, ".overstory");
	const portFlag = getFlag(args, "--port");
	const port = portFlag ? Number.parseInt(portFlag, 10) : config.control.port;
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new ValidationError("--port must be an integer between 1 and 65535", {
			field: "port",
			value: portFlag,
		});
	}

	const existing = await readControlServerState(overstoryDir);
	const token =
		process.env.OVERSTORY_CONTROL_TOKEN ??
		existing?.token ??
		randomToken();

	// Ensure state file exists for clients. If already present and matching pid, keep it.
	const state: ControlServerState = {
		pid: process.pid,
		port,
		url: `http://127.0.0.1:${port}`,
		token,
		startedAt: existing?.startedAt ?? new Date().toISOString(),
	};
	await writeState(overstoryDir, state);

	await runControlDaemon({
		projectRoot: config.project.root,
		overstoryDir,
		port,
		token,
		loopIntervalMs: config.control.loopIntervalMs,
		idleThresholdMs: config.control.idleThresholdMs,
		leaseMs: config.control.leaseMs,
		nudgeCooldownMs: config.control.nudgeCooldownMs,
	});
}

const CONTROL_HELP = `overstory control — Manage the control daemon

Usage: overstory control <subcommand> [flags]

Subcommands:
  start                    Start the per-project control daemon
  stop                     Stop the control daemon
  status                   Show daemon status
  daemon                   Run daemon in foreground (internal)

Options:
  --json                   Output JSON for start/stop/status
  --port <n>               Override daemon listen port (daemon mode)
  --help, -h               Show this help`;

export async function controlCommand(args: string[]): Promise<void> {
	if (args.length === 0 || hasFlag(args, "--help") || hasFlag(args, "-h")) {
		process.stdout.write(`${CONTROL_HELP}\n`);
		return;
	}
	const subcommand = getSubcommand(args);
	const subArgs = args.slice(1);
	switch (subcommand) {
		case "start":
			await startCommand(subArgs);
			return;
		case "stop":
			await stopCommand(subArgs);
			return;
		case "status":
			await statusCommand(subArgs);
			return;
		case "daemon":
			await daemonCommand(subArgs);
			return;
		default:
			throw new ValidationError(
				`Unknown control subcommand: ${subcommand}. Run 'overstory control --help' for usage.`,
				{ field: "subcommand", value: subcommand },
			);
	}
}
