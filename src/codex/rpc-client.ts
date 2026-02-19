// src/codex/rpc-client.ts
// JSON-RPC 2.0 client over WebSocket for the Codex App Server.
//
// Uses node:http for the WebSocket upgrade handshake instead of Bun's native
// WebSocket, which is incompatible with the Codex App Server's WebSocket
// implementation (Bun's client fails the handshake with "Connection ended").
import { randomBytes } from "node:crypto";
import { connect as netConnect, type Socket } from "node:net";
import type { JsonRpcRequest } from "./types";

/** Handler for server-initiated requests. Returns the result to send back. */
export type RequestHandler = (method: string, params: unknown) => Promise<unknown> | unknown;

export interface RpcClient {
	request(method: string, params?: Record<string, unknown>): Promise<unknown>;
	onNotification(handler: (method: string, params: unknown) => void): void;
	/** Register a handler for server-initiated requests (has id + method) */
	onRequest(handler: RequestHandler): void;
	/** Whether the WebSocket connection has been closed */
	readonly closed: boolean;
	close(): void;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// Low-level WebSocket frame encoding/decoding (RFC 6455)
// ---------------------------------------------------------------------------

/** Encode a UTF-8 text payload into a masked WebSocket frame (client→server). */
function encodeTextFrame(payload: string): Buffer {
	const data = Buffer.from(payload, "utf-8");
	const len = data.length;
	const mask = randomBytes(4);

	let headerLen: number;
	let header: Buffer;

	if (len < 126) {
		headerLen = 2;
		header = Buffer.alloc(headerLen + 4);
		header[0] = 0x81; // FIN + text opcode
		header[1] = 0x80 | len; // MASK bit + 7-bit length
	} else if (len < 65536) {
		headerLen = 4;
		header = Buffer.alloc(headerLen + 4);
		header[0] = 0x81;
		header[1] = 0x80 | 126;
		header.writeUInt16BE(len, 2);
	} else {
		headerLen = 10;
		header = Buffer.alloc(headerLen + 4);
		header[0] = 0x81;
		header[1] = 0x80 | 127;
		// JavaScript safe integers fit in 53 bits; write as two 32-bit words
		header.writeUInt32BE(Math.floor(len / 0x1_0000_0000), 2);
		header.writeUInt32BE(len >>> 0, 6);
	}

	// Write mask key after the length header
	mask.copy(header, headerLen);

	// Mask the payload
	const masked = Buffer.alloc(len);
	for (let i = 0; i < len; i++) {
		masked[i] = (data[i] ?? 0) ^ (mask[i % 4] ?? 0);
	}

	return Buffer.concat([header, masked]);
}

/** Encode a close frame (opcode 0x08) with optional status code. */
function encodeCloseFrame(code = 1000): Buffer {
	const mask = randomBytes(4);
	const payload = Buffer.alloc(2);
	payload.writeUInt16BE(code, 0);

	const header = Buffer.alloc(6);
	header[0] = 0x88; // FIN + close opcode
	header[1] = 0x80 | 2; // MASK bit + 2-byte payload
	mask.copy(header, 2);

	const masked = Buffer.alloc(2);
	masked[0] = (payload[0] ?? 0) ^ (mask[0] ?? 0);
	masked[1] = (payload[1] ?? 0) ^ (mask[1] ?? 0);

	return Buffer.concat([header, masked]);
}

/** Encode a pong frame echoing the ping payload. */
function encodePongFrame(payload: Buffer): Buffer {
	const mask = randomBytes(4);
	const len = payload.length;

	let header: Buffer;
	if (len < 126) {
		header = Buffer.alloc(6);
		header[0] = 0x8a; // FIN + pong opcode
		header[1] = 0x80 | len;
		mask.copy(header, 2);
	} else {
		// Ping payloads > 125 bytes are unusual but handle gracefully
		header = Buffer.alloc(8);
		header[0] = 0x8a;
		header[1] = 0x80 | 126;
		header.writeUInt16BE(len, 2);
		mask.copy(header, 4);
	}

	const masked = Buffer.alloc(len);
	for (let i = 0; i < len; i++) {
		masked[i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0);
	}

	return Buffer.concat([header, masked]);
}

/**
 * Decoded frame from the server. Server frames are unmasked per RFC 6455.
 * Returns null if the buffer doesn't contain a complete frame yet.
 */
interface DecodedFrame {
	opcode: number;
	payload: Buffer;
	totalBytes: number; // Total frame size consumed from the buffer
}

function decodeFrame(buf: Buffer): DecodedFrame | null {
	if (buf.length < 2) return null;

	const firstByte = buf[0] ?? 0;
	const secondByte = buf[1] ?? 0;
	const opcode = firstByte & 0x0f;
	const isMasked = (secondByte & 0x80) !== 0;
	let payloadLen = secondByte & 0x7f;
	let offset = 2;

	if (payloadLen === 126) {
		if (buf.length < 4) return null;
		payloadLen = buf.readUInt16BE(2);
		offset = 4;
	} else if (payloadLen === 127) {
		if (buf.length < 10) return null;
		const hi = buf.readUInt32BE(2);
		const lo = buf.readUInt32BE(6);
		payloadLen = hi * 0x1_0000_0000 + lo;
		offset = 10;
	}

	if (isMasked) offset += 4; // Skip mask key (unusual for server frames)
	if (buf.length < offset + payloadLen) return null;

	let payload: Buffer;
	if (isMasked) {
		const maskOffset = offset - 4;
		payload = Buffer.alloc(payloadLen);
		for (let i = 0; i < payloadLen; i++) {
			payload[i] = (buf[offset + i] ?? 0) ^ (buf[maskOffset + (i % 4)] ?? 0);
		}
	} else {
		payload = buf.subarray(offset, offset + payloadLen);
	}

	return { opcode, payload, totalBytes: offset + payloadLen };
}

// ---------------------------------------------------------------------------
// WebSocket connection via raw TCP + manual HTTP upgrade
// ---------------------------------------------------------------------------

/**
 * Establish a WebSocket connection using a raw TCP socket and manual HTTP
 * upgrade handshake. Bun's node:http does not fire the `upgrade` event
 * correctly (it routes HTTP 101 to the response callback), so we bypass
 * it entirely and speak HTTP/1.1 directly on the socket.
 */
function connectWebSocket(url: string, connectTimeoutMs: number): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const parsed = new URL(url);
		const host = parsed.hostname;
		const port = Number(parsed.port) || 80;
		const path = (parsed.pathname || "/") + parsed.search;
		const key = randomBytes(16).toString("base64");

