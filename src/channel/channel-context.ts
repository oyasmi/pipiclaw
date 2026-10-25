/**
 * The per-turn output port (spec 061, D7): what one turn writes to its channel.
 *
 * A turn reports what happened as structured `TurnEvent`s; how that looks is each transport's
 * business — DingTalk renders progress lines into an AI Card, the Web API turns them into output
 * items. Nothing here is pre-rendered text, and nothing model-facing travels through it: a tool
 * call carries its name and raw arguments, and the transport builds the user label itself
 * (`tools/contract/presentation.ts`'s `describeToolCall`).
 */
import type { UsageTotals } from "../usage/totals.js";

export interface ChannelContext {
	/** Called in order of occurrence and never blocks; a transport serializes its own delivery. */
	emit(event: TurnEvent): void;
	/** Called once when the turn ends; the transport closes its card or settles its response here. */
	finish(outcome: TurnOutcome): Promise<void>;
}

export type TurnEvent =
	| { type: "tool.start"; callId: string; tool: string; args: unknown }
	| { type: "tool.update"; callId: string; text: string }
	/**
	 * `output` is the tool's result text (clipped). `failure` is present only when the user should
	 * see this call as an error line, already worded for them; a call the model recovers from by
	 * itself (a rejected argument) is `ok: false` with no `failure`.
	 */
	| { type: "tool.end"; callId: string; ok: boolean; output: string; failure?: string }
	| { type: "reasoning"; text: string }
	/**
	 * A line of the turn's narrative that is not the answer. Without a `level` it is the model's
	 * own text between tool calls. `level` marks runtime-authored text:
	 * - `"error"` — a failure line inside the progress (a tool or compaction error); dropped when
	 *   the transport shows no progress;
	 * - `"warning"` — the same, but it must not be lost: shown as progress, or as a standalone
	 *   notice when the transport shows no progress (a model fallback switch);
	 * - `"notice"` — a standalone side notice, never part of the progress (a skill update, a
	 *   clipped input, a compaction hint).
	 */
	| { type: "commentary"; text: string; level?: "error" | "warning" | "notice" }
	/** A final answer. `title` names it where the transport shows one (DingTalk's conversation list). */
	| { type: "answer"; text: string; title?: string }
	/** The SDK injected a steering or follow-up message into this turn. */
	| { type: "steer.applied" }
	| { type: "compaction"; phase: "start" | "end"; ok?: boolean };

export interface TurnOutcome {
	/** Machine-only continuation snapshot. Transports must never render this as user copy. */
	continuation?: import("./turn-context.js").ContextMessage[];
	/** The context's owning desk; not user-visible copy. */
	executionDesk?: string;
	/**
	 * - `completed` — the turn ended normally (it may have no answer);
	 * - `silent` — the model answered `[SILENT]` or nothing: end without a message;
	 * - `failed` — it ended in error with no answer; `message` says why;
	 * - `cancelled` — the user stopped it, or its generation was retired.
	 */
	kind: "completed" | "silent" | "failed" | "cancelled";
	/** `failed` only: the reason, already written for the user. */
	message?: string;
	/** Everything the turn's LLM calls cost, up to the moment it ended. */
	usage: UsageTotals;
}
