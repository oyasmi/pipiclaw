/**
 * Inbound has no DingTalk-imposed size contract the way outbound does (`dingtalk.ts`'s
 * `MAX_IMAGE_BYTES` mirrors the *send* limit); this instead mirrors `tools/truncate.ts`'s
 * `MAX_INLINE_BINARY_BYTES` — the same ceiling `read` already applies to an on-disk image — so
 * "a picture the user sent" and "a picture `read` loads from disk" behave identically for the
 * model. Lives here, not in the DingTalk-specific `runtime/inbound-media.ts`, because both the
 * transport (rejecting an oversized download) and `agent/channel-runner.ts` (skipping an
 * oversized file before base64-encoding it) need the same number, and `agent/` never imports
 * from `runtime/` (spec 049).
 */
export const MAX_INBOUND_IMAGE_BYTES = 5 * 1024 * 1024;

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
	/** Absolute path under `<channelDir>/inbox/`. */
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
 * A message or wake, from any producer: a real inbound DingTalk message, a scheduled event, a
 * task-driver wake, or a job/subagent completion. `conversationId` is the one field genuinely
 * DingTalk-specific (needed to reply into the right conversation); every synthetic producer
 * (job-manager, task-driver, events, subagents/runs) leaves it unset rather than faking a value,
 * since it has no DingTalk conversation to route into. `conversationType` is not DingTalk-specific
 * in practice — every producer, real or synthetic, can derive "1"/"2" from the channelId prefix —
 * so it stays required.
 */
export interface ChannelEvent {
	type: "dm" | "group";
	channelId: string; // dm_{staffId} or group_{conversationId}
	ts: string;
	user: string; // sender staff id, or a synthetic producer tag (JOB, TASK_DRIVER, SUBAGENT, EVENT, ...)
	userName: string;
	text: string;
	/** Images the user sent alongside `text` (spec 049), already downloaded and persisted. */
	images?: InboundImage[];
	/** DingTalk conversation id; absent on synthetic events, which have no DingTalk conversation. */
	conversationId?: string;
	conversationType: string; // "1" = DM, "2" = group
	/**
	 * Human-readable channel name: the group title, or the peer's nickname for a DM. Absent on
	 * synthetic events (scheduled events, task-driver wakes), which carry no conversation payload.
	 */
	channelName?: string;
	/** Runtime-owned durable-dispatch record, absent for normal inbound messages. */
	dispatchId?: string;
	/** Structured wake provenance created only by in-process producers. DingTalk inbound parsing
	 * never copies arbitrary payload fields into this event, so user text cannot manufacture it. */
	internalWake?: {
		kind: "job" | "subagent";
		resourceId: string;
		taskId: string;
		dispatchId: string;
	};
	/**
	 * Purely a display hint: `"awaited"` marks a synthetic wake a human is actually waiting on (a
	 * delegation or background job finishing), as opposed to an autonomous check-in (task-driver
	 * polling, a scheduled event) that normally has nothing to say. The runtime uses it to decide
	 * whether the resulting turn renders progress or stays silent until a final answer — it must
	 * never gate task activation or any other trust decision; that stays on `internalWake` alone.
	 */
	presentation?: "awaited";
}