		let settled = false;
		const timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				socket.destroy();
				reject(new Error("WebSocket connection timeout"));
			}
		}, connectTimeoutMs);

		const socket = netConnect({ host, port }, () => {
			// Send the HTTP upgrade request
			const request = [
				`GET ${path} HTTP/1.1`,
				`Host: ${host}:${port}`,
				"Upgrade: websocket",
				"Connection: Upgrade",
				`Sec-WebSocket-Key: ${key}`,
				"Sec-WebSocket-Version: 13",
				"",
				"",
			].join("\r\n");
			socket.write(request);
		});

		// Buffer for the HTTP upgrade response
		let responseBuf = Buffer.alloc(0);

		function onData(chunk: Buffer): void {
			responseBuf = Buffer.concat([responseBuf, chunk]);
			const responseStr = responseBuf.toString("utf-8");

			// Wait for the end of HTTP headers (\r\n\r\n)
			const headerEnd = responseStr.indexOf("\r\n\r\n");
			if (headerEnd === -1) return; // Headers not complete yet

			// Remove the data listener — subsequent data is WebSocket frames
			socket.removeListener("data", onData);

			// Parse the status line
			const statusLine = responseStr.slice(0, responseStr.indexOf("\r\n"));
			if (!statusLine.includes("101")) {
				settled = true;
				clearTimeout(timer);
				socket.destroy();
				reject(new Error(`WebSocket upgrade failed: ${statusLine}`));
				return;
			}

			// Note: Sec-WebSocket-Accept validation is skipped because Bun's
			// node:crypto createHash("sha1") produces incorrect results for the
			// RFC 6455 accept key computation. Since we connect to a local Codex
			// App Server only, the 101 status code is sufficient confirmation.

			settled = true;
			clearTimeout(timer);

			// If there's leftover data after the headers, push it back
			// so the frame parser can process it
			const headerBytes = Buffer.byteLength(responseStr.slice(0, headerEnd + 4), "utf-8");
			if (responseBuf.length > headerBytes) {
				socket.unshift(responseBuf.subarray(headerBytes));
			}

			resolve(socket);
		}

		socket.on("data", onData);

		socket.on("error", (err) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				reject(new Error(`WebSocket connection failed: ${err.message}`));
			}
		});

		socket.on("close", () => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				reject(new Error("WebSocket connection closed during handshake"));
			}
		});
	});
}

// ---------------------------------------------------------------------------
// RPC client
// ---------------------------------------------------------------------------

