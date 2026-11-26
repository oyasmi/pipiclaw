import { splitShellWords } from "../../shared/shell-words.js";
import { isPlainObject } from "../../shared/type-guards.js";
import type { UsageTotals } from "../../usage/totals.js";
import {
	type BuildInvocationResult,
	detectExistingFlags,
	type ExternalHarness,
	type ExternalInvocationInput,
	type ExternalOutcome,
	type ExternalRoleWarningInput,
	expandPlaceholders,
	formatDroppedPlaceholderWarnings,
	outputFormatConflicts,
	type ParseOutcomeInput,
	parseJsonObjectLines,
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

function hasPrintToken(token: string): boolean {
	return (
		token === "-p" ||
		token === "--print" ||
		token === "--prompt" ||
		token.startsWith("--print=") ||
		token.startsWith("--prompt=")
	);
}

function hasInteractiveToken(token: string): boolean {
	return token === "-i" || token === "--prompt-interactive" || token.startsWith("--prompt-interactive=");
}

function hasConversationToken(token: string): boolean {
	return (
		token === "-c" ||
		token === "--continue" ||
		token === "--conversation" ||
		token.startsWith("--continue=") ||
		token.startsWith("--conversation=")
	);
}

function resolveEffectiveMode(tokens: readonly string[]): string | undefined {
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
	resumable: true,
	requiresProtocolTerminal: true,
	supportsImplicitVerifyThinking: true,
	verifiesResumeSession: true,

	roleWarnings(input: ExternalRoleWarningInput): string[] {
		const tokens = splitShellWords(input.command);
		const warnings: string[] = [];
		if (tokens.some(hasPrintToken)) {
			warnings.push(
				`${input.entryName}: -p, --print, and --prompt consume a string argument and block piped stdin in agy; omit them so headless delegation reads from stdin`,
			);
		}
		if (tokens.some(hasInteractiveToken)) {
			warnings.push(
				`${input.entryName}: -i and --prompt-interactive require a TTY and will fail or hang in a detached background delegation`,
			);
		}
		if (tokens.some(hasConversationToken)) {
			warnings.push(
				`${input.entryName}: -c, --continue, and --conversation pin or share session context across runs and conflict with follow_up --conversation <id>; session resumption is managed by Pipiclaw`,
			);
		}

		const effectiveMode = resolveEffectiveMode(tokens);
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
	},

	buildInvocation(input: ExternalInvocationInput): BuildInvocationResult {
		if (input.argv.length === 0) {
			throw new Error("antigravity-cli: command produced no argv tokens");
		}
		const [executable, ...rest] = input.argv;
		const existing = detectExistingFlags(rest, { shortModelFlag: false, thinkingAlias: false });
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
		if (expandedRest.some((token) => hasPrintToken(token) || hasInteractiveToken(token))) {
			warnings.push(
				"Command includes -p/--print/--prompt or -i/--prompt-interactive; in agy these flags consume a following argument, block piped stdin, or require an interactive terminal.",
			);
		}
		if (expandedRest.some(hasConversationToken)) {
			warnings.push(
				"Command includes -c/--continue/--conversation; pinning or resuming a session in the role command can share state across runs and conflict with runtime follow_up resumption.",
			);
		}

		const args = [...expandedRest, "--output-format", "stream-json"];
		if (input.model && !existing.model && !used.has("$MODEL")) {
			args.push("--model", input.model);
		}
		if (effort && !existing.effort && !used.has("$EFFORT")) {
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
		let observedExecutionActivity = false;
		let observedNonZeroUsage = false;

		const expectedResumeId = input.expectedResumeSessionId?.trim() || undefined;
		let matchedExpectedSession = false;
		let mismatchedSessionId: string | undefined;
		let resumeMismatch = false;

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

		const { records: events, complete } = parseJsonObjectLines(
			input.eventsText,
			(event) =>
				event.event === "init" ||
				(event.event === "result" && isPlainObject(event.result)) ||
				(event.event === "step_update" &&
					isPlainObject(event.step_update) &&
					(event.step_update.step_type === "user_input" ||
						event.step_update.step_type === "agent_response" ||
						event.step_update.step_type === "tool")),
		);
		const parsedAnyObject = events.length > 0;
		for (const event of events) {
			recordParentConversationId(event.conversation_id);

			if (event.event === "step_update" && isPlainObject(event.step_update)) {
				const step = event.step_update;
				recordParentConversationId(step.conversation_id);
				observedExecutionActivity ||=
					step.step_type === "tool" ||
					Boolean(step.tool_name || step.tool_info || step.subagent_info) ||
					(step.step_type === "agent_response" &&
						typeof step.text_delta === "string" &&
						Boolean(step.text_delta.trim()));
				const stepUsage = parseUsageSnapshot(step.usage);
				observedNonZeroUsage ||= stepUsage !== undefined && isNonZeroUsage(stepUsage);

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
				observedNonZeroUsage ||= resultUsage !== undefined && isNonZeroUsage(resultUsage);
				observedExecutionActivity ||=
					Boolean(resultResponse?.trim()) || resultStructuredOutput != null || resultDeniedActions.length > 0;

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
				resumeMismatch = true;
				protocolStatus = "failed";
				sessionId = undefined;
				errorMessage = `antigravity-cli session mismatch: expected conversation "${expectedResumeId}" but CLI reported "${mismatchedSessionId}". Inspect events.jsonl/stderr.log and start a new delegation with full context.`;
			} else if (!matchedExpectedSession) {
				sessionId = undefined;
				if (parsedAnyObject || terminalSeen) {
					resumeMismatch = protocolStatus === "completed";
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
			observedExecutionActivity:
				observedExecutionActivity || (parsedAnyObject && complete && errorMessage ? false : undefined),
			observedNonZeroUsage,
			resumeMismatch,
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
