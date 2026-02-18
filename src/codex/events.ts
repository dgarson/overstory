// src/codex/events.ts
import type { CodexItemType, DeltaBuffer } from "./types";

/** Map Codex item types to overstory canonical tool names */
export function normalizeToolName(itemType: CodexItemType, fileChangeKind?: string): string {
	switch (itemType) {
		case "commandExecution":
			return "Bash";
		case "fileChange":
			return fileChangeKind === "add" ? "Write" : "Edit";
		case "mcpToolCall":
			return "McpToolCall";
		case "webSearch":
			return "WebSearch";
		case "agentMessage":
			return "AgentMessage";
		case "reasoning":
			return "Reasoning";
		case "contextCompaction":
			return "Compaction";
		default:
			return String(itemType);
	}
}

/** Build event record from item/started notification */
export function normalizeItemStarted(params: {
	agentName: string;
	sessionId: string;
	runId: string | null;
	itemId: string;
	itemType: CodexItemType;
	data?: Record<string, unknown>;
}): {
	eventType: string;
	agentName: string;
	sessionId: string;
	runId: string | null;
	toolName: string;
	toolArgs: string | null;
	level: string;
	data: string | null;
} {
	const toolName = normalizeToolName(params.itemType);
	let toolArgs: string | null = null;

	if (params.data) {
		const command = params.data.command as string | undefined;
		const path = params.data.path as string | undefined;
		toolArgs = command
			? `bash: ${String(command).slice(0, 200)}`
			: path
				? `${toolName.toLowerCase()}: ${path}`
				: JSON.stringify(params.data).slice(0, 200);
	}

	return {
		eventType: "tool_start",
		agentName: params.agentName,
		sessionId: params.sessionId,
		runId: params.runId,
		toolName,
		toolArgs,
		level: "info",
		data: params.data ? JSON.stringify({ itemId: params.itemId, ...params.data }) : null,
	};
}

/** Build event record from item/completed notification + flushed delta buffer */
export function normalizeItemCompleted(params: {
	agentName: string;
	sessionId: string;
	runId: string | null;
	itemId: string;
	itemType: CodexItemType;
	status: string;
	data?: Record<string, unknown>;
	deltaOutput?: { output: string; totalBytes: number; truncated: boolean } | null;
	durationMs: number | null;
}): {
	eventType: string;
	agentName: string;
	sessionId: string;
	runId: string | null;
	toolName: string;
	toolArgs: string | null;
	toolDurationMs: number | null;
	level: string;
	data: string | null;
} {
	const kind = params.data?.kind as string | undefined;
	const toolName = normalizeToolName(params.itemType, kind);

	let toolArgs: string | null = null;
	if (params.data) {
		const command = params.data.command as string | undefined;
		const path = params.data.path as string | undefined;
		toolArgs = command
			? `bash: ${String(command).slice(0, 200)}`
			: path
				? `${toolName.toLowerCase()}: ${path}`
				: JSON.stringify(params.data).slice(0, 200);
	}

	const eventData: Record<string, unknown> = {
		itemId: params.itemId,
		status: params.status,
	};
	if (params.data) Object.assign(eventData, params.data);
	if (params.deltaOutput) {
		eventData.outputSize = params.deltaOutput.totalBytes;
		eventData.outputTruncated = params.deltaOutput.truncated;
		eventData.outputPreview = params.deltaOutput.output.slice(0, 1000);
	}

	return {
		eventType: "tool_end",
		agentName: params.agentName,
		sessionId: params.sessionId,
		runId: params.runId,
		toolName,
		toolArgs,
		toolDurationMs: params.durationMs,
		level: params.status === "failed" ? "error" : "info",
		data: JSON.stringify(eventData),
	};
}

/** Delta buffer manager — accumulates outputDelta events per item */
export function createDeltaBufferManager(maxBytes: number) {
	const buffers = new Map<string, DeltaBuffer>();

	return {
		start(itemId: string, itemType: CodexItemType, startedAt: string): void {
			buffers.set(itemId, {
				itemId,
				itemType,
				startedAt,
				outputChunks: [],
				totalBytes: 0,
			});
		},

		appendDelta(itemId: string, delta: string): void {
			const buf = buffers.get(itemId);
			if (!buf) return;
			buf.totalBytes += delta.length;
			if (buf.totalBytes <= maxBytes) {
				buf.outputChunks.push(delta);
			}
		},

		flush(
			itemId: string,
		): { output: string; totalBytes: number; truncated: boolean; startedAt: string } | null {
			const buf = buffers.get(itemId);
			if (!buf) return null;
			buffers.delete(itemId);
			const output = buf.outputChunks.join("");
			return {
				output,
				totalBytes: buf.totalBytes,
				truncated: buf.totalBytes > maxBytes,
				startedAt: buf.startedAt,
			};
		},

		get size(): number {
			return buffers.size;
		},
	};
}
