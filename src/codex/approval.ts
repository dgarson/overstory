// src/codex/approval.ts
import {
	COORDINATION_CAPABILITIES,
	COORDINATION_SAFE_PREFIXES,
	DANGEROUS_BASH_PATTERNS,
	NON_IMPLEMENTATION_CAPABILITIES,
	SAFE_BASH_PREFIXES,
} from "../agents/hooks-deployer";
import type { FileChange } from "./types";

export interface ApprovalContext {
	capability: string;
	agentName: string;
	worktreePath: string;
	fileScope: string[];
}

export type ApprovalResult =
	| { decision: "accept"; reason?: string }
	| { decision: "acceptForSession"; reason?: string }
	| { decision: "decline"; reason: string }
	| { decision: "escalate"; reason: string };

/** Scout-specific write exception: allowed to write specs via overstory spec write. */
const SCOUT_WRITE_PREFIXES = ["overstory spec write"];

/**
 * Evaluate a command execution approval request.
 * Mirrors the guard logic in hooks-deployer.ts but with structured input/output.
 *
 * Decision order:
 * 1. Safe prefix whitelist — auto-accept
 * 2. Coordination-capability extra prefixes (git add/commit) — auto-accept
 * 3. Scout write exception (overstory spec write) — auto-accept
 * 4. Dangerous bash patterns — decline
 * 5. Unknown — escalate to parent
 */
export function evaluateCommandApproval(command: string, ctx: ApprovalContext): ApprovalResult {
	const trimmed = command.trim();

	// 1. Build the effective safe-prefix list for this capability
	const allSafePrefixes = [...SAFE_BASH_PREFIXES];
	if (COORDINATION_CAPABILITIES.has(ctx.capability)) {
		allSafePrefixes.push(...COORDINATION_SAFE_PREFIXES);
	}
	if (ctx.capability === "scout") {
		allSafePrefixes.push(...SCOUT_WRITE_PREFIXES);
	}

	for (const prefix of allSafePrefixes) {
		if (trimmed.startsWith(prefix)) {
			return { decision: "accept" };
		}
	}

	// 2. Check dangerous patterns
	for (const pattern of DANGEROUS_BASH_PATTERNS) {
		if (new RegExp(pattern).test(trimmed)) {
			// Coordination capabilities may run git add/commit despite the danger pattern
			if (COORDINATION_CAPABILITIES.has(ctx.capability)) {
				if (trimmed.startsWith("git add") || trimmed.startsWith("git commit")) {
					return { decision: "accept" };
				}
			}
			return {
				decision: "decline",
				reason: `Blocked: command matches dangerous pattern for ${ctx.capability} agent: "${trimmed.slice(0, 60)}"`,
			};
		}
	}

	// 3. Unknown command — escalate to parent for approval
	return {
		decision: "escalate",
		reason: `Unknown command requires parent approval: ${trimmed.slice(0, 80)}`,
	};
}

/**
 * Evaluate a file change approval request.
 * Mirrors the path boundary + file scope guards from hooks-deployer.ts.
 *
 * Decision order:
 * 1. Non-implementation capability — always decline
 * 2. Path outside worktree — decline
 * 3. Path inside worktree but outside file scope — escalate
 * 4. All checks pass — accept
 */
export function evaluateFileChangeApproval(
	changes: ReadonlyArray<Pick<FileChange, "path" | "kind">>,
	ctx: ApprovalContext,
): ApprovalResult {
	// Non-implementation agents cannot modify files at all
	if (NON_IMPLEMENTATION_CAPABILITIES.has(ctx.capability)) {
		return {
			decision: "decline",
			reason: `${ctx.capability} agents cannot modify files`,
		};
	}

	for (const change of changes) {
		// Resolve absolute path (relative paths treated as relative to worktree)
		const resolved = change.path.startsWith("/")
			? change.path
			: `${ctx.worktreePath}/${change.path}`;

		// Must be within the worktree boundary
		if (!resolved.startsWith(ctx.worktreePath)) {
			return {
				decision: "decline",
				reason: `Path outside worktree: ${change.path}`,
			};
		}

		// Check file scope when scope is non-empty
		if (ctx.fileScope.length > 0) {
			const relative = resolved.slice(ctx.worktreePath.length + 1);
			if (!ctx.fileScope.includes(relative)) {
				return {
					decision: "escalate",
					reason: `File outside scope (${relative}), needs parent approval`,
				};
			}
		}
	}

	return { decision: "accept" };
}
