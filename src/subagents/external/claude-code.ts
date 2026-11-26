import { randomUUID } from "node:crypto";
import { isRecord } from "../../shared/type-guards.js";
import {
	type BuildInvocationResult,
	detectExistingFlags,
	type ExternalHarness,
	type ExternalInvocationInput,
	type ExternalOutcome,
	expandPlaceholders,
	finiteNonNegative,
	formatDroppedPlaceholderWarnings,
	type ParseOutcomeInput,
	parseJsonObjectLines,
} from "./harness.js";

/**
 * `claude-code` harness (spec 040, D3/D4). Same one-prompt-one-process model as codex-cli; the
 * differences are argv shape and stdout schema.
 *
 * The `--session-id`-before-running approach (rather than parsing it out of the first `result`
 * event) is a deliberate improvement flagged in the design doc's review: it means `resume` does
 * not depend on the run having produced *any* successful output — a run that crashes on turn one
 * is still resumable. `--input-format stream-json`, `--include-partial-messages`, and
 * `--replay-user-messages` are deliberately not used: they exist for long-lived, bidirectional
 * sessions (agentmux's use case), and D3 already reduced every harness to one prompt = one
 * process, so none of those apply here.
 *
 * Event shapes are the design doc's D4 table, not a live-verified schema: same schema-drift risk
 * as codex-cli, and `parseOutcome` is written the same way — degrade, never throw.
 */

const THINKING_LEVEL_TO_CLAUDE_EFFORT: Record<string, string> = {
	off: "low", // claude-code has no weaker level than "low" (D4 clamp table).
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

function toClaudeEffort(level: string | undefined): string | undefined {
	if (!level) return undefined;
	return THINKING_LEVEL_TO_CLAUDE_EFFORT[level] ?? level;
}

export const claudeCodeHarness: ExternalHarness = {
	id: "claude-code",
	parserVersion: 3,
	resumable: true,
	requiresProtocolTerminal: true,
	supportsImplicitVerifyThinking: true,
	acceptsSystemPromptFlag: true,

	buildInvocation(input: ExternalInvocationInput): BuildInvocationResult {
		if (input.argv.length === 0) {
			throw new Error("claude-code: command produced no argv tokens");
		}
		const [executable, ...rest] = input.argv;
		const existing = detectExistingFlags(rest);
		const effort = toClaudeEffort(input.thinkingLevel);

		const {
			argv: expandedRest,
			used,
			dropped,
		} = expandPlaceholders(rest, {
			$MODEL: input.model,
			$EFFORT: effort,
			$PROMPT_FILE: input.promptFile,
			$SYSTEM_PROMPT_FILE: input.systemPromptFile,
		});

		const args = [...expandedRest, "-p", "--output-format", "stream-json", "--verbose"];
		if (!existing.model && input.model && !used.has("$MODEL")) {
			args.push("--model", input.model);
		}
		if (!existing.effort && effort && !used.has("$EFFORT")) {
			args.push("--effort", effort);
		}
		// A role with an empty body has no system-prompt file on disk, so the flag is omitted
		// entirely rather than pointed at a path that was never written.
		if (!used.has("$SYSTEM_PROMPT_FILE") && input.systemPromptFile) {
			args.push("--append-system-prompt-file", input.systemPromptFile);
		}

		let presetSessionId: string | undefined;
		if (input.resumeSessionId) {
			args.push("--resume", input.resumeSessionId);
		} else {
			presetSessionId = randomUUID();
			args.push("--session-id", presetSessionId);
		}

		return {
			executable,
			args,
			resumable: true,
			defaultEnv: {
				CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
				CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
				CLAUDE_CODE_DISABLE_CRON: "1",
			},
			presetSessionId,
			warnings: dropped.length > 0 ? formatDroppedPlaceholderWarnings(dropped) : undefined,
		};
	},

	parseOutcome(input: ParseOutcomeInput): ExternalOutcome {
		let finalText = "";
		let sessionId: string | undefined;
		let terminalSeen = false;
		let protocolStatus: ExternalOutcome["protocolStatus"] = "absent";
		let errorMessage: string | undefined;
		let usage: ExternalOutcome["usage"];
		let usageKnown = false;
		let costKnown = false;
		let costTotal: number | undefined;
		// Fallback only: a run killed by timeout/cancel never gets a `result` event, so without this
		// a fully productive 90-minute run reports empty text and zero usage (D-review §1.2). Neither
		// of these ever sets `terminalSeen`/`protocolStatus` — only a real `result` event may do that;
		// streamed text is not proof the run finished.
		let lastAssistantText = "";
		let syntheticError: string | undefined;
		let observedExecutionActivity = false;
		let observedNonZeroUsage = false;
		let resultFallback: string | undefined;
		let streamedUsage: ReturnType<typeof parseClaudeUsage> | undefined;

		const { records, complete } = parseJsonObjectLines(
			input.eventsText,
			(record) =>
				(record.type === "system" && record.subtype === "init") ||
				record.type === "result" ||
				record.type === "rate_limit_event" ||
				(record.type === "assistant" && isRecord(record.message) && Array.isArray(record.message.content)),
		);
		const parsedAnyLine = records.length > 0;
		for (const record of records) {
			const sid = record.session_id;
			if (typeof sid === "string") sessionId = sid;

			if (record.type === "result") {
				terminalSeen = true;
				const isError = record.is_error === true;
				protocolStatus = isError ? "failed" : "completed";
				if (typeof record.result === "string") finalText = record.result;
				if (isError) {
					const errors = Array.isArray(record.errors)
						? record.errors.flatMap((entry: unknown) =>
								typeof entry === "string" && entry.trim() ? [entry.trim()] : [],
							)
						: [];
					errorMessage =
						errors.join("; ") || (typeof record.result === "string" ? record.result.trim() : "") || undefined;
					resultFallback =
						typeof record.subtype === "string" && record.subtype.trim()
							? `claude-code reported ${record.subtype}`
							: "claude-code reported an error result";
				} else {
					errorMessage = undefined;
					resultFallback = undefined;
					if (finalText.trim()) observedExecutionActivity = true;
				}
				const cost = record.total_cost_usd;
				if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
					costTotal = cost;
					costKnown = true;
					observedNonZeroUsage ||= cost > 0;
				}
				if (isRecord(record.usage)) {
					usage = parseClaudeUsage(record.usage);
					observedNonZeroUsage ||= (usage.total ?? 0) > 0;
					usageKnown = true;
				}
			}

			if (record.type === "assistant") {
				const message = record.message;
				if (isRecord(message)) {
					const parts = Array.isArray(message.content) ? message.content : [];
					const text = parts
						.filter(
							(part): part is { type: "text"; text: string } =>
								isRecord(part) && part.type === "text" && typeof part.text === "string",
						)
						.map((part) => part.text)
						.join("");
					const rawUsage = message.usage;
					if (isRecord(rawUsage)) {
						streamedUsage = parseClaudeUsage(rawUsage);
						observedNonZeroUsage ||= streamedUsage.total > 0;
					}
					if (record.is_api_error_message === true || message.model === "<synthetic>") {
						if (text.trim()) syntheticError = text.trim();
					} else {
						if (text.trim()) {
							lastAssistantText = text;
							observedExecutionActivity = true;
						}
					}
					// A tool block is evidence even if an error frame also carries it.
					observedExecutionActivity ||= parts.some(
						(part) =>
							isRecord(part) &&
							(part.type === "tool_use" || part.type === "thinking" || part.type === "redacted_thinking"),
					);
				}
			}
		}

		if (!parsedAnyLine && input.eventsText.trim()) {
			protocolStatus = "unparsable";
		}

		if (!terminalSeen && !usageKnown && streamedUsage) {
			usage = streamedUsage;
			usageKnown = true;
		}
		if (costTotal !== undefined) {
			usage = { ...usage, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costTotal } };
		}
		if (protocolStatus !== "completed") {
			errorMessage ??= syntheticError ?? resultFallback ?? (input.stderrTail?.trim() || undefined);
		}

		return {
			finalText: finalText || lastAssistantText,
			terminalSeen,
			protocolStatus,
			exitCode: input.exitCode,
			sessionId,
			usage,
			usageKnown,
			costKnown,
			stderrTail: input.stderrTail,
			errorMessage,
			observedExecutionActivity:
				observedExecutionActivity || (parsedAnyLine && complete && errorMessage ? false : undefined),
			observedNonZeroUsage,
		};
	},

	// P1a: the first tool_use block in a streamed assistant message names the step currently
	// running. Text-only assistant messages (reasoning, the final answer) have nothing to show.
	toProgressLabel(line: string): string | undefined {
		let event: unknown;
		try {
			event = JSON.parse(line.trim());
		} catch {
			return undefined;
		}
		if (!isRecord(event) || event.type !== "assistant" || !isRecord(event.message)) return undefined;
		const parts = Array.isArray(event.message.content) ? event.message.content : [];
		for (const part of parts) {
			if (isRecord(part) && part.type === "tool_use" && typeof part.name === "string") {
				return describeClaudeToolUse(part.name, isRecord(part.input) ? part.input : {});
			}
		}
		return undefined;
	},
};

