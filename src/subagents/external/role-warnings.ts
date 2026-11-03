import { splitShellWords } from "../../shared/shell-words.js";

/**
 * Non-fatal external-role warnings (spec 042 D4/D10, spec 066 D6). The role still loads.
 * This file stays free of discovery and harness imports so `discovery.ts` can call it without a cycle.
 */

export interface ExternalRoleWarningInput {
	/** Role filename, so a warning can be traced back to the file that produced it. */
	entryName: string;
	harness: string;
	command: string;
	mutates: "read" | "write";
	/** Resolved memory mode. Anything other than `none` discloses desk memory to the external process. */
	memory: string;
	/** True when frontmatter `model` is set. External models are never taken from the invocation. */
	modelConfigured: boolean;
}

const FORCE_TOKENS = new Set(["-f", "--force", "--yolo"]);

function hasWorktreeToken(token: string): boolean {
	return token === "--worktree" || token === "-w" || token.startsWith("--worktree=");
}

/**
 * Cursor print mode does not write files unless the command itself opts in, and a worktree flag
 * writes somewhere the workspace lease does not cover. Token-based, not a substring search: a path
 * that happens to contain `--force` is not a permission flag.
 */
function cursorCommandWarnings(input: ExternalRoleWarningInput): string[] {
	if (input.harness !== "cursor-cli") return [];
	const tokens = splitShellWords(input.command);
	const hasForce = tokens.some((token) => FORCE_TOKENS.has(token));
	const warnings: string[] = [];
	if (input.mutates === "write" && !hasForce) {
		warnings.push(
			`${input.entryName}: print mode does not write changes to files unless command includes -f, --force, or --yolo`,
		);
	}
	if (input.mutates === "read" && hasForce) {
		warnings.push(
			`${input.entryName}: command includes -f, --force, or --yolo, so the CLI can modify files and the workspace write lock will not stop it`,
		);
	}
	if (tokens.some(hasWorktreeToken)) {
		warnings.push(
			`${input.entryName}: --worktree writes under ~/.cursor/worktrees/, outside the delegation working directory, so the workspace write lock does not cover those files`,
		);
	}
	return warnings;
}

/** Join every applicable warning. An unlucky combination must not hide one of them. */
export function externalRoleWarning(input: ExternalRoleWarningInput): string | undefined {
	const warnings: string[] = [];
	if (input.memory !== "none") {
		warnings.push(
			`${input.entryName}: memory: ${input.memory} sends the desk memory index / journal content to this external process`,
		);
	}
	// Substring, matching the historical discovery check: `$MODEL` is a placeholder, not a flag,
	// and may sit inside a larger token (`--model=$MODEL`). `$EFFORT` has no equivalent check
	// because thinkingLevel can be supplied per invocation.
	if (input.command.includes("$MODEL") && !input.modelConfigured) {
		warnings.push(
			`${input.entryName}: command references $MODEL but no "model" is configured; that argv token will be dropped on every dispatch`,
		);
	}
	warnings.push(...cursorCommandWarnings(input));
	return warnings.length > 0 ? warnings.join("; ") : undefined;
}
