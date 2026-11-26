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
 * `codex-cli` harness (spec 040, D3/D4). One prompt, one short-lived process, NDJSON on stdout
 * (`--json -`). Chosen as the first structured harness because its process model already matches
 * D3 with nothing to reduce — no FIFO, no long-lived session to reconcile.
 *
 * The event shapes below are the design doc's D4 table, not a live-verified schema snapshot: the
 * risk section calls this out explicitly (CLI schema drift is an accepted, ongoing maintenance
 * cost). `parseOutcome` is written so a shape mismatch degrades to `unparsable` rather than
 * throwing — that contract is load-bearing, unlike the exact field names.
 */

// Codex's `thinkingLevel` values line up 1:1 with pipiclaw's own except at the bottom of the
// scale (D4's translation table): "off" has no weaker codex equivalent than "none", and "minimal"
// is model-dependent (some models 400 on it), so both clamp up to the next real level.
const THINKING_LEVEL_TO_CODEX_EFFORT: Record<string, string> = {
	off: "none",
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

function toCodexEffort(level: string | undefined): string | undefined {
	if (!level) return undefined;
	return THINKING_LEVEL_TO_CODEX_EFFORT[level] ?? level;
}

export const codexCliHarness: ExternalHarness = {
	id: "codex-cli",
	parserVersion: 2,
	resumable: true,
	requiresProtocolTerminal: true,
	supportsImplicitVerifyThinking: true,

	buildInvocation(input: ExternalInvocationInput): BuildInvocationResult {
		if (input.argv.length === 0) {
			throw new Error("codex-cli: command produced no argv tokens");
		}
		const [executable, ...rest] = input.argv;
		const existing = detectExistingFlags(rest, { codexConfigFlag: true });
		const effort = toCodexEffort(input.thinkingLevel);

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

		const baseArgs = [...expandedRest];
		if (!existing.model && input.model && !used.has("$MODEL")) {
			baseArgs.push("-m", input.model);
		}
		if (!existing.effort && effort && !used.has("$EFFORT")) {
			baseArgs.push("-c", `model_reasoning_effort=${effort}`);
		}

		// Resume is a subcommand, not a flag: `<father args> resume <thread_id> --json -`, so the
		// base flags above must come first and `--json -` last regardless (D4).
		const args = input.resumeSessionId
			? [...baseArgs, "resume", input.resumeSessionId, "--json", "-"]
			: [...baseArgs, "--json", "-"];

		return {
			executable,
			args,
			resumable: true,
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

		let observedExecutionActivity = false;
		let observedNonZeroUsage = false;
		const { records, complete } = parseJsonObjectLines(
			input.eventsText,
			(record) =>
				record.type === "thread.started" ||
				record.type === "turn.started" ||
				record.type === "turn.completed" ||
				record.type === "turn.failed" ||
				record.type === "error" ||
				(typeof record.type === "string" && record.type.startsWith("item.") && isRecord(record.item)),
		);
		const parsedAnyLine = records.length > 0;
		for (const record of records) {
			const threadId = record.thread_id ?? (record.thread as Record<string, unknown> | undefined)?.id;
			if (typeof threadId === "string") sessionId = threadId;

			if (typeof record.type === "string" && record.type.startsWith("item.") && isRecord(record.item)) {
				const item = record.item;
				// Future item types can also execute work. Only an explicit error item is diagnostic.
				observedExecutionActivity ||= item.type !== "error";
				if (record.type === "item.completed" && item.type === "agent_message" && typeof item.text === "string") {
					finalText = item.text;
				}
			}

			if (record.type === "turn.completed" || record.type === "turn.failed") {
				terminalSeen = true;
				protocolStatus = record.type === "turn.completed" ? "completed" : "failed";
				if (record.type === "turn.failed") {
					errorMessage = codexError(record.error) ?? errorMessage ?? "codex-cli reported turn.failed";
				}
				if (isRecord(record.usage)) {
					const rawInput = finiteNonNegative(record.usage.input_tokens);
					const output = finiteNonNegative(record.usage.output_tokens);
					const cachedInput = finiteNonNegative(record.usage.cached_input_tokens);
					const cacheRead = Math.min(rawInput, cachedInput);
					usage = { input: rawInput - cacheRead, output, cacheRead, total: rawInput + output };
					observedNonZeroUsage ||= rawInput > 0 || output > 0 || cachedInput > 0;
					usageKnown = true;
				}
			} else if (record.type === "error" && !terminalSeen) {
				errorMessage = codexError(record) ?? errorMessage;
			}
		}

		if (!parsedAnyLine && input.eventsText.trim()) {
			protocolStatus = "unparsable";
		}
		if (protocolStatus === "completed") errorMessage = undefined;
		else errorMessage ??= input.stderrTail?.trim() || undefined;

		return {
			finalText,
			terminalSeen,
			protocolStatus,
			exitCode: input.exitCode,
			sessionId,
			usage,
			usageKnown,
			costKnown: false, // codex-cli never reports a cost field (D4).
			stderrTail: input.stderrTail,
			errorMessage,
			observedExecutionActivity:
				observedExecutionActivity || (parsedAnyLine && complete && errorMessage ? false : undefined),
			observedNonZeroUsage,
		};
	},

	// P1a: the two item types worth surfacing mid-run — the shell command a step is currently
	// running, and todo-list progress. `agent_message`/everything else has nothing to show before
	// the run is over.
	toProgressLabel(line: string): string | undefined {
		let event: unknown;
		try {
			event = JSON.parse(line.trim());
		} catch {
			return undefined;
		}
		if (typeof event !== "object" || event === null) return undefined;
		const record = event as Record<string, unknown>;
		if (record.type !== "item.started" && record.type !== "item.updated") return undefined;
		const item = record.item as Record<string, unknown> | undefined;
		if (!item) return undefined;
		if (item.type === "command_execution" && typeof item.command === "string") {
			const firstLine = item.command.split("\n")[0]?.trim();
			return firstLine ? firstLine.slice(0, 80) : undefined;
		}
		if (item.type === "todo_list" && Array.isArray(item.items)) {
			const total = item.items.length;
			if (total === 0) return undefined;
			const done = item.items.filter((entry) => isRecord(entry) && entry.completed === true).length;
			return `待办 ${done}/${total}`;
		}
		return undefined;
	},
};

function codexError(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	const message = typeof value.message === "string" ? value.message.trim() : "";
	const code = typeof value.code === "string" || typeof value.code === "number" ? String(value.code) : "";
	return [code, message].filter(Boolean).join(": ") || undefined;
}
