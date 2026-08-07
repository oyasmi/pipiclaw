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

	buildInvocation(input: ExternalInvocationInput): BuildInvocationResult {
		if (input.argv.length === 0) {
			throw new Error("codex-cli: command produced no argv tokens");
		}
		const [executable, ...rest] = input.argv;
		const existing = detectExistingFlags(rest);
		const effort = toCodexEffort(input.thinkingLevel);

		const { argv: expandedRest, used } = expandPlaceholders(rest, {
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
			promptFiles: used.has("$PROMPT_FILE") ? [input.promptFile] : undefined,
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
		let parsedAnyLine = false;

		for (const line of input.eventsText.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			let event: unknown;
			try {
				event = JSON.parse(trimmed);
			} catch {
				continue; // Tolerate a torn or non-JSON line; judged by what *did* parse.
			}
			if (typeof event !== "object" || event === null) continue;
			parsedAnyLine = true;
			const record = event as Record<string, unknown>;

			const threadId = record.thread_id ?? (record.thread as Record<string, unknown> | undefined)?.id;
			if (typeof threadId === "string") sessionId = threadId;

			if (record.type === "item.completed") {
				const item = record.item as Record<string, unknown> | undefined;
				if (item?.type === "agent_message" && typeof item.text === "string") {
					finalText = item.text;
				}
			}

			if (record.type === "turn.completed") {
				terminalSeen = true;
				protocolStatus = "completed";
				const rawUsage = record.usage as Record<string, unknown> | undefined;
				if (rawUsage) {
					const input_ = Number(rawUsage.input_tokens ?? 0);
					const output_ = Number(rawUsage.output_tokens ?? 0);
					if (Number.isFinite(input_) || Number.isFinite(output_)) {
						usage = { input: input_ || 0, output: output_ || 0, total: (input_ || 0) + (output_ || 0) };
						usageKnown = true;
					}
				}
			}

			if (record.type === "turn.failed") {
				terminalSeen = true;
				protocolStatus = "failed";
				const error = record.error as Record<string, unknown> | undefined;
				errorMessage = typeof error?.message === "string" ? error.message : "codex-cli reported turn.failed";
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
			costKnown: false, // codex-cli never reports a cost field (D4).
			outputTruncated: false,
			stderrTail: input.stderrTail,
			errorMessage,
		};
	},
};
