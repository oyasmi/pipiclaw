import type { Api, Model } from "@earendil-works/pi-ai";
import { isContextOverflow } from "@earendil-works/pi-ai";
import * as log from "../log.js";
import { formatModelReference } from "../models/utils.js";
import { isRecord } from "../shared/type-guards.js";

/**
 * Backup-model fallback (spec 017).
 *
 * When the primary model's turn ends in error, switch to a single configured
 * backup model and re-run the turn once. Pure decision helpers live here so the
 * orchestration is fully testable without a real SDK session.
 */

/** How long the primary model stays "cooling down" after a fallback before we retry it. */
export const PRIMARY_COOLDOWN_MS = 5 * 60_000;

/**
 * A turn ended with `stopReason: "error"`. Decide whether switching to the backup
 * model is worth trying. Blacklist, not classifier: everything is worth a retry on a
 * different provider EXCEPT context overflow (that is compaction's job — a bigger
 * transcript fails the same way on any model). 429 / 5xx / quota / auth / even 400 all
 * return true; the cost of a wasted extra attempt buys a one-sentence rule.
 */
export function shouldFallback(errorMessage: string | undefined): boolean {
	if (!errorMessage) {
		return true;
	}
	// Only the error-message branch of isContextOverflow matters here (we already know
	// stopReason === "error"); usage/contextWindow paths are irrelevant, so a minimal
	// message is enough. NON_OVERFLOW_PATTERNS inside keeps rate-limit (429) → fallback.
	const overflow = isContextOverflow({
		role: "assistant",
		stopReason: "error",
		errorMessage,
		content: [],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	} as unknown as Parameters<typeof isContextOverflow>[0]);
	return !overflow;
}

function isAssistantErrorMessage(value: unknown): boolean {
	return isRecord(value) && value.role === "assistant" && value.stopReason === "error";
}

function isUserMessage(value: unknown): boolean {
	return isRecord(value) && value.role === "user";
}

/**
 * State surgery. The failed single-shot turn leaves the transcript tail as
 * `[user, assistant(stopReason "error")]` — the shape of the common 429 / quota / auth
 * case where the very first API call fails before any tool runs. Return the transcript
 * with those two messages removed, ready to be re-prompted on the backup model.
 *
 * Returns `null` if the tail is any other shape (multi-step failure, unexpected state).
 * The caller MUST then skip fallback — better to surface the error than corrupt context.
 * This is the single coupling point to the SDK's `agent.state.messages` layout.
 */
export function takeFailedTurn(messages: readonly unknown[]): unknown[] | null {
	if (messages.length < 2) {
		return null;
	}
	const last = messages[messages.length - 1];
	const prev = messages[messages.length - 2];
	if (!isAssistantErrorMessage(last) || !isUserMessage(prev)) {
		return null;
	}
	return messages.slice(0, -2);
}

/** At turn start, may we leave the backup model and try the primary again? */
export function shouldRestorePrimary(primaryFailedAt: number | null, now: number): boolean {
	if (primaryFailedAt === null) {
		return true;
	}
	return now - primaryFailedAt > PRIMARY_COOLDOWN_MS;
}

/** Short one-line error summary for the user-facing switch notice. */
export function summarizeFallbackError(errorMessage: string | undefined): string {
	if (!errorMessage) {
		return "未知错误";
	}
	const firstLine = errorMessage.split("\n")[0]?.trim() ?? "";
	if (!firstLine) {
		return "未知错误";
	}
	return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
}

export interface FallbackRunDeps {
	/** Submit a prompt. Must catch transport/prompt errors and record them into run error state. */
	prompt(text: string): Promise<void>;
	/** Read the current turn's terminal error state (populated by prompt + session events). */
	getRunError(): { stopReason: string; errorMessage?: string };
	/** Clear stopReason/errorMessage/finalOutcome so the re-run starts clean. */
	resetRunError(): void;
	/** Live `agent.state.messages` reference for surgery. */
	getMessages(): readonly unknown[];
	/** Assign the truncated transcript back (SDK setter copies the array). */
	setMessages(messages: unknown[]): void;
	/** Whether the first prompt actually enqueued its user message (false = pre-flight throw, e.g. no API key). */
	promptWasSubmitted(): boolean;
	getCurrentModelRef(): string;
	/** Resolve the configured backup model, or null (unset / unresolvable / no API key). */
	resolveFallbackModel(): Promise<Model<Api> | null>;
	setModel(model: Model<Api>): Promise<void>;
	/** Notify the user a switch happened. */
	notifySwitch(from: string, to: string, errorSummary: string): void;
	/** Record `primaryFailedAt = now` so cooldown/restore logic engages. */
	markPrimaryFailed(): void;
}

/**
 * Run the prompt with at most one backup-model retry. Returns whether a fallback
 * re-run was attempted (for error-message wording / logging). When no backup is
 * configured, this is a single `prompt()` — behaviorally identical to the status quo.
 */
export async function runPromptWithFallback(promptText: string, deps: FallbackRunDeps): Promise<boolean> {
	await deps.prompt(promptText);

	const firstError = deps.getRunError();
	if (firstError.stopReason !== "error" || !shouldFallback(firstError.errorMessage)) {
		return false;
	}

	const candidate = await deps.resolveFallbackModel();
	if (!candidate) {
		return false;
	}

	const fromRef = deps.getCurrentModelRef();
	const toRef = formatModelReference(candidate);
	if (fromRef === toRef) {
		return false;
	}

	// Surgery only when the failed turn was actually enqueued. A pre-flight throw
	// (no API key on the primary) submits nothing, so there is nothing to remove —
	// switch straight to the backup, which covers a mis-configured primary key.
	if (deps.promptWasSubmitted()) {
		const truncated = takeFailedTurn(deps.getMessages());
		if (!truncated) {
			log.logWarning(
				"[fallback] transcript tail is not [user, assistant(error)]; skipping fallback to avoid corrupting context",
			);
			return false;
		}
		deps.setMessages(truncated);
	}

	deps.markPrimaryFailed();
	await deps.setModel(candidate);
	deps.notifySwitch(fromRef, toRef, summarizeFallbackError(firstError.errorMessage));
	deps.resetRunError();

	await deps.prompt(promptText);
	return true;
}
