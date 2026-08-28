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
