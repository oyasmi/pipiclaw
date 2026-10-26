/**
 * A Response while it is alive (spec 061, D16/D17/D20): its state machine, the items it has
 * produced so far, and the log of events a stream replays. Everything that reaches a client —
 * the final JSON, an SSE stream, a WebSocket, a resumed background stream — is read from here.
 */
import type {
	ResponseOutputItem,
	ResponseOutputMessage,
	ResponseReasoningItem,
	ResponseStatus,
	ResponseStreamEvent,
	ResponseUsage,
} from "openai/resources/responses/responses";
import * as log from "../log.js";
import { errorMessage } from "../shared/text-utils.js";
import { newId } from "./ids.js";
import { MAX_TOOL_OUTPUT_CHARS } from "./limits.js";
import { isTerminal, nowSeconds, type ResponseRecord, toApiResponse } from "./response-record.js";

/**
 * Pipiclaw's additions to the Responses items, for a client that shows what the user is meant to
 * see: `pipiclaw_failure` is a tool failure worded for the user (a failed call without it is
 * something the model corrects on its own), `pipiclaw_level` marks runtime-authored commentary.
 */
type McpCallItem = Extract<ResponseOutputItem, { type: "mcp_call" }> & { pipiclaw_failure?: string };
export type CommentaryLevel = "error" | "warning" | "notice";
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** An event before it is given its place in the log. */
type PendingEvent = DistributiveOmit<ResponseStreamEvent, "sequence_number">;
export type LoggedEvent = ResponseStreamEvent;

const SERVER_LABEL = "pipiclaw";

export interface ResponseSubscriber {
	onEvent(event: LoggedEvent): void;
	/** The response has reached a terminal state and every event has been delivered. */
	onEnd(): void;
}

export interface LiveResponseHooks {
	/** Called with the record at creation and when the response ends; failures are logged, never thrown. */
	persist(record: ResponseRecord): Promise<void>;
	/** Called once, when the response reaches a terminal state. */
	onTerminal?(live: LiveResponse): void;
}

export class LiveResponse {
	private readonly log: LoggedEvent[] = [];
	/** Events produced before the response was announced; they follow `response.created` in the log. */
	private readonly deferred: PendingEvent[] = [];
	private announced = false;
	private readonly subscribers = new Set<ResponseSubscriber>();
	private readonly toolItems = new Map<string, number>();
	private readonly ended: Promise<void>;
	private resolveEnded!: () => void;
	private persisting: Promise<void> = Promise.resolve();

	constructor(
		readonly record: ResponseRecord,
		private readonly hooks: LiveResponseHooks,
		/** Created with `background` and `stream`: a client may resume the stream while the log is kept. */
		readonly replayable = false,
	) {
		this.ended = new Promise((resolve) => {
			this.resolveEnded = resolve;
		});
	}

	get id(): string {
		return this.record.id;
	}

	get status(): ResponseStatus {
		return this.record.status;
	}

	get terminal(): boolean {
		return isTerminal(this.record.status);
	}

	/** Resolves once the response has reached a terminal state. */
	whenEnded(): Promise<void> {
		return this.ended;
	}

	/** Resolves once the last snapshot has been written (tests and shutdown). */
	whenPersisted(): Promise<void> {
		return this.persisting;
	}

	snapshot() {
		return toApiResponse(this.record);
	}

	// ---- lifecycle -------------------------------------------------------------------------

	/**
	 * Make the response visible: `response.created` (and `queued` or `in_progress`) open the log,
	 * and whatever the turn already produced follows. Nothing is stored or announced before this.
	 */
	announce(initial: "queued" | "in_progress"): void {
		if (this.announced) return;
		if (!this.terminal) this.record.status = initial;
		this.announced = true;
		const skeleton = toApiResponse(this.record, { skeleton: initial });
		this.commit({ type: "response.created", response: skeleton });
		this.commit(
			initial === "queued"
				? { type: "response.queued", response: skeleton }
				: { type: "response.in_progress", response: skeleton },
		);
		for (const pending of this.deferred.splice(0)) this.commit(pending);
		this.save();
	}

	/** A queued response whose turn begins. */
	start(): void {
		if (this.record.status !== "queued") return;
		this.record.status = "in_progress";
		this.emit({ type: "response.in_progress", response: toApiResponse(this.record, { skeleton: "in_progress" }) });
	}

	complete(usage: ResponseUsage): void {
		if (this.terminal) return;
		this.closeDanglingCalls();
		this.record.status = "completed";
		this.record.usage = usage;
		this.record.completed_at = nowSeconds();
		this.emit({ type: "response.completed", response: this.snapshot() });
		this.settle();
	}

