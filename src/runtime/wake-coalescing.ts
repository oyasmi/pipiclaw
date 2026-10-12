import type { ChannelEvent } from "../channel/channel-event.js";

/**
 * Consumer-side merging of completion wakes. K parallel delegations (or background jobs) used to
 * settle into K separate main-agent turns, each re-reading the whole session to handle one result
 * — and with the event queue capped at a handful of items, the rest waited out a 30s+ retry. Now
 * the turn that starts one completion wake also takes every other one still waiting for this
 * channel, so results that arrive while the channel is busy are handled together in the next turn.
 * Nothing is delayed to make that happen: the first result still wakes the channel immediately.
 *
 * Only chat-level wakes merge. A task-bound wake carries `internalWake` and goes through its own
 * claim (`task-wake.ts`), which already lets sibling wakes of one fan-out drop out once the task
 * is reopened.
 */

/** The merged turn's prompt grows with every result's tail; past this many it is better split. */
export const MAX_COALESCED_WAKES = 6;

const COMPLETION_WAKE_ID = /^(subagent|job):.+:done$/;

export function isCoalescableWake(event: ChannelEvent): boolean {
	return !event.internalWake && typeof event.dispatchId === "string" && COMPLETION_WAKE_ID.test(event.dispatchId);
}

/** The primary wake keeps its own text (and `[KIND:id]` tag) first; the others follow it. */
export function mergeCompletionWakes(primary: ChannelEvent, others: ChannelEvent[]): ChannelEvent {
	if (others.length === 0) return primary;
	const header =
		`[${others.length} more completion wake(s) arrived while this channel was busy and are delivered with the one above. ` +
		"Handle all of them in this turn; reply with exactly [SILENT] only if none of them needs a follow-up.]";
	return {
		...primary,
		text: [primary.text, header, ...others.map((event) => event.text)].join("\n\n---\n\n"),
	};
}