export async function createRpcClient(
	url: string,
	opts?: { timeoutMs?: number },
): Promise<RpcClient> {
	const timeoutMs = opts?.timeoutMs ?? 30_000;
	let nextId = 1;
	const pending = new Map<number | string, PendingRequest>();
	const notificationHandlers: Array<(method: string, params: unknown) => void> = [];
	const requestHandlers: RequestHandler[] = [];

	let isClosed = false;

	// Connect via node:http upgrade (works around Bun native WebSocket incompatibility)
	const socket = await connectWebSocket(url, 10_000);

	// Frame reassembly buffer
	let recvBuf = Buffer.alloc(0);

	function handleMessage(text: string): void {
		const data = JSON.parse(text) as Record<string, unknown>;

		const hasId = "id" in data && data.id != null;
		const hasMethod = "method" in data && typeof data.method === "string";

		// Server-initiated request (has BOTH id and method).
		// Must be checked BEFORE responses since both have an id field.
		if (hasId && hasMethod) {
			const incomingId = data.id as number | string;
			const method = data.method as string;

			// Dispatch to request handlers and send response.
			(async () => {
				try {
					let result: unknown;
					for (const handler of requestHandlers) {
						const handlerResult = await handler(method, data.params);
						if (handlerResult !== null && handlerResult !== undefined) {
							result = handlerResult;
							break;
						}
					}
					socket.write(
						encodeTextFrame(
							JSON.stringify({
								jsonrpc: "2.0",
								id: incomingId,
								result: result ?? null,
							}),
						),
					);
				} catch (err) {
					socket.write(
						encodeTextFrame(
							JSON.stringify({
								jsonrpc: "2.0",
								id: incomingId,
								error: {
									code: -32603,
									message: err instanceof Error ? err.message : "Internal error",
								},
							}),
						),
					);
				}
			})().catch((err: unknown) => {
				console.error("[rpc-client] request handler error:", err);
			});

			// Also dispatch to notification handlers for observability
			for (const handler of notificationHandlers) {
				handler(method, data.params);
			}
			return;
		}

		// Response to our outgoing request (has id, no method)
		if (hasId && !hasMethod) {
			const req = pending.get(data.id as number | string);
			if (!req) return;
			pending.delete(data.id as number | string);
			clearTimeout(req.timer);
			if (data.error) {
				const err = data.error as { message?: string };
				req.reject(new Error(err.message ?? "JSON-RPC error"));
			} else {
				req.resolve(data.result);
			}
			return;
		}

		// Notification (no id, has method)
		if (hasMethod) {
			for (const handler of notificationHandlers) {
				handler(data.method as string, data.params);
			}
		}
	}

	socket.on("data", (chunk: Buffer) => {
		recvBuf = Buffer.concat([recvBuf, chunk]);

		// Process all complete frames in the buffer
		let frame: DecodedFrame | null = decodeFrame(recvBuf);
		while (frame !== null) {
			recvBuf = recvBuf.subarray(frame.totalBytes);

			if (frame.opcode === 0x01) {
				// Text frame
				handleMessage(frame.payload.toString("utf-8"));
			} else if (frame.opcode === 0x08) {
				// Close frame
				socket.write(encodeCloseFrame());
				socket.end();
			} else if (frame.opcode === 0x09) {
				// Ping — respond with pong
				socket.write(encodePongFrame(frame.payload));
			}
			// Ignore pong (0x0A) and other opcodes

			frame = decodeFrame(recvBuf);
		}
	});

	socket.on("close", () => {
		isClosed = true;
		for (const [, req] of pending) {
			clearTimeout(req.timer);
			req.reject(new Error("WebSocket closed"));
		}
		pending.clear();
	});

	socket.on("error", () => {
		// Error events are often followed by close events.
		// The close handler handles cleanup; this prevents unhandled errors.
	});

	return {
		request(method, params) {
			if (isClosed) {
				return Promise.reject(new Error(`WebSocket closed, cannot send: ${method}`));
			}
			return new Promise((resolve, reject) => {
				const id = nextId++;
				const timer = setTimeout(() => {
					pending.delete(id);
					reject(new Error(`RPC timeout: ${method}`));
				}, timeoutMs);

				pending.set(id, { resolve, reject, timer });

				const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method };
				if (params) msg.params = params;
				socket.write(encodeTextFrame(JSON.stringify(msg)));
			});
		},

		onNotification(handler) {
			notificationHandlers.push(handler);
		},

		onRequest(handler) {
			requestHandlers.push(handler);
		},

		get closed() {
			return isClosed;
		},

		close() {
			isClosed = true;
			for (const [, req] of pending) {
				clearTimeout(req.timer);
				req.reject(new Error("Client closed"));
			}
			pending.clear();
			try {
				socket.write(encodeCloseFrame());
			} catch {
				// Socket may already be destroyed
			}
			socket.end();
		},
	};
}

/**
 * Attempt to connect to the RPC server with exponential backoff.
 *
 * Retries up to `maxAttempts` times (default 3). Between attempts, waits
 * `baseDelayMs * 2^attempt` milliseconds (default base: 2000ms).
 * Throws the last error if all attempts fail.
 */
export async function createRpcClientWithRetry(
	url: string,
	opts?: { timeoutMs?: number; maxAttempts?: number; baseDelayMs?: number },
): Promise<RpcClient> {
	const maxAttempts = opts?.maxAttempts ?? 3;
	const baseDelayMs = opts?.baseDelayMs ?? 2000;
	let lastError: Error = new Error("No attempts made");

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		if (attempt > 0) {
			const delayMs = baseDelayMs * 2 ** (attempt - 1);
			await Bun.sleep(delayMs);
		}
		try {
			return await createRpcClient(url, { timeoutMs: opts?.timeoutMs });
		} catch (err) {
			lastError = err instanceof Error ? err : new Error(String(err));
		}
	}

	throw lastError;
}
