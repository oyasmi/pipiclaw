import { isPlainObject } from "../../shared/type-guards.js";
import type { UsageTotals } from "../../usage/totals.js";
import type { RunHarness, SubAgentThinkingLevel } from "../run-record.js";

/**
 * The harness adapter seam (spec 040, D4). Every external run is reduced to the same process
 * model (D3: one prompt, one short-lived process); what differs between harnesses is argv
 * assembly, static role checks, capability flags, and stdout parsing — all owned here rather than
 * scattered as harness-name branches across discovery, tools, and orchestration.
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
	 *  that reference it by flag (e.g. claude-code's `--append-system-prompt-file`). Undefined
	 *  when the role declares no system prompt at all (a capability entry with an empty body):
	 *  the file is then not written, so no harness may reference a path that does not exist. */
	systemPromptFile?: string;
	/** Set when this invocation continues an earlier run (`subagent_run op=follow_up`, D6). */
	resumeSessionId?: string;
}

export interface BuildInvocationResult {
	executable: string;
	args: string[];
	/** Whether this harness can be continued later via `resumeSessionId`. */
	resumable: boolean;
	/**
	 * claude-code only (D4): a session id it picked and passed via `--session-id` *before* running,
	 * so `resume` does not depend on first successfully parsing a `result` event out of a run that
	 * might crash before producing one. The orchestrator persists this immediately after spawn,
	 * not just at settlement.
	 */
	presetSessionId?: string;
	/** Spec 042 D10: non-fatal invocation-time warnings (e.g. an argv token dropped because its
	 *  placeholder had no value) — persisted onto the run record so `/subagents show` can surface
	 *  them, since a silently-dropped flag can otherwise look identical to a role that never wanted it. */
	warnings?: string[];
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
	/** `cursor-cli`/`exec` are always false: neither reports tokens. */
	usageKnown: boolean;
	/** `cursor-cli`/`codex-cli`/`antigravity-cli`/`exec` are always false: none of them reports a cost field. */
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
	/** Spec 068 D8: expected resumed conversation id for harnesses that verify resumed sessions. */
	expectedResumeSessionId?: string;
}

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

export interface ExternalHarness {
	readonly id: RunHarness;
	/**
	 * Spec 042 D12: bumped by hand whenever this adapter's `parseOutcome` schema assumptions
	 * change. Persisted on the run and shown by `/subagents show`, so a failure caused by upstream
	 * CLI schema drift is distinguishable from a failure the target CLI itself reported.
	 */
	readonly parserVersion: number;
	/** Whether `subagent_run op=follow_up` can resume a finished run on this harness. */
	readonly resumable: boolean;
	/** Whether completion requires a protocol terminal event (false only for raw `exec`, D4/D9). */
	readonly requiresProtocolTerminal: boolean;
	/** Whether `purpose=verify` supplies the default thinking level when the role omits one. */
	readonly supportsImplicitVerifyThinking: boolean;
	/** True when `systemPrompt` is passed via a CLI flag rather than prepended on stdin (`claude-code`). */
	readonly acceptsSystemPromptFlag?: boolean;
	/** True when resumed runs persist and verify `expectedResumeSessionId` in `parseOutcome` (spec 068 D8). */
	readonly verifiesResumeSession?: boolean;
	/** Assemble argv. The command line is never joined into a single shell string (D4). */
	buildInvocation(input: ExternalInvocationInput): BuildInvocationResult;
	/** Parse stdout into a unified outcome. Must never throw — a parse failure degrades to
	 *  `protocolStatus: "unparsable"`, not an exception (D4). */
	parseOutcome(input: ParseOutcomeInput): ExternalOutcome;
	/**
	 * P1a: map one raw output line, still mid-run, to a short human-readable step label. Must never
	 * throw, and returns `undefined` for a line that carries no progress-worthy information.
	 */
	toProgressLabel?(line: string): string | undefined;
	/** Optional discovery-time static role warnings owned by this harness. */
	roleWarnings?(input: ExternalRoleWarningInput): string[];
}

/**
 * The D4 status table, shared by the live post-exit path and restart reconciliation (D10.3) so
 * both judge a run identically. Harnesses with `requiresProtocolTerminal: false` (`exec`) fold
 * exit code directly into `protocolStatus` because they emit no protocol terminal event.
 */
