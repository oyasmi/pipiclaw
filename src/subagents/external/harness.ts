import type { UsageTotals } from "../../shared/types.js";
import type { SubAgentThinkingLevel } from "../discovery.js";

/**
 * The harness adapter seam (spec 040, D4). Every external run is reduced to the same process
 * model (D3: one prompt, one short-lived process); what differs between `claude-code`,
 * `codex-cli`, and `exec` is only argv assembly and stdout parsing, and that is exactly what this
 * interface covers. It carries no state machine of its own — `runs.ts` owns that.
 */

export interface ExternalInvocationInput {
	/** The role's `command`, already shell-word-split (D4) — never re-parsed here, never shelled out. */
	argv: string[];
	/** The harness's own model string (`SubAgentConfig.externalModelRef`), passed through unresolved. */
	model?: string;
	thinkingLevel?: SubAgentThinkingLevel;
	artifactDir: string;
	/** Path to the stdin prompt file (D1 layout: `<artifactDir>/prompt.txt`). */
	promptFile: string;
	/** Path to the role's system-prompt file (`<artifactDir>/system-prompt.txt`), for harnesses
	 *  that reference it by flag (e.g. claude-code's `--append-system-prompt-file`). */
	systemPromptFile: string;
	/** Set when this invocation continues an earlier run (`subagent_manage op=follow_up`, D6). */
	resumeSessionId?: string;
}

export interface BuildInvocationResult {
	executable: string;
	args: string[];
	/** Whether this harness can be continued later via `resumeSessionId` (claude-code/codex-cli). */
	resumable: boolean;
	/**
	 * claude-code only (D4): a session id it picked and passed via `--session-id` *before* running,
	 * so `resume` does not depend on first successfully parsing a `result` event out of a run that
	 * might crash before producing one. The orchestrator persists this immediately after spawn,
	 * not just at settlement.
	 */
	presetSessionId?: string;
}

export type ExternalProtocolStatus = "completed" | "failed" | "absent" | "unparsable";

export interface ExternalOutcome {
	finalText: string;
	/** Whether a protocol terminal event was observed at all. `false` ⇒ status can never be `completed` (D4). */
	terminalSeen: boolean;
	protocolStatus: ExternalProtocolStatus;
	exitCode?: number;
	/** The harness's own session/thread id, captured for a later `resume` even if this run failed midway. */
	sessionId?: string;
	usage?: Partial<UsageTotals>;
	/** `exec` is always false: it has no token accounting at all. */
	usageKnown: boolean;
	/** `codex-cli`/`exec` are always false: neither reports a cost field. */
	costKnown: boolean;
	stderrTail?: string;
	errorMessage?: string;
}

export interface ParseOutcomeInput {
	/** Raw contents of `events.jsonl` (structured harnesses) or captured stdout (`exec`). */
	eventsText: string;
	/** `undefined` when the process was killed by a signal rather than exiting normally. */
	exitCode?: number;
	stderrTail?: string;
}

export interface ExternalHarness {
	readonly id: "claude-code" | "codex-cli" | "exec";
	/** Assemble argv. The command line is never joined into a single shell string (D4). */
	buildInvocation(input: ExternalInvocationInput): BuildInvocationResult;
	/** Parse stdout into a unified outcome. Must never throw — a parse failure degrades to
	 *  `protocolStatus: "unparsable"`, not an exception (D4). */
	parseOutcome(input: ParseOutcomeInput): ExternalOutcome;
}

/**
 * The D4 status table, shared by the live post-exit path and restart reconciliation (D10.3) so
 * both judge a run identically. `exec` is the table's explicit exception (D4/D9): it has no
 * protocol terminal at all, so its own `parseOutcome` already folds the exit code into
 * `protocolStatus` directly — `terminalSeen` stays `false` even on success, so it must not be
 * checked here for that one harness.
 */
