import { isPlainObject } from "../../shared/type-guards.js";
import type { UsageTotals } from "../../usage/totals.js";
import {
	type BuildInvocationResult,
	type ExternalHarness,
	type ExternalInvocationInput,
	type ExternalOutcome,
	expandPlaceholders,
	formatDroppedPlaceholderWarnings,
	type ParseOutcomeInput,
} from "./harness.js";

/**
 * `antigravity-cli` harness (spec 068). One prompt, one short-lived `agy` process.
 *
 * Unlike `claude` and `agent`, `agy`'s `-p` / `--print` / `--prompt` flags take a string argument
 * (`flag.StringVar`) and block piped stdin, so this adapter never passes `-p`. Piped stdin with
 * `--output-format stream-json` enters headless print mode automatically.
 *
 * Event shapes and token semantics were verified against `agy 1.5.9`:
 * - `output_tokens` already includes `thinking_tokens`; `total_tokens = input_tokens + output_tokens`.
 * - `--conversation <id>` follow-ups report cumulative conversation totals in `result.usage` while
 *   `step_update.usage` reports only the current invocation's steps (no historical step replay).
 * - Invalid `--conversation <id>` on a model prompt logs a stderr warning and silently allocates a
 *   new UUID, so `expectedResumeSessionId` is verified in `parseOutcome` (D8).
 */

const THINKING_LEVEL_TO_ANTIGRAVITY_EFFORT: Record<string, string> = {
	off: "low",
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

const PROGRESS_LABEL_MAX_CHARS = 80;
const MAX_DENIED_ACTION_PREVIEW_ITEMS = 5;
const MAX_DENIED_ACTION_ITEM_CHARS = 80;

const TOOL_SUBJECT_FIELDS = [
	"CommandLine",
	"command",
	"Path",
	"TargetFile",
	"SearchPath",
	"Directory",
	"file_path",
	"target_file",
	"path",
	"Query",
	"Pattern",
	"query",
	"pattern",
	"Url",
	"url",
	"Role",
	"Description",
	"toolSummary",
] as const;

interface ParsedUsageSnapshot {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: 0;
	total: number;
}

function toAntigravityEffort(level: string): string {
	return THINKING_LEVEL_TO_ANTIGRAVITY_EFFORT[level] ?? level;
}

function hasModelFlag(argv: readonly string[]): boolean {
	return argv.some((token) => token === "--model" || token.startsWith("--model="));
}

function hasEffortFlag(argv: readonly string[]): boolean {
	return argv.some((token) => token === "--effort" || token.startsWith("--effort="));
}

function hasPrintOrInteractiveFlag(argv: readonly string[]): boolean {
	return argv.some(
		(token) =>
			token === "-p" ||
			token === "--print" ||
			token === "--prompt" ||
			token.startsWith("--print=") ||
			token.startsWith("--prompt=") ||
			token === "-i" ||
			token === "--prompt-interactive" ||
			token.startsWith("--prompt-interactive="),
	);
}

function hasConversationFlag(argv: readonly string[]): boolean {
	return argv.some(
		(token) =>
			token === "-c" ||
			token === "--continue" ||
			token === "--conversation" ||
			token.startsWith("--continue=") ||
			token.startsWith("--conversation="),
	);
}

function outputFormatConflicts(argv: readonly string[]): boolean {
	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i];
		if (token === "--output-format") {
			if (argv[i + 1] !== "stream-json") return true;
		} else if (token?.startsWith("--output-format=") && token.slice("--output-format=".length) !== "stream-json") {
			return true;
		}
	}
	return false;
}

function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseUsageSnapshot(raw: unknown): ParsedUsageSnapshot | undefined {
	if (!isPlainObject(raw)) return undefined;
	if (!isNonNegativeFiniteNumber(raw.input_tokens)) return undefined;
	if (!isNonNegativeFiniteNumber(raw.output_tokens)) return undefined;
	if (raw.cache_read_tokens !== undefined && !isNonNegativeFiniteNumber(raw.cache_read_tokens)) {
		return undefined;
	}
	if (raw.thinking_tokens !== undefined && !isNonNegativeFiniteNumber(raw.thinking_tokens)) {
		return undefined;
	}
	if (raw.total_tokens !== undefined && !isNonNegativeFiniteNumber(raw.total_tokens)) {
		return undefined;
	}
	const input = raw.input_tokens;
	const output = raw.output_tokens;
	const cacheRead = raw.cache_read_tokens ?? 0;
	const total = raw.total_tokens ?? input + output;
	return {
		input,
		output,
		cacheRead,
		cacheWrite: 0,
		total,
	};
}

