import { splitShellWords } from "../../shared/shell-words.js";

/**
 * Non-fatal external-role warnings (spec 042 D4/D10, spec 066 D6, spec 068 D7). The role still loads.
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

function hasAntigravityPrintToken(token: string): boolean {
	return (
		token === "-p" ||
		token === "--print" ||
		token === "--prompt" ||
		token.startsWith("--print=") ||
		token.startsWith("--prompt=")
	);
}

function hasAntigravityInteractiveToken(token: string): boolean {
	return token === "-i" || token === "--prompt-interactive" || token.startsWith("--prompt-interactive=");
}

function hasAntigravityConversationToken(token: string): boolean {
	return (
		token === "-c" ||
		token === "--continue" ||
		token === "--conversation" ||
		token.startsWith("--continue=") ||
		token.startsWith("--conversation=")
	);
}

function resolveEffectiveAntigravityMode(tokens: readonly string[]): string | undefined {
	let mode: string | undefined;
	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i]!;
		if (token === "--mode") {
			const next = tokens[i + 1];
			if (next !== undefined) {
				mode = next;
				i += 1;
			}
		} else if (token.startsWith("--mode=")) {
			mode = token.slice("--mode=".length);
		}
	}
	return mode;
}

function antigravityCommandWarnings(input: ExternalRoleWarningInput): string[] {
	if (input.harness !== "antigravity-cli") return [];
	const tokens = splitShellWords(input.command);
	const warnings: string[] = [];
	if (tokens.some(hasAntigravityPrintToken)) {
		warnings.push(
			`${input.entryName}: -p, --print, and --prompt consume a string argument and block piped stdin in agy; omit them so headless delegation reads from stdin`,
		);
	}
	if (tokens.some(hasAntigravityInteractiveToken)) {
		warnings.push(
			`${input.entryName}: -i and --prompt-interactive require a TTY and will fail or hang in a detached background delegation`,
		);
	}
	if (tokens.some(hasAntigravityConversationToken)) {
		warnings.push(
			`${input.entryName}: -c, --continue, and --conversation pin or share session context across runs and conflict with follow_up --conversation <id>; session resumption is managed by Pipiclaw`,
		);
	}

	const effectiveMode = resolveEffectiveAntigravityMode(tokens);
	const hasSkipPermissions = tokens.some(
		(token) => token === "--dangerously-skip-permissions" || token.startsWith("--dangerously-skip-permissions="),
	);
	const hasWriteMode = effectiveMode === "accept-edits" || effectiveMode === "auto";
	const hasAgentOrSettings = tokens.some(
		(token) =>
			token === "--agent" ||
			token.startsWith("--agent=") ||
			token === "--settings" ||
			token.startsWith("--settings="),
	);
	const hasSandbox = tokens.some((token) => token === "--sandbox" || token.startsWith("--sandbox="));

	if (input.mutates === "write" && effectiveMode === "plan") {
		warnings.push(
			`${input.entryName}: --mode plan adds planning instructions and may divert implementation work; it does not enforce read-only execution and headless plan review may auto-approve`,
		);
	}
	if (input.mutates === "write" && !hasSkipPermissions && !hasWriteMode && !hasAgentOrSettings) {
		warnings.push(
			`${input.entryName}: command declares no explicit permission source (--dangerously-skip-permissions, --mode accept-edits/auto, --agent, or --settings); actions requiring review under default request-review mode are denied in headless runs unless allowed by host permission rules`,
		);
	}
	if (input.mutates === "read" && (hasSkipPermissions || hasWriteMode)) {
		warnings.push(
			`${input.entryName}: command includes --dangerously-skip-permissions or --mode accept-edits/auto, so the CLI can modify files and the workspace write lock will not stop it`,
		);
	} else if (input.mutates === "read" && (effectiveMode === "plan" || hasSandbox)) {
		warnings.push(
			`${input.entryName}: --mode plan and --sandbox alone do not guarantee read-only execution in agy; verify CLI permission rules and host boundaries or declare mutates: write`,
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
	warnings.push(...antigravityCommandWarnings(input));
	return warnings.length > 0 ? warnings.join("; ") : undefined;
}