export function classifyExternalOutcome(
	harnessId: ExternalHarness["id"],
	outcome: ExternalOutcome,
): { status: "completed" | "failed"; failureReason?: string } {
	if (harnessId === "exec") {
		return outcome.protocolStatus === "completed"
			? { status: "completed" }
			: { status: "failed", failureReason: outcome.errorMessage ?? `exec exited with code ${outcome.exitCode}` };
	}
	if (outcome.terminalSeen && outcome.protocolStatus === "completed") {
		return { status: "completed" };
	}
	if (outcome.protocolStatus === "failed") {
		return { status: "failed", failureReason: outcome.errorMessage ?? "The harness reported a protocol failure." };
	}
	if (outcome.exitCode === 0 && outcome.protocolStatus === "absent") {
		return {
			status: "failed",
			failureReason: "The process exited normally but no protocol terminal event was observed.",
		};
	}
	if (outcome.protocolStatus === "unparsable") {
		return { status: "failed", failureReason: outcome.errorMessage ?? "The harness output could not be parsed." };
	}
	return {
		status: "failed",
		failureReason: outcome.errorMessage ?? "The process ended without a recognized terminal state.",
	};
}

/** Flags a `command` frontmatter value can already carry, in which case a harness must not append the same-named one (D4). */
export interface ExistingFlags {
	model: boolean;
	effort: boolean;
}

const MODEL_FLAG_PATTERN = /^(--model|-m)$/;
const EFFORT_FLAG_PATTERN = /^(--effort|--thinking)$/;
const CODEX_CONFIG_FLAG_PATTERN = /^(-c|--config)$/;
const CODEX_MODEL_VALUE_PREFIX = "model=";
const CODEX_EFFORT_VALUE_PREFIX = "model_reasoning_effort=";

/** Which flags the user's own `command` already spells out, so a harness never injects a duplicate (D4). */
export function detectExistingFlags(argv: string[]): ExistingFlags {
	let model = false;
	let effort = false;
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (MODEL_FLAG_PATTERN.test(token)) model = true;
		if (EFFORT_FLAG_PATTERN.test(token)) effort = true;
		if (CODEX_CONFIG_FLAG_PATTERN.test(token)) {
			const value = argv[i + 1];
			if (value?.startsWith(CODEX_MODEL_VALUE_PREFIX)) model = true;
			if (value?.startsWith(CODEX_EFFORT_VALUE_PREFIX)) effort = true;
		}
		if (token.startsWith("--model=") || token.startsWith("-m=")) model = true;
		if (token.startsWith("--effort=") || token.startsWith("--thinking=")) effort = true;
		if (token.startsWith("-c=") || token.startsWith("--config=")) {
			const value = token.slice(token.indexOf("=") + 1);
			if (value.startsWith(CODEX_MODEL_VALUE_PREFIX)) model = true;
			if (value.startsWith(CODEX_EFFORT_VALUE_PREFIX)) effort = true;
		}
	}
	return { model, effort };
}

const PLACEHOLDERS = ["$MODEL", "$EFFORT", "$PROMPT_FILE", "$SYSTEM_PROMPT_FILE"] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];

/**
 * Expand `$MODEL`/`$EFFORT`/`$PROMPT_FILE`/`$SYSTEM_PROMPT_FILE` wherever they appear in argv
 * (D4). Returns which placeholders were actually found, so a harness knows whether it still needs
 * to *append* the corresponding flag (a placeholder present ⇒ never append; absent ⇒ append per
 * the harness's own rule).
 */
export function expandPlaceholders(
	argv: string[],
	values: Partial<Record<Placeholder, string>>,
): { argv: string[]; used: Set<Placeholder> } {
	const used = new Set<Placeholder>();
	const expanded = argv.map((token) => {
		let result = token;
		for (const placeholder of PLACEHOLDERS) {
			const value = values[placeholder];
			if (value !== undefined && result.includes(placeholder)) {
				used.add(placeholder);
				result = result.split(placeholder).join(value);
			}
		}
		return result;
	});
	return { argv: expanded, used };
}
