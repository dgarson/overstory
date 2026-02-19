/**
 * MCP server entry point.
 *
 * When invoked as `bun src/mcp/server.ts`, starts the HTTP server,
 * coordinator loop, and registers SIGTERM handler.
 *
 * Process lifecycle:
 * 1. Load config
 * 2. Initialize stores
 * 3. Start Bun.serve on configured port
 * 4. Start coordinator loop
 * 5. Write state file
 * 6. Handle SIGTERM for graceful shutdown
 *
 * The server can also be started via `overstory mcp start`.
 */

import { join } from "node:path";
import { loadConfig, resolveProjectRoot } from "../config.ts";
import { createMailStore } from "../mail/store.ts";
import { createWorkflowEngine } from "../workflow/engine.ts";
import { createWorkflowStore } from "../workflow/store.ts";
import { startCoordinatorLoop } from "./coordinator-loop.ts";
import { deleteServerState, writeServerState } from "./state.ts";
import { buildToolHandlers } from "./tools.ts";
import { buildFetchHandler, createTransportState } from "./transport.ts";

async function main() {
	const cwd = process.cwd();
	const projectRoot = await resolveProjectRoot(cwd);
	const config = await loadConfig(projectRoot);

	const overstoryDir = join(projectRoot, ".overstory");
	const port = config.mcp.port;

	// Initialize stores
	const mailStore = createMailStore(join(overstoryDir, "mail.db"));
	const workflowStore = createWorkflowStore(join(overstoryDir, "workflow.db"));
	const workflowEngine = createWorkflowEngine({ store: workflowStore });

	// Build transport
	const transport = createTransportState();
	const toolHandlers = buildToolHandlers({
		workflowEngine,
		mailStore,
		transport,
		config: { awaitWorkMaxMs: config.mcp.awaitWorkMaxMs },
	});

	// Start HTTP server
	const server = Bun.serve({
		port,
		fetch: buildFetchHandler(transport, toolHandlers, config.project.name),
	});

	// Start coordinator loop
	const stopLoop = startCoordinatorLoop({
		mailStore,
		workflowEngine,
		transport,
		config: {
			intervalMs: config.mcp.coordinatorIntervalMs,
			idleThresholdMs: config.mcp.idleThresholdMs,
			projectId: config.project.name,
		},
	});

	// Write state file
	const state = {
		pid: process.pid,
		port,
		startedAt: new Date().toISOString(),
		url: `http://127.0.0.1:${port}/mcp`,
	};
	await writeServerState(overstoryDir, state);

	process.stderr.write(`[overstory-mcp] Server listening on http://127.0.0.1:${port}/mcp\n`);

	// Graceful shutdown
	async function shutdown() {
		process.stderr.write("[overstory-mcp] Shutting down...\n");
		stopLoop();
		server.stop(true);
		mailStore.close();
		workflowStore.close();
		await deleteServerState(overstoryDir);
		process.exit(0);
	}

	process.on("SIGTERM", () => {
		shutdown().catch(() => process.exit(1));
	});
	process.on("SIGINT", () => {
		shutdown().catch(() => process.exit(1));
	});
}

if (import.meta.main) {
	main().catch((err: unknown) => {
		process.stderr.write(
			`[overstory-mcp] Fatal: ${err instanceof Error ? err.message : String(err)}\n`,
		);
		process.exit(1);
	});
}
