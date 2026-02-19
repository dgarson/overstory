import { isServerAlive, readServerState } from "../codex/server.ts";
import type { DoctorCheck, DoctorCheckFn } from "./types.ts";

/**
 * Codex integration health checks.
 * Validates that the codex CLI is installed and, if codex is enabled,
 * that the shared App Server is running.
 */
export const checkCodex: DoctorCheckFn = async (config, overstoryDir): Promise<DoctorCheck[]> => {
	const checks: DoctorCheck[] = [];

	// Check if codex CLI is installed
	const proc = Bun.spawn(["which", "codex"], { stdout: "pipe", stderr: "pipe" });
	const exitCode = await proc.exited;
	checks.push({
		name: "codex CLI",
		category: "codex",
		status: exitCode === 0 ? "pass" : "warn",
		message: exitCode === 0 ? "codex CLI found in PATH" : "codex CLI not found in PATH",
	});

	// Check server state if codex is enabled
	if (config.codex?.enabled) {
		const state = await readServerState(overstoryDir);
		if (state) {
			const alive = isServerAlive(state);
			checks.push({
				name: "codex app-server",
				category: "codex",
				status: alive ? "pass" : "fail",
				message: alive
					? `Codex App Server running (PID ${state.pid}, port ${state.port})`
					: `Codex App Server dead (PID ${state.pid} not responding)`,
			});
		} else {
			checks.push({
				name: "codex app-server",
				category: "codex",
				status: "warn",
				message: "Codex enabled but App Server not started",
			});
		}
	}

	return checks;
};