function isNonZeroUsage(snapshot: ParsedUsageSnapshot): boolean {
	return snapshot.input > 0 || snapshot.output > 0 || snapshot.cacheRead > 0 || snapshot.total > 0;
}

function sumUsageSnapshots(snapshots: Iterable<ParsedUsageSnapshot>): ParsedUsageSnapshot {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let total = 0;
	for (const item of snapshots) {
		input += item.input;
		output += item.output;
		cacheRead += item.cacheRead;
		total += item.total;
	}
	return {
		input,
		output,
		cacheRead,
		cacheWrite: 0,
		total,
	};
}

function joinStepsWithBoundaries(steps: readonly string[]): string {
	if (steps.length === 0) return "";
	let acc = steps[0]!;
	for (let i = 1; i < steps.length; i += 1) {
		const next = steps[i]!;
		if (!acc.endsWith("\n") && !next.startsWith("\n")) {
			acc += "\n";
		}
		acc += next;
	}
	return acc;
}

function extractDeniedActions(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const items: string[] = [];
	for (const entry of value) {
		if (typeof entry === "string" && entry.trim().length > 0) {
			items.push(collapseWhitespace(entry).slice(0, MAX_DENIED_ACTION_ITEM_CHARS));
		}
	}
	return items;
}

function formatDeniedActionsPreview(actions: readonly string[]): string {
	const shown = actions.slice(0, MAX_DENIED_ACTION_PREVIEW_ITEMS).join(", ");
	const remaining = actions.length - MAX_DENIED_ACTION_PREVIEW_ITEMS;
	return remaining > 0 ? `${shown}; +${remaining} more in events.jsonl` : shown;
}

function formatCompletedDeniedNotice(actions: readonly string[]): string {
	const preview = formatDeniedActionsPreview(actions);
	return `[antigravity-cli permission notice] Denied actions during headless run: ${preview}. Inspect this run's events.jsonl / stderr.log, verify any skipped work, or re-run with a role that grants the required permissions.`;
}

