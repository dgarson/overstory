import { join } from "node:path";
import type { ControlServerState } from "./types.ts";

const STATE_FILE = "control-server.json";

export function getControlServerStatePath(overstoryDir: string): string {
	return join(overstoryDir, STATE_FILE);
}

export function parseControlServerState(raw: string): ControlServerState | null {
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		if (
			typeof parsed.pid !== "number" ||
			typeof parsed.port !== "number" ||
			typeof parsed.url !== "string" ||
			typeof parsed.token !== "string" ||
			typeof parsed.startedAt !== "string"
		) {
			return null;
		}
		return {
			pid: parsed.pid,
			port: parsed.port,
			url: parsed.url,
			token: parsed.token,
			startedAt: parsed.startedAt,
		};
	} catch {
		return null;
	}
}

export function isControlServerAlive(state: ControlServerState): boolean {
	if (state.pid <= 0) return false;
	try {
		process.kill(state.pid, 0);
		return true;
	} catch {
		return false;
	}
}

export async function readControlServerState(overstoryDir: string): Promise<ControlServerState | null> {
	const path = getControlServerStatePath(overstoryDir);
	const file = Bun.file(path);
	if (!(await file.exists())) return null;
	return parseControlServerState(await file.text());
}

function randomToken(): string {
	const bytes = new Uint8Array(24);
	crypto.getRandomValues(bytes);
	return Buffer.from(bytes).toString("hex");
}

async function resolveOverstoryBin(): Promise<string> {
	try {
		const proc = Bun.spawn(["which", "overstory"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		if ((await proc.exited) === 0) {
			const path = (await new Response(proc.stdout).text()).trim();
			if (path.length > 0) return path;
		}
	} catch {
		// fallback below
	}
	const scriptPath = process.argv[1];
	if (scriptPath) return scriptPath;
	throw new Error("Cannot resolve overstory executable for control daemon start");
}

async function waitUntilHealthy(state: ControlServerState, timeoutMs = 3000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const resp = await fetch(`${state.url}/health`, {
				method: "GET",
				headers: {
					"x-overstory-control-token": state.token,
				},
			});
			if (resp.ok) return;
		} catch {
			// keep waiting
		}
		await Bun.sleep(100);
	}
	throw new Error("Control daemon did not become healthy in time");
}

export async function startControlServer(
	projectRoot: string,
	overstoryDir: string,
	port: number,
	opts: { waitForHealth?: boolean; healthTimeoutMs?: number } = {},
): Promise<ControlServerState> {
	const existing = await readControlServerState(overstoryDir);
	if (existing && isControlServerAlive(existing)) {
		return existing;
	}

	const token = randomToken();
	const url = `http://127.0.0.1:${port}`;
	const overstoryBin = await resolveOverstoryBin();
	const child = Bun.spawn(
		["bun", "run", overstoryBin, "control", "daemon", "--port", String(port)],
		{
			cwd: projectRoot,
			stdout: "ignore",
			stderr: "ignore",
			stdin: "ignore",
			env: {
				...process.env,
				OVERSTORY_CONTROL_TOKEN: token,
				OVERSTORY_CONTROL_PROJECT_ROOT: projectRoot,
			},
		},
	);
	child.unref();

	const state: ControlServerState = {
		pid: child.pid,
		port,
		url,
		token,
		startedAt: new Date().toISOString(),
	};
	await Bun.write(getControlServerStatePath(overstoryDir), `${JSON.stringify(state, null, "\t")}\n`);
	if (opts.waitForHealth !== false) {
		await waitUntilHealthy(state, opts.healthTimeoutMs);
	}
	return state;
}

export async function stopControlServer(overstoryDir: string): Promise<boolean> {
	const state = await readControlServerState(overstoryDir);
	if (!state) return false;

	if (isControlServerAlive(state)) {
		try {
			process.kill(state.pid, "SIGTERM");
		} catch {
			// no-op: already dead
		}
	}
	try {
		const { unlink } = await import("node:fs/promises");
		await unlink(getControlServerStatePath(overstoryDir));
	} catch {
		// no-op: state file missing
	}
	return true;
}
