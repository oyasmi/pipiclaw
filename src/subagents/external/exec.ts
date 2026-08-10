import type {
	BuildInvocationResult,
	ExternalHarness,
	ExternalInvocationInput,
	ExternalOutcome,
	ParseOutcomeInput,
} from "./harness.js";

/**
 * `exec` harness (spec 040, D3/D4/D9). The generic escape hatch: run the command as-is, prompt on
 * stdin, whatever it prints on stdout is the result. No protocol, no flags, no placeholders beyond
 * what the shared helper already offers — there is nothing harness-specific to inject because
 * there is no known CLI contract to inject it into.
 *
 * This is the explicit exception to the D4 status table (see `classifyExternalOutcome`): `exec`
 * has no terminal event to observe at all, so `terminalSeen` is always `false` and completion
 * evidence is exit code alone — weaker than a structured harness, which is exactly why `exec` is
 * barred from `purpose=verify` (D9) and always reports `usageKnown`/`costKnown: false`.
 */

const MAX_OUTPUT_CHARS = 16_000;

export const execHarness: ExternalHarness = {
	id: "exec",
	parserVersion: 1,

	buildInvocation(input: ExternalInvocationInput): BuildInvocationResult {
		if (input.argv.length === 0) {
			throw new Error("exec: command produced no argv tokens");
		}
		const [executable, ...args] = input.argv;
		return { executable, args, resumable: false };
	},

	parseOutcome(input: ParseOutcomeInput): ExternalOutcome {
		const text = input.eventsText;
		const truncated = text.length > MAX_OUTPUT_CHARS;
		// The full, untruncated capture always stays on disk as this run's events.jsonl (spec 040
		// D1's layout, unconditional for every external run) — a truncated reply must say so
		// explicitly rather than silently dropping the tail (P1-3: the playbook's "full text is
		// always recoverable" promise did not actually hold for a chatty `exec` role).
		const finalText = truncated
			? `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n[... output truncated at ${MAX_OUTPUT_CHARS} characters; the full capture is this run's events.jsonl ...]`
			: text;
		return {
			finalText,
			terminalSeen: false, // Always false, even on success — exec has no protocol terminal (D4/D9).
			protocolStatus: input.exitCode === 0 ? "completed" : "failed",
			exitCode: input.exitCode,
			usageKnown: false,
			costKnown: false,
			stderrTail: input.stderrTail,
			errorMessage: input.exitCode === 0 ? undefined : `exec exited with code ${input.exitCode ?? "unknown"}`,
		};
	},
};
