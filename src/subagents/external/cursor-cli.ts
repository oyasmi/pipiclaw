import { isPlainObject } from "../../shared/type-guards.js";
import {
	type BuildInvocationResult,
	detectExistingFlags,
	type ExternalHarness,
	type ExternalInvocationInput,
	type ExternalOutcome,
	expandPlaceholders,
	formatDroppedPlaceholderWarnings,
	type ParseOutcomeInput,
} from "./harness.js";

/**
 * `cursor-cli` harness (spec 066). One prompt, one short-lived `agent -p` process. The CLI assigns
 * the session id in `system/init`; this adapter never invents one. Effort is not a separate flag:
 * it is folded into the model id (`name[effort=high]`). Print mode does not write files unless the
 * role command passes `-f`, `--force`, or `--yolo` — those are not appended here.
 *
 * Event shapes follow the Cursor CLI stream-json docs and `agent --help` for 2026.10.22-27dcf5f.
 * `parseOutcome` degrades on schema drift; it does not throw.
 */

const THINKING_LEVEL_TO_CURSOR_EFFORT: Record<string, string> = {
	off: "low",
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

const PROGRESS_LABEL_MAX_CHARS = 80;
const TOOL_SUBJECT_FIELDS = ["command", "path", "file_path", "target_file", "pattern", "url", "query"] as const;

function toCursorEffort(level: string): string {
	return THINKING_LEVEL_TO_CURSOR_EFFORT[level] ?? level;
}

/** A single trailing `[...]` list. Anything else that contains `[` is left untouched. */
function decorateCursorModel(model: string, effort: string): { model: string; warning?: string } {
	if (!model.includes("[")) return { model: `${model}[effort=${effort}]` };
	const match = /^([^[\]]*)\[([^[\]]*)\]$/.exec(model);
	if (!match) {
		return {
			model,
			warning: `Left model id "${model}" unchanged: it contains "[" but is not a single trailing bracket list, so effort= was not added.`,
		};
	}
	const inner = match[2] ?? "";
	if (/(?:^|,)\s*effort=/.test(inner)) {
		return {
			model,
			warning: `Left model id "${model}" unchanged: its bracket list already sets effort=.`,
		};
	}
	const nextInner = inner.trim() === "" ? `effort=${effort}` : `${inner},effort=${effort}`;
	return { model: `${match[1]}[${nextInner}]` };
}

function hasTrustFlag(argv: string[]): boolean {
	return argv.some((token) => token === "--trust" || token.startsWith("--trust="));
}

/** True when the command already chose an output format other than the one settlement parses. */
function outputFormatConflicts(argv: string[]): boolean {
	for (let i = 0; i < argv.length; i++) {
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

function subjectFromArgs(args: Record<string, unknown>): string | undefined {
	for (const field of TOOL_SUBJECT_FIELDS) {
		const value = args[field];
		if (typeof value !== "string") continue;
		const subject = field === "command" ? value.split("\n")[0] : value;
		const collapsed = subject ? collapseWhitespace(subject) : "";
		if (collapsed) return collapsed;
	}
	return undefined;
}

function formatProgressLabel(verb: string, subject: string | undefined): string | undefined {
	const text = collapseWhitespace(subject ? `${verb} ${subject}` : verb);
	if (!text) return undefined;
	return text.slice(0, PROGRESS_LABEL_MAX_CHARS);
}

function argumentsObject(value: unknown): Record<string, unknown> | undefined {
	if (isPlainObject(value)) return value;
	if (typeof value !== "string") return undefined;
	try {
		const parsed: unknown = JSON.parse(value);
		return isPlainObject(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function labelFromToolPayload(payload: Record<string, unknown>): string | undefined {
	const fn = payload.function;
	if (isPlainObject(fn) && typeof fn.name === "string" && fn.name.trim()) {
		const args = argumentsObject(fn.arguments);
		return formatProgressLabel(fn.name.trim(), args ? subjectFromArgs(args) : undefined);
	}
	for (const key of Object.keys(payload)) {
		if (!key.endsWith("ToolCall")) continue;
		const verb = key.slice(0, -"ToolCall".length);
		if (!verb) continue;
		const value = payload[key];
		const args = isPlainObject(value) && isPlainObject(value.args) ? value.args : undefined;
		return formatProgressLabel(verb, args ? subjectFromArgs(args) : undefined);
	}
	return undefined;
}

function assistantText(record: Record<string, unknown>): string | undefined {
	if ("timestamp_ms" in record || "model_call_id" in record) return undefined;
	const message = record.message;
	if (!isPlainObject(message) || !Array.isArray(message.content)) return undefined;
	const text = message.content
		.filter(
			(part): part is { type: "text"; text: string } =>
				isPlainObject(part) && part.type === "text" && typeof part.text === "string",
		)
		.map((part) => part.text)
		.join("");
	return text.trim() ? text : undefined;
}

export const cursorCliHarness: ExternalHarness = {
	id: "cursor-cli",
	parserVersion: 1,

	buildInvocation(input: ExternalInvocationInput): BuildInvocationResult {
		if (input.argv.length === 0) {
			throw new Error("cursor-cli: command produced no argv tokens");
		}
		const [executable, ...rest] = input.argv;
		const existing = detectExistingFlags(rest);
		const effort = input.thinkingLevel ? toCursorEffort(input.thinkingLevel) : undefined;
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

		const args = [...expandedRest, "-p", "--output-format", "stream-json"];
		const appendModel = Boolean(input.model) && !existing.model && !used.has("$MODEL");
		if (appendModel && input.model) {
			let modelArg = input.model;
			// `$EFFORT` already carries the level into the command. Decorating the model as well
			// would apply it twice. A command that already has --model/-m is not rewritten.
			if (input.thinkingLevel && !used.has("$EFFORT")) {
				const decorated = decorateCursorModel(input.model, toCursorEffort(input.thinkingLevel));
				modelArg = decorated.model;
				if (decorated.warning) warnings.push(decorated.warning);
			}
			args.push("--model", modelArg);
		} else if (input.thinkingLevel && !input.model && !existing.model) {
			warnings.push(
				"thinkingLevel is set but no model is configured and the command has no --model or -m flag; cursor-cli will use its own default model.",
			);
		} else if (input.thinkingLevel && existing.model && !used.has("$EFFORT")) {
			warnings.push(
				"thinkingLevel is set but the command already passes --model or -m, so effort= was not added. Put effort= inside that model id if this reasoning level should apply.",
			);
		}

		if (!hasTrustFlag(expandedRest)) args.push("--trust");
		if (input.resumeSessionId) args.push("--resume", input.resumeSessionId);

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
		let assistantCandidate: string | undefined;
		let resultText: string | undefined;

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

			if (typeof event.session_id === "string") sessionId = event.session_id;

			if (event.type === "assistant") {
				const text = assistantText(event);
				if (text) assistantCandidate = text;
			}

			if (event.type === "result") {
				terminalSeen = true;
				const subtype = typeof event.subtype === "string" ? event.subtype : undefined;
				const failed = event.is_error === true || (subtype !== undefined && subtype !== "success");
				protocolStatus = failed ? "failed" : "completed";
				if (typeof event.result === "string") resultText = event.result;
				if (failed) {
					const resultMessage = typeof event.result === "string" ? event.result.trim() : "";
					errorMessage =
						resultMessage || (subtype ? `cursor-cli reported ${subtype}` : "cursor-cli reported an error");
				} else {
					errorMessage = undefined;
				}
			}
		}

		if (!parsedAnyObject && input.eventsText.trim()) protocolStatus = "unparsable";

		const stderr = input.stderrTail?.trim();
		if (!terminalSeen && stderr) errorMessage = stderr;

		const fallback = resultText?.trim() ? resultText : "";
		return {
			finalText: assistantCandidate || fallback,
			terminalSeen,
			protocolStatus,
			exitCode: input.exitCode,
			sessionId,
			usageKnown: false,
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
		if (!isPlainObject(event) || event.type !== "tool_call" || event.subtype !== "started") return undefined;
		const payload = isPlainObject(event.tool_call) ? event.tool_call : event;
		return labelFromToolPayload(payload);
	},
};
