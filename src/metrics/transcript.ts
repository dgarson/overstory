/**
 * Parser for Claude Code transcript JSONL files.
 *
 * Extracts token usage data from assistant-type entries in transcript files
 * at ~/.claude/projects/{project-slug}/{session-id}.jsonl.
 *
 * Each assistant entry contains per-turn usage:
 * {
 *   "type": "assistant",
 *   "message": {
 *     "model": "claude-opus-4-6",
 *     "usage": {
 *       "input_tokens": 3,
 *       "output_tokens": 9,
 *       "cache_read_input_tokens": 19401,
 *       "cache_creation_input_tokens": 9918
 *     }
 *   }
 * }
 */

export interface TranscriptUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	modelUsed: string | null;
}

/** Pricing per million tokens (USD). */
interface ModelPricing {
	inputPerMTok: number;
	outputPerMTok: number;
	cacheReadPerMTok: number;
	cacheCreationPerMTok: number;
}

/**
 * Hardcoded pricing (USD per million tokens) for known models across providers.
 *
 * Matched by substring against the lowercase model name. Object.entries preserves
 * insertion order, so more-specific keys MUST come before any key that is a
 * substring of them (e.g. "o1-mini" before "o1", "gpt-5-mini" before "gpt-5").
 *
 * cacheCreationPerMTok is 0 for non-Anthropic providers — those APIs handle
 * cache storage server-side with no separate write charge.
 *
 * Sources (Feb 2026):
 *   Anthropic — https://anthropic.com/pricing
 *   OpenAI    — https://openai.com/api/pricing/
 *   Z.AI      — https://docs.z.ai/guides/overview/pricing
 *   MiniMax   — https://platform.minimax.io/docs/guides/pricing
 */
const MODEL_PRICING: Record<string, ModelPricing> = {
	// ── Anthropic Claude ──────────────────────────────────────────────────────
	opus: { inputPerMTok: 15, outputPerMTok: 75, cacheReadPerMTok: 1.5, cacheCreationPerMTok: 3.75 },
	sonnet: { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheCreationPerMTok: 0.75 },
	haiku: { inputPerMTok: 0.8, outputPerMTok: 4, cacheReadPerMTok: 0.08, cacheCreationPerMTok: 0.2 },

	// ── OpenAI — O-series reasoning (specific variants before base) ───────────
	"o1-mini": {
		inputPerMTok: 1.1,
		outputPerMTok: 4.4,
		cacheReadPerMTok: 0.55,
		cacheCreationPerMTok: 0,
	},
	o1: { inputPerMTok: 15, outputPerMTok: 60, cacheReadPerMTok: 7.5, cacheCreationPerMTok: 0 },
	"o3-mini": {
		inputPerMTok: 1.1,
		outputPerMTok: 4.4,
		cacheReadPerMTok: 0.55,
		cacheCreationPerMTok: 0,
	},
	o3: { inputPerMTok: 2, outputPerMTok: 8, cacheReadPerMTok: 1, cacheCreationPerMTok: 0 },
	"o4-mini": {
		inputPerMTok: 1.1,
		outputPerMTok: 4.4,
		cacheReadPerMTok: 0.55,
		cacheCreationPerMTok: 0,
	},

	// ── OpenAI — Codex app-server models (most-specific first) ───────────────
	// Substring containment chain: spark ⊃ gpt-5.3-codex ⊃ gpt-5.3 ⊃ codex ⊃ gpt-5
	"gpt-5.3-codex-spark": {
		inputPerMTok: 1.25,
		outputPerMTok: 10,
		cacheReadPerMTok: 0.13,
		cacheCreationPerMTok: 0,
	},
	"gpt-5.3-codex": {
		inputPerMTok: 1.25,
		outputPerMTok: 10,
		cacheReadPerMTok: 0.13,
		cacheCreationPerMTok: 0,
	},
	"gpt-5.3": {
		inputPerMTok: 1.25,
		outputPerMTok: 10,
		cacheReadPerMTok: 0.13,
		cacheCreationPerMTok: 0,
	},
	codex: { inputPerMTok: 1.25, outputPerMTok: 10, cacheReadPerMTok: 0.13, cacheCreationPerMTok: 0 },

	// ── OpenAI — GPT-5 family (specific variants before "gpt-5") ─────────────
	"gpt-5.2": {
		inputPerMTok: 1.75,
		outputPerMTok: 14,
		cacheReadPerMTok: 0.18,
		cacheCreationPerMTok: 0,
	},
	"gpt-5-mini": {
		inputPerMTok: 0.25,
		outputPerMTok: 2,
		cacheReadPerMTok: 0.03,
		cacheCreationPerMTok: 0,
	},
	"gpt-5-nano": {
		inputPerMTok: 0.05,
		outputPerMTok: 0.4,
		cacheReadPerMTok: 0.01,
		cacheCreationPerMTok: 0,
	},
	"gpt-5": {
		inputPerMTok: 1.25,
		outputPerMTok: 10,
		cacheReadPerMTok: 0.13,
		cacheCreationPerMTok: 0,
	},

	// ── OpenAI — GPT-4 family (mini/nano before base, 4o-mini before 4o) ──────
	"gpt-4.1-mini": {
		inputPerMTok: 0.4,
		outputPerMTok: 1.6,
		cacheReadPerMTok: 0.1,
		cacheCreationPerMTok: 0,
	},
	"gpt-4.1-nano": {
		inputPerMTok: 0.1,
		outputPerMTok: 0.4,
		cacheReadPerMTok: 0.03,
		cacheCreationPerMTok: 0,
	},
	"gpt-4.1": { inputPerMTok: 2, outputPerMTok: 8, cacheReadPerMTok: 0.5, cacheCreationPerMTok: 0 },
	"4o-mini": {
		inputPerMTok: 0.15,
		outputPerMTok: 0.6,
		cacheReadPerMTok: 0.08,
		cacheCreationPerMTok: 0,
	},
	"4o": { inputPerMTok: 2.5, outputPerMTok: 10, cacheReadPerMTok: 1.25, cacheCreationPerMTok: 0 },

	// ── Z.AI (Zhipu GLM) — "glm-5-code" before "glm-5" ──────────────────────
	"glm-5-code": {
		inputPerMTok: 1.2,
		outputPerMTok: 5,
		cacheReadPerMTok: 0.3,
		cacheCreationPerMTok: 0,
	},
	"glm-5": { inputPerMTok: 1, outputPerMTok: 3.2, cacheReadPerMTok: 0.2, cacheCreationPerMTok: 0 },
	"glm-4.7": {
		inputPerMTok: 0.6,
		outputPerMTok: 2.2,
		cacheReadPerMTok: 0.11,
		cacheCreationPerMTok: 0,
	},

	// ── MiniMax M2.5 ──────────────────────────────────────────────────────────
	minimax: {
		inputPerMTok: 0.3,
		outputPerMTok: 1.1,
		cacheReadPerMTok: 0.15,
		cacheCreationPerMTok: 0,
	},
};