export function classifyExternalOutcome(
	harnessOrId: Pick<ExternalHarness, "requiresProtocolTerminal"> | RunHarness,
	outcome: ExternalOutcome,
): { status: "completed" | "failed"; failureReason?: string } {
	const requiresTerminal =
		typeof harnessOrId === "string" ? harnessOrId !== "exec" : harnessOrId.requiresProtocolTerminal;
	if (!requiresTerminal) {
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

export interface DetectExistingFlagsOptions {
	/** Recognize `-m` / `-m=...` as a short model flag (default true; `agy` supports `--model` only). */
	shortModelFlag?: boolean;
	/** Recognize `--thinking` / `--thinking=...` as an effort alias (default true; `agy` supports `--effort` only). */
	thinkingAlias?: boolean;
	/** Recognize Codex CLI's `-c` / `--config` `model=...` and `model_reasoning_effort=...` overrides (default false). */
	codexConfigFlag?: boolean;
}

const CODEX_CONFIG_FLAG_PATTERN = /^(-c|--config)$/;
const CODEX_MODEL_VALUE_PREFIX = "model=";
const CODEX_EFFORT_VALUE_PREFIX = "model_reasoning_effort=";

/** Which flags the user's own `command` already spells out, scoped to the target CLI's flag grammar (D4). */
export function detectExistingFlags(argv: readonly string[], options: DetectExistingFlagsOptions = {}): ExistingFlags {
	const shortModel = options.shortModelFlag ?? true;
	const thinkingAlias = options.thinkingAlias ?? true;
	const codexConfig = options.codexConfigFlag ?? false;
	let model = false;
	let effort = false;
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i]!;
		if (token === "--model" || token.startsWith("--model=")) model = true;
		if (shortModel && (token === "-m" || token.startsWith("-m="))) model = true;
		if (token === "--effort" || token.startsWith("--effort=")) effort = true;
		if (thinkingAlias && (token === "--thinking" || token.startsWith("--thinking="))) effort = true;
		if (codexConfig) {
			if (CODEX_CONFIG_FLAG_PATTERN.test(token)) {
				const value = argv[i + 1];
				if (value?.startsWith(CODEX_MODEL_VALUE_PREFIX)) model = true;
				if (value?.startsWith(CODEX_EFFORT_VALUE_PREFIX)) effort = true;
			} else if (token.startsWith("-c=") || token.startsWith("--config=")) {
				const value = token.slice(token.indexOf("=") + 1);
				if (value.startsWith(CODEX_MODEL_VALUE_PREFIX)) model = true;
				if (value.startsWith(CODEX_EFFORT_VALUE_PREFIX)) effort = true;
			}
		}
	}
	return { model, effort };
}

/** True when `argv` already specifies `--output-format` with a value other than `expected`. */
export function outputFormatConflicts(argv: readonly string[], expected = "stream-json"): boolean {
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (token === "--output-format") {
			if (argv[i + 1] !== expected) return true;
		} else if (token?.startsWith("--output-format=") && token.slice("--output-format=".length) !== expected) {
			return true;
		}
	}
	return false;
}

/**
 * Parse NDJSON lines into plain JSON objects, tolerating blank, torn, or non-object lines.
 * Returning an array keeps each adapter's loop imperative so TypeScript tracks state narrowing.
 */
export function parseJsonObjectLines(eventsText: string): Record<string, unknown>[] {
	const records: Record<string, unknown>[] = [];
	for (const line of eventsText.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let event: unknown;
		try {
			event = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (isPlainObject(event)) records.push(event);
	}
	return records;
}

const PLACEHOLDERS = ["$MODEL", "$EFFORT", "$PROMPT_FILE", "$SYSTEM_PROMPT_FILE"] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];

/**
 * Expand `$MODEL`/`$EFFORT`/`$PROMPT_FILE`/`$SYSTEM_PROMPT_FILE` wherever they appear in argv
 * (D4). Unresolved placeholder tokens are dropped and returned in `dropped` (spec 042 D10).
 */
export function expandPlaceholders(
	argv: string[],
	values: Partial<Record<Placeholder, string>>,
): { argv: string[]; used: Set<Placeholder>; dropped: string[] } {
	const used = new Set<Placeholder>();
	const dropped: string[] = [];
	const expanded: string[] = [];
	for (const token of argv) {
		let result = token;
		for (const placeholder of PLACEHOLDERS) {
			const value = values[placeholder];
			if (value !== undefined && result.includes(placeholder)) {
				used.add(placeholder);
				result = result.split(placeholder).join(value);
			}
		}
		if (PLACEHOLDERS.some((placeholder) => result.includes(placeholder))) {
			dropped.push(token);
			continue;
		}
		expanded.push(result);
	}
	return { argv: expanded, used, dropped };
}

/** Turn `expandPlaceholders`'s `dropped` tokens into run-visible warning strings (spec 042 D10). */
export function formatDroppedPlaceholderWarnings(dropped: string[]): string[] {
	return dropped.map(
		(token) =>
			`Dropped argv token "${token}": it references a placeholder with no value configured for this run (e.g. no "model:" set for $MODEL).`,
	);
}
