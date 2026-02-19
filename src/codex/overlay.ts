import { join, resolve } from "node:path";
import {
	formatCanSpawn,
	formatConstraints,
	formatFileScope,
	formatMulchDomains,
	formatMulchExpertise,
	formatQualityGates,
} from "../agents/overlay";
import type { OverlayConfig } from "../types";

function getTemplatePath(): string {
	// src/codex/overlay.ts -> repo root is ../../
	return resolve(join(import.meta.dir, "../../templates/overlay.md.tmpl"));
}

/**
 * Generate a per-worker AGENTS.md overlay from the Codex-specific template.
 *
 * Reads `templates/agents-overlay.md.tmpl` and replaces all `{{VARIABLE}}`
 * placeholders with values derived from the provided config.
 *
 * Unlike the Claude overlay (writeOverlay in src/agents/overlay.ts), this
 * variant targets AGENTS.md at the worktree root — the standard location
 * for Codex agent instructions — and does not reference Claude Code-specific
 * flags or paths such as `.claude/CLAUDE.md` or `--dangerously-skip-permissions`.
 *
 * @param config - The overlay configuration for this agent/task
 * @returns The rendered overlay content as a string
 * @throws {Error} If the template file cannot be found or read
 */
export async function generateAgentsOverlay(config: OverlayConfig): Promise<string> {
	const templatePath = getTemplatePath();
	const file = Bun.file(templatePath);

	if (!(await file.exists())) {
		throw new Error(`AGENTS.md template not found at ${templatePath}`);
	}

	let content: string;
	try {
		content = await file.text();
	} catch (err) {
		throw new Error(
			`Failed to read AGENTS.md template: ${templatePath}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	const specInstruction = config.specPath
		? "Read your task spec at the path above. It contains the full description of\nwhat you need to build or review."
		: "No task spec was provided. Check your mail or ask your parent agent for details.";

	const replacements: Record<string, string> = {
		"{{BASE_DEFINITION}}": config.baseDefinition,
		"{{AGENT_NAME}}": config.agentName,
		"{{BEAD_ID}}": config.beadId,
		"{{SPEC_PATH}}": config.specPath ?? "No spec file provided",
		"{{BRANCH_NAME}}": config.branchName,
		"{{WORKTREE_PATH}}": config.worktreePath,
		"{{PARENT_AGENT}}": config.parentAgent ?? "orchestrator",
		"{{DEPTH}}": String(config.depth),
		"{{FILE_SCOPE}}": formatFileScope(config.fileScope),
		"{{MULCH_DOMAINS}}": formatMulchDomains(config.mulchDomains),
		"{{MULCH_EXPERTISE}}": formatMulchExpertise(config.mulchExpertise),
		"{{CAN_SPAWN}}": formatCanSpawn(config),
		"{{QUALITY_GATES}}": formatQualityGates(config),
		"{{CONSTRAINTS}}": formatConstraints(config),
		"{{SPEC_INSTRUCTION}}": specInstruction,
	};

	let result = content;
	for (const [placeholder, value] of Object.entries(replacements)) {
		// Replace all occurrences — some placeholders appear multiple times
		while (result.includes(placeholder)) {
			result = result.replace(placeholder, value);
		}
	}

	return result;
}

/**
 * Generate the AGENTS.md overlay and write it to `{worktreePath}/AGENTS.md`.
 *
 * Includes a safety guard that prevents writing to the canonical project root.
 * Agent overlays belong in worktrees, never at the orchestrator's root.
 *
 * @param worktreePath - Absolute path to the agent's git worktree
 * @param config - The overlay configuration for this agent/task
 * @param canonicalRoot - Absolute path to the canonical project root (for guard check)
 * @throws {Error} If worktreePath resolves to the canonical project root, or if
 *   the file cannot be written
 */
export async function writeAgentsOverlay(
	worktreePath: string,
	config: OverlayConfig,
	canonicalRoot: string,
): Promise<void> {
	if (resolve(worktreePath) === resolve(canonicalRoot)) {
		throw new Error(`Cannot write AGENTS.md overlay to canonical root: ${worktreePath}`);
	}

	const content = await generateAgentsOverlay(config);
	const overlayPath = join(worktreePath, "AGENTS.md");

	try {
		await Bun.write(overlayPath, content);
	} catch (err) {
		throw new Error(
			`Failed to write AGENTS.md to: ${overlayPath}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}