function parametersObject(value: unknown): Record<string, unknown> | undefined {
	if (isPlainObject(value)) return value;
	if (typeof value !== "string") return undefined;
	try {
		const parsed: unknown = JSON.parse(value);
		return isPlainObject(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function subjectFromToolParameters(params: Record<string, unknown>): string | undefined {
	for (const field of TOOL_SUBJECT_FIELDS) {
		const value = params[field];
		if (typeof value !== "string") continue;
		const raw = field === "CommandLine" || field === "command" ? (value.split(/\r?\n/)[0] ?? "") : value;
		const collapsed = collapseWhitespace(raw);
		if (collapsed) return collapsed;
	}
	return undefined;
}

function formatProgressLabel(verb: string, subject: string | undefined): string | undefined {
	const text = collapseWhitespace(subject ? `${verb} ${subject}` : verb);
	if (!text) return undefined;
	return text.slice(0, PROGRESS_LABEL_MAX_CHARS);
}

export const antigravityCliHarness: ExternalHarness = {
	id: "antigravity-cli",
	parserVersion: 1,

	buildInvocation(input: ExternalInvocationInput): BuildInvocationResult {
		if (input.argv.length === 0) {
			throw new Error("antigravity-cli: command produced no argv tokens");
		}
		const [executable, ...rest] = input.argv;
		const existingModel = hasModelFlag(rest);
		const existingEffort = hasEffortFlag(rest);
		const effort = input.thinkingLevel ? toAntigravityEffort(input.thinkingLevel) : undefined;
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

		const warnings = formatDroppedPlaceholderWarnings(dropped);
		if (outputFormatConflicts(expandedRest)) {
			warnings.push(
				"Appended --output-format stream-json; the command already set a different output format, and settlement parses stream-json.",
			);
		}
		if (hasPrintOrInteractiveFlag(expandedRest)) {
			warnings.push(
				"Command includes -p/--print/--prompt or -i/--prompt-interactive; in agy these flags consume a following argument, block piped stdin, or require an interactive terminal.",
			);
		}
		if (hasConversationFlag(expandedRest)) {
			warnings.push(
				"Command includes -c/--continue/--conversation; pinning or resuming a session in the role command can share state across runs and conflict with runtime follow_up resumption.",
			);
		}

		const args = [...expandedRest, "--output-format", "stream-json"];
		if (input.model && !existingModel && !used.has("$MODEL")) {
			args.push("--model", input.model);
		}
		if (effort && !existingEffort && !used.has("$EFFORT")) {
			args.push("--effort", effort);
		}
		if (input.resumeSessionId) {
			args.push("--conversation", input.resumeSessionId);
		}

		return {
			executable,
			args,
			resumable: true,
			warnings: warnings.length > 0 ? warnings : undefined,
		};
	},

	parseOutcome(input: ParseOutcomeInput): ExternalOutcome {
		let sessionId: string | undefined;
		let terminalSeen = false;
		let protocolStatus: ExternalOutcome["protocolStatus"] = "absent";
		let errorMessage: string | undefined;
		let parsedAnyObject = false;

		const expectedResumeId = input.expectedResumeSessionId?.trim() || undefined;
		let matchedExpectedSession = false;
		let mismatchedSessionId: string | undefined;

		const stepTexts = new Map<number, string>();
		const stepUsages = new Map<number, ParsedUsageSnapshot>();
		const userInputStepIndices = new Set<number>();

		let resultResponse: string | undefined;
		let resultStructuredOutput: unknown;
		let resultDeniedActions: string[] = [];
		let resultUsage: ParsedUsageSnapshot | undefined;

		const recordParentConversationId = (value: unknown) => {
			if (typeof value !== "string") return;
			const trimmed = value.trim();
			if (!trimmed) return;
			sessionId = trimmed;
			if (expectedResumeId) {
				if (trimmed === expectedResumeId) {
					matchedExpectedSession = true;
				} else {
					mismatchedSessionId ??= trimmed;
				}
			}
		};

		for (const line of input.eventsText.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			let event: unknown;
			try {
				event = JSON.parse(trimmed);
			} catch {
				continue;
			}
			if (!isPlainObject(event)) continue;
			parsedAnyObject = true;

			recordParentConversationId(event.conversation_id);

			if (event.event === "step_update" && isPlainObject(event.step_update)) {
				const step = event.step_update;
				recordParentConversationId(step.conversation_id);

				const stepIndex =
					typeof step.step_index === "number" && Number.isInteger(step.step_index) && step.step_index >= 0
						? step.step_index
						: undefined;

				if (stepIndex !== undefined) {
					if (step.step_type === "user_input") {
						userInputStepIndices.add(stepIndex);
					}
					if (
						step.step_type === "agent_response" &&
						typeof step.text_delta === "string" &&
						step.text_delta.length > 0
					) {
						const prev = stepTexts.get(stepIndex) ?? "";
						stepTexts.set(stepIndex, prev + step.text_delta);
					}
					const stepUsage = parseUsageSnapshot(step.usage);
					if (stepUsage !== undefined) {
						const existing = stepUsages.get(stepIndex);
						if (!existing || isNonZeroUsage(stepUsage)) {
							stepUsages.set(stepIndex, stepUsage);
						}
					}
				}
			}

			if (event.event === "result" && isPlainObject(event.result)) {
				const res = event.result;
				terminalSeen = true;
				recordParentConversationId(res.conversation_id);

				const status = typeof res.status === "string" ? res.status.trim() : "";
				const finishedReason = typeof res.finished_reason === "string" ? res.finished_reason.trim() : "";
				const isSuccess = status === "SUCCESS" && !finishedReason;
				protocolStatus = isSuccess ? "completed" : "failed";

				resultResponse = typeof res.response === "string" ? res.response : undefined;
				resultStructuredOutput = res.structured_output;
				resultDeniedActions = extractDeniedActions(res.denied_actions);
				resultUsage = parseUsageSnapshot(res.usage);

				if (!isSuccess) {
					const rawError = typeof res.error === "string" ? res.error.trim() : "";
					let primaryError: string;
					if (rawError) {
						primaryError = rawError;
					} else if (finishedReason) {
						primaryError = `antigravity-cli stopped: ${finishedReason}`;
					} else if (status) {
						primaryError = `antigravity-cli reported status ${status}`;
					} else {
						primaryError = "antigravity-cli reported an error";
					}
					if (resultDeniedActions.length > 0) {
						primaryError = `${primaryError} (denied actions: ${formatDeniedActionsPreview(resultDeniedActions)})`;
					}
					errorMessage = primaryError;
				} else {
					errorMessage = undefined;
				}
			}
		}

		if (!parsedAnyObject && input.eventsText.trim()) {
			protocolStatus = "unparsable";
		}

		const orderedStepTexts = [...stepTexts.entries()]
			.sort(([a], [b]) => a - b)
			.map(([, text]) => text)
			.filter((text) => text.length > 0);
		const joinedStepsText = joinStepsWithBoundaries(orderedStepTexts);

		let finalText: string;
		if (!terminalSeen) {
			finalText = joinedStepsText;
		} else if (typeof resultResponse === "string" && resultResponse.trim().length > 0) {
			if (orderedStepTexts.length > 1 && orderedStepTexts.join("") === resultResponse) {
				finalText = joinedStepsText;
			} else {
				finalText = resultResponse;
			}
		} else if (joinedStepsText.trim().length > 0) {
			finalText = joinedStepsText;
		} else if (resultStructuredOutput !== undefined) {
			finalText = JSON.stringify(resultStructuredOutput) ?? "";
		} else {
			finalText = "";
		}

		if (terminalSeen && protocolStatus === "completed" && resultDeniedActions.length > 0) {
			const notice = formatCompletedDeniedNotice(resultDeniedActions);
			finalText = finalText ? `${notice}\n\n${finalText}` : notice;
		}

		// D8: verify resumed conversation identity against parent-session events.
		if (expectedResumeId) {
			if (mismatchedSessionId !== undefined) {
				protocolStatus = "failed";
				sessionId = undefined;
				errorMessage = `antigravity-cli session mismatch: expected conversation "${expectedResumeId}" but CLI reported "${mismatchedSessionId}". Inspect events.jsonl/stderr.log and start a new delegation with full context.`;
			} else if (!matchedExpectedSession) {
				sessionId = undefined;
				if (parsedAnyObject || terminalSeen) {
					protocolStatus = "failed";
					const missingReason = `antigravity-cli session verification failed: expected conversation "${expectedResumeId}" was not confirmed in stream events. Inspect events.jsonl/stderr.log and start a new delegation with full context.`;
					errorMessage = errorMessage ? `${errorMessage}; ${missingReason}` : missingReason;
				}
			}
		}

		const stderr = input.stderrTail?.trim();
		if (!terminalSeen && !errorMessage && stderr) {
			errorMessage = stderr;
		}

		// D5: resolve single-run token usage.
		const summedSteps = stepUsages.size > 0 ? sumUsageSnapshots(stepUsages.values()) : undefined;
		const hasNonZeroSteps = summedSteps !== undefined && isNonZeroUsage(summedSteps);
		let chosenUsage: ParsedUsageSnapshot | undefined;
		if (expectedResumeId) {
			// On `--conversation`, `result.usage` is cumulative across turns; only non-replayed step usage belongs to this run.
			if (hasNonZeroSteps && userInputStepIndices.size <= 1) {
				chosenUsage = summedSteps;
			}
		} else if (resultUsage !== undefined && isNonZeroUsage(resultUsage)) {
			chosenUsage = resultUsage;
		} else if (hasNonZeroSteps) {
			chosenUsage = summedSteps;
		}

		const usage: Partial<UsageTotals> | undefined = chosenUsage
			? {
					input: chosenUsage.input,
					output: chosenUsage.output,
					cacheRead: chosenUsage.cacheRead,
					cacheWrite: chosenUsage.cacheWrite,
					total: chosenUsage.total,
				}
			: undefined;

		return {
			finalText,
			terminalSeen,
			protocolStatus,
			exitCode: input.exitCode,
			sessionId,
			usage,
			usageKnown: chosenUsage !== undefined,
			costKnown: false,
			stderrTail: input.stderrTail,
			errorMessage,
		};
	},

	toProgressLabel(line: string): string | undefined {
		let event: unknown;
		try {
			event = JSON.parse(line.trim());
		} catch {
			return undefined;
		}
		if (!isPlainObject(event) || event.event !== "step_update" || !isPlainObject(event.step_update)) {
			return undefined;
		}
		const step = event.step_update;
		if (step.state !== "ACTIVE") return undefined;

		if (
			isPlainObject(step.subagent_info) &&
			Array.isArray(step.subagent_info.subagents) &&
			step.subagent_info.subagents.length > 0
		) {
			const first = step.subagent_info.subagents[0];
			const subagentName = isPlainObject(first)
				? typeof first.role === "string" && first.role.trim()
					? first.role.trim()
					: typeof first.type_name === "string" && first.type_name.trim()
						? first.type_name.trim()
						: undefined
				: undefined;
			return formatProgressLabel("subagent", subagentName);
		}

		const toolInfo = isPlainObject(step.tool_info) ? step.tool_info : undefined;
		const toolName =
			typeof toolInfo?.name === "string" && toolInfo.name.trim()
				? toolInfo.name.trim()
				: typeof step.tool_name === "string" && step.tool_name.trim()
					? step.tool_name.trim()
					: undefined;
		if (step.step_type !== "tool" && !toolName) return undefined;
		if (!toolName) return undefined;

		const params = parametersObject(toolInfo?.parameters);
		const subject = params ? subjectFromToolParameters(params) : undefined;
		return formatProgressLabel(toolName, subject);
	},
};