	fail(message: string, usage?: ResponseUsage): void {
		if (this.terminal) return;
		this.closeDanglingCalls();
		this.record.status = "failed";
		this.record.error = { code: "server_error", message };
		if (usage) this.record.usage = usage;
		this.record.completed_at = nowSeconds();
		this.emit({ type: "error", code: "server_error", message, param: null });
		this.emit({ type: "response.failed", response: this.snapshot() });
		this.settle();
	}

	/** The response stopped before it was done (steering took over): `incomplete` with the reason. */
	incomplete(reason: string, usage?: ResponseUsage): void {
		if (this.terminal) return;
		this.closeDanglingCalls();
		this.record.status = "incomplete";
		this.record.incomplete_details = { reason };
		if (usage) this.record.usage = usage;
		this.record.completed_at = nowSeconds();
		this.emit({ type: "response.incomplete", response: this.snapshot() });
		this.settle();
	}

	/**
	 * Cancelled by the caller. The API has no event for it: the stream ends where it is, and the
	 * outcome is read from the response object. Returns whether anything changed.
	 */
	cancel(): boolean {
		if (this.terminal) return false;
		this.markDanglingCallsIncomplete();
		this.record.status = "cancelled";
		this.record.completed_at = null;
		this.settle();
		this.endSubscribers();
		return true;
	}

	// ---- items -----------------------------------------------------------------------------

	/** A tool call begins: an `mcp_call` item, in progress, with its arguments. */
	beginToolCall(callId: string, name: string, args: unknown): void {
		if (this.terminal || this.toolItems.has(callId)) return;
		const item: McpCallItem = {
			id: newId("mcp"),
			type: "mcp_call",
			server_label: SERVER_LABEL,
			name,
			arguments: JSON.stringify(args ?? {}) ?? "{}",
			status: "in_progress",
			output: null,
			error: null,
		};
		const index = this.record.output.push(item) - 1;
		this.toolItems.set(callId, index);
		this.emit({ type: "response.output_item.added", output_index: index, item: structuredClone(item) });
		this.emit({
			type: "response.mcp_call_arguments.done",
			output_index: index,
			item_id: item.id,
			arguments: item.arguments,
		});
		this.emit({ type: "response.mcp_call.in_progress", output_index: index, item_id: item.id });
	}

	endToolCall(callId: string, ok: boolean, output: string, failure?: string): void {
		const index = this.toolItems.get(callId);
		if (index === undefined || this.terminal) return;
		this.toolItems.delete(callId);
		const item = this.record.output[index] as McpCallItem;
		const text = output.length > MAX_TOOL_OUTPUT_CHARS ? `${output.slice(0, MAX_TOOL_OUTPUT_CHARS)}…` : output;
		item.output = text;
		item.status = ok ? "completed" : "failed";
		item.error = ok ? null : { type: "mcp_tool_execution_error", content: text };
		if (!ok && failure) item.pipiclaw_failure = failure;
		this.emit({
			type: ok ? "response.mcp_call.completed" : "response.mcp_call.failed",
			output_index: index,
			item_id: item.id,
		});
		this.emit({ type: "response.output_item.done", output_index: index, item: structuredClone(item) });
	}

	/** The model's reasoning, as a reasoning item with a one-part summary. */
	addReasoning(text: string): void {
		if (this.terminal || !text.trim()) return;
		const item: ResponseReasoningItem = { id: newId("rs"), type: "reasoning", summary: [], status: "in_progress" };
		const index = this.record.output.push(item) - 1;
		this.emit({ type: "response.output_item.added", output_index: index, item: structuredClone(item) });
		this.emit({
			type: "response.reasoning_summary_part.added",
			output_index: index,
			item_id: item.id,
			summary_index: 0,
			part: { type: "summary_text", text: "" },
		});
		this.emit({
			type: "response.reasoning_summary_text.delta",
			output_index: index,
			item_id: item.id,
			summary_index: 0,
			delta: text,
		});
		this.emit({
			type: "response.reasoning_summary_text.done",
			output_index: index,
			item_id: item.id,
			summary_index: 0,
			text,
		});
		const part = { type: "summary_text" as const, text };
		this.emit({
			type: "response.reasoning_summary_part.done",
			output_index: index,
			item_id: item.id,
			summary_index: 0,
			part,
		});
		item.summary = [part];
		item.status = "completed";
		this.emit({ type: "response.output_item.done", output_index: index, item: structuredClone(item) });
	}

