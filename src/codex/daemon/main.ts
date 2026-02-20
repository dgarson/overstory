// src/codex/daemon/main.ts
// Entry point for the daemon sidecar process.
// Spawned by ensureDaemonRunning() on the first codex-daemon agent spawn.
// Environment variables:
//   OVERSTORY_DAEMON_PORT     — port to listen on (0 = random)
//   OVERSTORY_DIR             — path to .overstory/ directory
//   OVERSTORY_DAEMON_TOKEN    — bearer token for auth
//   OVERSTORY_CODEX_SERVER_URL — Codex App Server WebSocket URL

import { createRpcClientWithRetry } from "../rpc-client.ts";
import { createAgentPool } from "./pool.ts";
import { createDaemonServer } from "./server.ts";

if (import.meta.main) {
	const port = Number(process.env.OVERSTORY_DAEMON_PORT ?? "0");
	const overstoryDir = process.env.OVERSTORY_DIR ?? "";
	const token = process.env.OVERSTORY_DAEMON_TOKEN ?? "";

	const pool = createAgentPool({
		createRpcClient: (url) => createRpcClientWithRetry(url),
	});

	const codexServerUrl = process.env.OVERSTORY_CODEX_SERVER_URL ?? "";
	const server = createDaemonServer({ port, pool, token, codexServerUrl });

	// Write state file so CLI can discover URL and token
	const stateFile = `${overstoryDir}/daemon.json`;
	await Bun.write(
		stateFile,
		JSON.stringify({
			pid: process.pid,
			port: server.port,
			startedAt: new Date().toISOString(),
			url: server.url,
			token,
		}),
	);

	// Clean up state file on exit
	process.on("SIGTERM", async () => {
		await pool.drain();
		try {
			if (await Bun.file(stateFile).exists()) {
				await Bun.write(stateFile, "");
			}
		} catch {
			// best-effort cleanup
		}
		process.exit(0);
	});

	console.log(`[daemon] listening on ${server.url}`);
}