/**
 * Determine the pricing for a given model string.
 * Iterates MODEL_PRICING in insertion order, returning the first entry whose key
 * is a substring of the lowercase model name. Returns null if unrecognized.
 */
function getPricingForModel(model: string): ModelPricing | null {
	const lower = model.toLowerCase();
	for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
		if (lower.includes(key)) return pricing;
	}
	return null;
}

/**
 * Calculate the estimated cost in USD for a given usage and model.
 * Returns null if the model is unrecognized.
 */
export function estimateCost(usage: TranscriptUsage): number | null {
	if (usage.modelUsed === null) return null;

	const pricing = getPricingForModel(usage.modelUsed);
	if (pricing === null) return null;

	const inputCost = (usage.inputTokens / 1_000_000) * pricing.inputPerMTok;
	const outputCost = (usage.outputTokens / 1_000_000) * pricing.outputPerMTok;
	const cacheReadCost = (usage.cacheReadTokens / 1_000_000) * pricing.cacheReadPerMTok;
	const cacheCreationCost = (usage.cacheCreationTokens / 1_000_000) * pricing.cacheCreationPerMTok;

	return inputCost + outputCost + cacheReadCost + cacheCreationCost;
}

/**
 * Narrow an unknown value to determine if it looks like a transcript assistant entry.
 * Returns the usage fields if valid, or null otherwise.
 */
function extractUsageFromEntry(entry: unknown): {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	model: string | undefined;
} | null {
	if (typeof entry !== "object" || entry === null) return null;

	const obj = entry as Record<string, unknown>;
	if (obj.type !== "assistant") return null;

	const message = obj.message;
	if (typeof message !== "object" || message === null) return null;

	const msg = message as Record<string, unknown>;
	const usage = msg.usage;
	if (typeof usage !== "object" || usage === null) return null;

	const u = usage as Record<string, unknown>;

	return {
		inputTokens: typeof u.input_tokens === "number" ? u.input_tokens : 0,
		outputTokens: typeof u.output_tokens === "number" ? u.output_tokens : 0,
		cacheReadTokens: typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : 0,
		cacheCreationTokens:
			typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : 0,
		model: typeof msg.model === "string" ? msg.model : undefined,
	};
}

/**
 * Parse a Claude Code transcript JSONL file and aggregate token usage.
 *
 * Reads the file line by line, extracting usage data from each assistant
 * entry. Returns aggregated totals and the model from the first assistant turn.
 *
 * @param transcriptPath - Absolute path to the transcript JSONL file
 * @returns Aggregated usage data across all assistant turns
 */
export async function parseTranscriptUsage(transcriptPath: string): Promise<TranscriptUsage> {
	const file = Bun.file(transcriptPath);
	const text = await file.text();
	const lines = text.split("\n");

	const result: TranscriptUsage = {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		modelUsed: null,
	};

	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;

		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			// Skip malformed lines
			continue;
		}

		const usage = extractUsageFromEntry(parsed);
		if (usage === null) continue;

		result.inputTokens += usage.inputTokens;
		result.outputTokens += usage.outputTokens;
		result.cacheReadTokens += usage.cacheReadTokens;
		result.cacheCreationTokens += usage.cacheCreationTokens;

		// Capture model from first assistant turn
		if (result.modelUsed === null && usage.model !== undefined) {
			result.modelUsed = usage.model;
		}
	}

	return result;
}
