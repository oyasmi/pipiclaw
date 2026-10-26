/**
 * A user-sent image already downloaded to local disk (spec 049).
 *
 * Deliberately asymmetric with the outbound `OutboundMedia` (which carries a `Buffer`): outbound
 * bytes come from an `Executor` that may be remote, with no local-file concept to point at.
 * Inbound bytes must be persisted to satisfy the retention requirement regardless, and
 * `ChannelEvent` is serialized into durable-dispatch records and logged — carrying the bytes a
 * second time there would be pure waste. `path` is the natural handle once persistence already
 * happened.
 */
export interface InboundImage {
	/** Absolute path under the bound desk's `inbox/`. */
	path: string;
	/**
	 * Sniffed MIME type ("image/jpeg", …), or `"application/octet-stream"` when magic-byte
	 * sniffing did not recognize a supported image format — see `unsupportedFormat`.
	 */
	mimeType: string;
	/** On-disk byte size — lets the runner skip an oversized image without reading it into memory. */
	byteSize: number;
	/**
	 * True when the bytes were downloaded and persisted but are not a supported image format.
	 * Kept for the archive/record trail; the runner must never build an `ImageContent` from one.
	 */
	unsupportedFormat?: boolean;
}

/**
 * A message or a wake, from any producer (spec 061, D8). `source` is the discriminator: a `human`
 * event is a real person's message that came through a transport; a `wake` is synthesized in
 * process (scheduled events, the task driver, job and delegation completions) and is admitted only
 * while its channel is still bound to the desk it was produced for.
 */
export type ChannelEvent = HumanEvent | WakeEvent;

interface EventBase {
	channelId: string;
	ts: string;
	text: string;
	/** Images the user sent alongside `text` (spec 049), already downloaded and persisted. */
	images?: InboundImage[];
	/** Runtime-owned durable-dispatch record, absent for normal inbound messages. */
	dispatchId?: string;
}

export interface HumanEvent extends EventBase {
	context?: import("./turn-context.js").TurnContext;
	source: "human";
	user: string;
	userName: string;
	/**
	 * Human-readable channel name: the group title, or the peer's nickname for a DM. Absent when
	 * the transport has none.
	 */
	channelName?: string;
	/** The transport's own correlation reference for this message (`InboundMessage.ref`). */
	ref?: string;
	/**
	 * The desks the sender may use (`InboundMessage.allowedDesks`); absent means any. Carried to
	 * execution because a queued message can outlive the binding it was admitted under.
	 */
	allowedDesks?: readonly string[];
}

export interface WakeEvent extends EventBase {
	source: "wake";
	/** Producer tag: JOB, TASK_DRIVER, SUBAGENT, EVENT, … Shown to the model as the sender. */
	producer: string;
	/**
	 * The desk this wake was produced for (spec 058, D7). Every in-process producer must set it;
	 * durable dispatch refuses a wake without it, and admission drops a wake whose channel is no
	 * longer bound to this desk.
	 */
	desk: string;
	/** Structured wake provenance created only by in-process producers; user text cannot manufacture it. */
	internalWake?: {
		kind: "job" | "subagent";
		resourceId: string;
		taskId: string;
		dispatchId: string;
	};
	/**
	 * Purely a display hint: `"awaited"` marks a wake a human is actually waiting on (a delegation
	 * or background job finishing), as opposed to an autonomous check-in (task-driver polling, a
	 * scheduled event) that normally has nothing to say. All wakes deliver only their result; this
	 * metadata does not enable progress cards or gate task activation. Trust decisions stay on
	 * `internalWake` alone.
	 */
	presentation?: "awaited";
}

/** Who the model is told wrote this event: the person, or the producer tag of a wake. */
export function senderOf(event: ChannelEvent): { user: string; userName: string } {
	return event.source === "wake"
		? { user: event.producer, userName: event.producer }
		: { user: event.user, userName: event.userName };
}

/**
 * The one thing in-process producers (scheduled events, durable dispatch) need from the runtime:
 * hand it a wake for its per-channel queue. `false` means the queue rejected it (full or
 * stopped), so the caller keeps ownership and may retry. Implemented by the runtime's `Ingress`.
 */
export interface ChannelEventSink {
	enqueueEvent(event: WakeEvent): boolean;
}
