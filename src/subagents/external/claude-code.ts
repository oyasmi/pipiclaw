import { randomUUID } from "node:crypto";
import {
	type BuildInvocationResult,
	detectExistingFlags,
	type ExternalHarness,
	type ExternalInvocationInput,
	type ExternalOutcome,
	expandPlaceholders,
	type ParseOutcomeInput,
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

	buildInvocation(input: ExternalInvocationInput): BuildInvocationResult {
		if (input.argv.length === 0) {
			throw new Error("claude-code: command produced no argv tokens");
		}
		const [executable, ...rest] = input.argv;
		const existing = detectExistingFlags(rest);
		const effort = toClaudeEffort(input.thinkingLevel);

		const { argv: expandedRest, used } = expandPlaceholders(rest, {
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
		if (!used.has("$SYSTEM_PROMPT_FILE")) {
			args.push("--append-system-prompt-file", input.systemPromptFile);
		}

		let presetSessionId: string | undefined;
		if (input.resumeSessionId) {
			args.push("--resume", input.resumeSessionId);
		} else {
			presetSessionId = randomUUID();
			args.push("--session-id", presetSessionId);
		}

		return { executable, args, resumable: true, presetSessionId };
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
		let parsedAnyLine = false;

		for (const line of input.eventsText.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			let event: unknown;
			try {
				event = JSON.parse(trimmed);
			} catch {
				continue; // Tolerate a torn or non-JSON line.
			}
			if (typeof event !== "object" || event === null) continue;
			parsedAnyLine = true;
			const record = event as Record<string, unknown>;

			const sid = record.session_id;
			if (typeof sid === "string") sessionId = sid;

			if (record.type === "result") {
				terminalSeen = true;
				const isError = record.is_error === true;
				protocolStatus = isError ? "failed" : "completed";
				if (typeof record.result === "string") finalText = record.result;
				if (isError) {
					errorMessage =
						typeof record.result === "string" && record.result
							? record.result
							: typeof record.subtype === "string"
								? `claude-code reported ${record.subtype}`
								: "claude-code reported an error result";
				}
				const cost = record.total_cost_usd;
				if (typeof cost === "number") {
					costTotal = cost;
					costKnown = true;
				}
				const rawUsage = record.usage as Record<string, unknown> | undefined;
				if (rawUsage) {
					const inputTokens = Number(rawUsage.input_tokens ?? 0);
					const outputTokens = Number(rawUsage.output_tokens ?? 0);
					const cacheRead = Number(rawUsage.cache_read_input_tokens ?? 0);
					const cacheWrite = Number(rawUsage.cache_creation_input_tokens ?? 0);
					usage = {
						input: inputTokens || 0,
						output: outputTokens || 0,
						cacheRead: cacheRead || 0,
						cacheWrite: cacheWrite || 0,
						total: (inputTokens || 0) + (outputTokens || 0) + (cacheRead || 0) + (cacheWrite || 0),
						...(costTotal !== undefined
							? { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costTotal } }
							: {}),
					};
					usageKnown = true;
				}
			}
		}

		if (!parsedAnyLine && input.eventsText.trim()) {
			protocolStatus = "unparsable";
		}

		return {
			finalText,
			terminalSeen,
			protocolStatus,
			exitCode: input.exitCode,
			sessionId,
			usage,
			usageKnown,
			costKnown,
			stderrTail: input.stderrTail,
			errorMessage,
		};
	},
};