function parseClaudeUsage(raw: Record<string, unknown>) {
	const input = finiteNonNegative(raw.input_tokens);
	const output = finiteNonNegative(raw.output_tokens);
	const cacheRead = finiteNonNegative(raw.cache_read_input_tokens);
	const cacheWrite = finiteNonNegative(raw.cache_creation_input_tokens);
	return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

const PROGRESS_LABEL_MAX_CHARS = 80;
/** The one input field that says what a claude-code tool call is acting on, in priority order. */
const TOOL_SUBJECT_FIELDS = ["command", "file_path", "notebook_path", "path", "pattern", "url", "query", "description"];

/**
 * A bare tool name (`Bash`, `Edit`) says nothing about where a run is; the command or path it is
 * acting on does. The todo list gets the same "done/total" shape codex-cli's progress uses.
 */
function describeClaudeToolUse(name: string, input: Record<string, unknown>): string {
	if (Array.isArray(input.todos) && input.todos.length > 0) {
		const done = input.todos.filter((todo) => isRecord(todo) && todo.status === "completed").length;
		return `待办 ${done}/${input.todos.length}`;
	}
	for (const field of TOOL_SUBJECT_FIELDS) {
		const value = input[field];
		if (typeof value !== "string") continue;
		const subject = value.split("\n")[0]?.trim();
		if (subject) return `${name} ${subject}`.slice(0, PROGRESS_LABEL_MAX_CHARS);
	}
	return name;
}
