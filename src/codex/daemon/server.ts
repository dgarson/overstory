// src/codex/daemon/server.ts
import type { BridgeConfig } from "../types.ts";
import type { AgentPool } from "./pool.ts";

export interface DaemonServerOpts {
	port: number;
	pool: AgentPool;
	token: string;
	hostname?: string; // defaults to "127.0.0.1" (localhost only)
	/** Codex App Server WebSocket URL — stamped into each BridgeConfig before pool.add() */
	codexServerUrl?: string;
}

export function createDaemonServer(opts: DaemonServerOpts): ReturnType<typeof Bun.serve> {
	const { pool, token, hostname = "127.0.0.1", codexServerUrl } = opts;

	function requireAuth(req: Request): Response | null {
		const auth = req.headers.get("authorization");
		if (auth !== `Bearer ${token}`) {
			return new Response("Unauthorized", { status: 401 });
		}
		return null;
	}

	return Bun.serve({
		port: opts.port,
		hostname,
		async fetch(req) {
			const url = new URL(req.url);
			const method = req.method;

			// GET /health — unauthenticated liveness check
			if (url.pathname === "/health" && method === "GET") {
				return Response.json({ status: "ok", agents: pool.names().length });
			}

			// GET /agents — unauthenticated read-only list
			if (url.pathname === "/agents" && method === "GET") {
				return Response.json(
					pool.names().map((n) => ({
						name: n,
						state: pool.get(n)?.state,
					})),
				);
			}

			// GET /agents/:name — unauthenticated read-only inspect
			const agentMatch = url.pathname.match(/^\/agents\/([^/]+)$/);
			if (agentMatch && method === "GET") {
				const rawName = agentMatch[1];
				if (!rawName) return new Response("Not Found", { status: 404 });
				const agentName = decodeURIComponent(rawName);
				const agent = pool.get(agentName);
				if (!agent) return new Response("Not Found", { status: 404 });
				return Response.json(agent);
			}

			// --- Mutation endpoints require bearer token ---

			if (url.pathname === "/agents" && method === "POST") {
				const authErr = requireAuth(req);
				if (authErr) return authErr;
				let raw: unknown;
				try {
					raw = await req.json();
				} catch {
					return new Response("Bad Request: malformed JSON", { status: 400 });
				}
				if (
					typeof raw !== "object" ||
					raw === null ||
					!("agentName" in raw) ||
					typeof (raw as Record<string, unknown>).agentName !== "string"
				) {
					return new Response("Bad Request", { status: 400 });
				}
				const config = raw as BridgeConfig;
				// Stamp the daemon's codexServerUrl into the config if not already set
				if (codexServerUrl && !config.serverUrl) {
					config.serverUrl = codexServerUrl;
				}
				await pool.add(config);
				return new Response(null, { status: 201 });
			}

			// POST /agents/:name/nudge
			const nudgeMatch = url.pathname.match(/^\/agents\/([^/]+)\/nudge$/);
			if (nudgeMatch && method === "POST") {
				const authErr = requireAuth(req);
				if (authErr) return authErr;
				const rawName = nudgeMatch[1];
				if (!rawName) return new Response("Not Found", { status: 404 });
				const agentName = decodeURIComponent(rawName);
				let raw: unknown;
				try {
					raw = await req.json();
				} catch {
					return new Response("Bad Request: malformed JSON", { status: 400 });
				}
				if (
					typeof raw !== "object" ||
					raw === null ||
					!("message" in raw) ||
					typeof (raw as Record<string, unknown>).message !== "string"
				) {
					return new Response("Bad Request", { status: 400 });
				}
				const body = raw as { message: string; force?: boolean };
				const result = await pool.nudge(agentName, body.message, body.force);
				return Response.json(result);
			}

			// POST /agents/:name/steer
			const steerMatch = url.pathname.match(/^\/agents\/([^/]+)\/steer$/);
			if (steerMatch && method === "POST") {
				const authErr = requireAuth(req);
				if (authErr) return authErr;
				const rawName = steerMatch[1];
				if (!rawName) return new Response("Not Found", { status: 404 });
				const agentName = decodeURIComponent(rawName);
				let raw: unknown;
				try {
					raw = await req.json();
				} catch {
					return new Response("Bad Request: malformed JSON", { status: 400 });
				}
				if (
					typeof raw !== "object" ||
					raw === null ||
					!("input" in raw) ||
					typeof (raw as Record<string, unknown>).input !== "string"
				) {
					return new Response("Bad Request", { status: 400 });
				}
				const body = raw as { input: string };
				const delivered = await pool.steer(agentName, body.input);
				return Response.json({ delivered });
			}

			// DELETE /agents/:name
			const deleteMatch = url.pathname.match(/^\/agents\/([^/]+)$/);
			if (deleteMatch && method === "DELETE") {
				const authErr = requireAuth(req);
				if (authErr) return authErr;
				const rawName = deleteMatch[1];
				if (!rawName) return new Response("Not Found", { status: 404 });
				const agentName = decodeURIComponent(rawName);
				await pool.remove(agentName);
				return new Response(null, { status: 204 });
			}

			if (url.pathname === "/shutdown" && method === "POST") {
				const authErr = requireAuth(req);
				if (authErr) return authErr;
				await pool.drain();
				setTimeout(() => process.exit(0), 100);
				return Response.json({ status: "shutting_down" });
			}

			return new Response("Not Found", { status: 404 });
		},
	});
}
