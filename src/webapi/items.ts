/**
 * Conversation items and input items (spec 061, D12/D21): the user-visible history of a
 * conversation, derived from its responses. These are delivery records — what each response said
 * and what it was asked — not the model's context, which compaction and `/new` rewrite freely.
 */
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from "./limits.js";
import type { InputItem, OutputItem, ResponseRecord } from "./response-record.js";

/** Every item Pipiclaw produces has an id (a message, an `mcp_call`, a reasoning item). */
export type ConversationItem = (InputItem | OutputItem) & { id: string };

/**
 * A conversation's items in the order they happened: each response's input, then its output.
 *
 * A cursor client must never see an item inserted before the one it holds, but a response's output
 * keeps growing until it ends. So the list stops at the first response still queued or running:
 * its own items are shown (they only ever append), the responses behind it wait until it settles.
 */
export function conversationItems(responses: readonly ResponseRecord[]): ConversationItem[] {
	const items: ConversationItem[] = [];
	for (const record of responses) {
		items.push(...(record.input_items as ConversationItem[]), ...(record.output as ConversationItem[]));
		if (record.status === "queued" || record.status === "in_progress") break;
	}
	return items;
}

export interface PageRequest {
	/** The id of the last item already seen, in the requested order. */
	after?: string;
	limit: number;
	order: "asc" | "desc";
}

export interface Page<T> {
	object: "list";
	data: T[];
	first_id: string | null;
	last_id: string | null;
	has_more: boolean;
}

export class UnknownCursorError extends Error {}

/** `items` are oldest first; the page is cut in the requested order. */
export function paginate<T extends { id: string }>(items: readonly T[], request: PageRequest): Page<T> {
	const ordered = request.order === "asc" ? [...items] : [...items].reverse();
	let start = 0;
	if (request.after !== undefined) {
		const index = ordered.findIndex((item) => item.id === request.after);
		if (index < 0) throw new UnknownCursorError(request.after);
		start = index + 1;
	}
	const data = ordered.slice(start, start + request.limit);
	return {
		object: "list",
		data,
		first_id: data[0]?.id ?? null,
		last_id: data.at(-1)?.id ?? null,
		has_more: start + request.limit < ordered.length,
	};
}

export const defaultPage = (query: { after?: string; limit?: number; order?: "asc" | "desc" }): PageRequest => ({
	...(query.after !== undefined ? { after: query.after } : {}),
	limit: Math.min(query.limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT),
	order: query.order ?? "desc",
});