	/** A finished assistant message: commentary between tool calls, or the final answer. */
	addMessage(phase: "commentary" | "final_answer", text: string, level?: CommentaryLevel): void {
		if (this.terminal || !text.trim()) return;
		const id = newId("msg");
		const empty: ResponseOutputMessage & { pipiclaw_level?: CommentaryLevel } = {
			id,
			type: "message",
			role: "assistant",
			status: "in_progress",
			phase,
			content: [],
			...(level ? { pipiclaw_level: level } : {}),
		};
		const index = this.record.output.push(empty) - 1;
		this.emit({ type: "response.output_item.added", output_index: index, item: structuredClone(empty) });
		this.emit({
			type: "response.content_part.added",
			output_index: index,
			item_id: id,
			content_index: 0,
			part: { type: "output_text", text: "", annotations: [] },
		});
		this.emit({
			type: "response.output_text.delta",
			output_index: index,
			item_id: id,
			content_index: 0,
			delta: text,
			logprobs: [],
		});
		this.emit({
			type: "response.output_text.done",
			output_index: index,
			item_id: id,
			content_index: 0,
			text,
			logprobs: [],
		});
		const part = { type: "output_text" as const, text, annotations: [] };
		this.emit({ type: "response.content_part.done", output_index: index, item_id: id, content_index: 0, part });
		empty.content = [part];
		empty.status = "completed";
		this.emit({ type: "response.output_item.done", output_index: index, item: structuredClone(empty) });
	}

	/** Output items produced so far, for a caller that needs to know whether the turn said anything. */
	get hasOutput(): boolean {
		return this.record.output.length > 0;
	}

	// ---- streams ---------------------------------------------------------------------------

	/**
	 * Replay the log from `fromSequence` (the first event to deliver), then follow it live. Returns
	 * the way to stop following. A response that has already ended is replayed and then `onEnd`.
	 */
	subscribe(fromSequence: number, subscriber: ResponseSubscriber): () => void {
		for (const event of this.log.slice(Math.max(0, fromSequence))) subscriber.onEvent(event);
		if (this.endedFlag) {
			subscriber.onEnd();
			return () => undefined;
		}
		this.subscribers.add(subscriber);
		return () => {
			this.subscribers.delete(subscriber);
		};
	}

	/** Whether events from `sequence` on can still be replayed (the log is whole from the start). */
	get logLength(): number {
		return this.log.length;
	}

	// ---- internals -------------------------------------------------------------------------

	private endedFlag = false;

	private emit(event: PendingEvent): void {
		if (this.announced) this.commit(event);
		else this.deferred.push(event);
	}

	private commit(event: PendingEvent): void {
		const logged = { ...event, sequence_number: this.log.length } as LoggedEvent;
		this.log.push(logged);
		for (const subscriber of [...this.subscribers]) {
			try {
				subscriber.onEvent(logged);
			} catch (error) {
				log.logWarn("webapi.stream.subscriber_failed", "Stream subscriber failed", {
					reason: errorMessage(error),
					fields: { responseId: this.id },
				});
			}
		}
		if (isTerminalEvent(logged) && this.terminal) this.endSubscribers();
	}

	private endSubscribers(): void {
		if (this.endedFlag) return;
		this.endedFlag = true;
		for (const subscriber of [...this.subscribers]) subscriber.onEnd();
		this.subscribers.clear();
	}

	/** The response is over: store the final record and let waiters go. */
	private settle(): void {
		this.save();
		this.hooks.onTerminal?.(this);
		this.resolveEnded();
	}

	private save(): void {
		// A response that is not yet announced is not stored: a request refused at admission leaves nothing behind.
		if (!this.announced) return;
		// Handed over at once, so the store registers the response before anything can ask about it.
		const written = this.hooks.persist(structuredClone(this.record)).catch((error: unknown) => {
			log.logWarn("webapi.response.persist_failed", "Response snapshot write failed", {
				reason: errorMessage(error),
				fields: { responseId: this.id },
			});
		});
		this.persisting = Promise.all([this.persisting, written]).then(() => undefined);
	}

	/** Tool calls still running when the response ends are closed as `incomplete`, with their `done` events. */
	private closeDanglingCalls(): void {
		for (const [callId, index] of [...this.toolItems]) {
			this.toolItems.delete(callId);
			const item = this.record.output[index] as McpCallItem;
			item.status = "incomplete";
			this.emit({ type: "response.output_item.done", output_index: index, item: structuredClone(item) });
		}
	}

	private markDanglingCallsIncomplete(): void {
		for (const [callId, index] of [...this.toolItems]) {
			this.toolItems.delete(callId);
			(this.record.output[index] as McpCallItem).status = "incomplete";
		}
	}
}

function isTerminalEvent(event: LoggedEvent): boolean {
	return (
		event.type === "response.completed" || event.type === "response.failed" || event.type === "response.incomplete"
	);
}
