/**
 * Provider-error recovery for an internal run: a transcript ending in a provider error is retried in
 * place (transient errors, with backoff) and then, once, on the backup model — the same rule the
 * main turn follows.
 */
import { clampThinkingLevel, isRetryableAssistantError } from "@earendil-works/pi-ai/compat";
import { shouldFallback } from "../../models/fallback.js";
import { formatModelReference } from "../../models/reference.js";
import { sleepUnref } from "../../shared/with-timeout.js";
import { DEFAULT_THINKING_LEVEL, type ResolvedInternalSubAgentConfig } from "../discovery.js";
import { formatStatus } from "../result.js";
import type { SubAgentToolOptions, SubAgentWorker } from "../types.js";
import type { InternalRunState } from "./state.js";
import { isAssistantMessage } from "./worker.js";

/**
 * A provider error (429, overloaded, 5xx, dropped stream) used to fail an internal run outright —
 * the main session retries those, a bare `Agent` does not. Retried in place with exponential
 * backoff (2s, 4s, 8s) before falling back to the backup model; the wall-time budget still bounds
 * the whole thing.
 */
const MAX_TRANSIENT_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2_000;

/**
 * A transcript ending in a provider error is retried in place (the error message removed, the
 * loop continued from the last user/tool message): transient errors up to
 * MAX_TRANSIENT_RETRIES times with backoff, then — for anything but a context overflow — one
 * switch to the backup model, the same rule the main turn follows (`shouldFallback`). Budget
 * aborts and explicit cancels are never retried.
 */
export async function recoverFromProviderErrors(input: {
	worker: SubAgentWorker;
	options: SubAgentToolOptions;
	config: ResolvedInternalSubAgentConfig;
	state: InternalRunState;
	/** Wakes a retry backoff early when the run is cancelled or out of wall time. */
	retryBackoff: AbortController;
	emitUpdate: (text: string) => void;
}): Promise<void> {
	const { worker, options, config, state, retryBackoff, emitUpdate } = input;
	const resume = worker.continue?.bind(worker);
	if (!resume) return;
	let retries = 0;
	let switched = false;
	for (;;) {
		if (state.budgetExceeded || state.externallyCancelled) return;
		const last = worker.state.messages.at(-1);
		if (!last || !isAssistantMessage(last) || last.stopReason !== "error") return;
		// `shouldFallback` is false only for a context overflow, which no retry or model switch fixes.
		if (!shouldFallback(last.errorMessage)) return;
		if (retries < MAX_TRANSIENT_RETRIES && isRetryableAssistantError(last)) {
			retries++;
			emitUpdate(formatStatus(config.name, `provider error, retrying (${retries}/${MAX_TRANSIENT_RETRIES})`));
			const delayMs = (options.retryBaseDelayMs ?? RETRY_BASE_DELAY_MS) * 2 ** (retries - 1);
			await sleepUnref(delayMs, retryBackoff.signal);
			if (state.budgetExceeded || state.externallyCancelled) return;
		} else {
			if (switched || !options.resolveFallbackModel) return;
			const candidate = await options.resolveFallbackModel().catch(() => null);
			if (!candidate || formatModelReference(candidate) === formatModelReference(state.activeModel)) return;
			let candidateKey: string;
			try {
				candidateKey = await options.resolveApiKey(candidate);
			} catch {
				return;
			}
			switched = true;
			retries = 0;
			const fromRef = formatModelReference(state.activeModel);
			state.activeModel = candidate;
			state.apiKey = candidateKey;
			worker.state.model = candidate;
			worker.state.thinkingLevel = clampThinkingLevel(candidate, config.thinkingLevel ?? DEFAULT_THINKING_LEVEL);
			state.fallbackNote = `switched from ${fromRef} to backup model ${formatModelReference(candidate)} after: ${
				last.errorMessage?.split("\n")[0]?.slice(0, 200) ?? "unknown error"
			}`;
			emitUpdate(formatStatus(config.name, `switching to backup model ${formatModelReference(candidate)}`));
		}
		worker.state.messages = worker.state.messages.slice(0, -1);
		await resume();
		await worker.waitForIdle();
	}
}
