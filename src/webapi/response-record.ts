/**
 * The Web API's stored form of a Response, and how it becomes the API's Response object (spec 061,
 * D16/D23). A record is what `responses.jsonl` keeps; everything the API shows is derived from it,
 * so reading a finished response never depends on anything that only existed while it ran.
 */
import type {
	Response as ApiResponse,
	ResponseInputMessageItem,
	ResponseOutputItem,
	ResponseOutputMessage,
	ResponseStatus,
	ResponseUsage,
} from "openai/resources/responses/responses";
import type { ContextMessage } from "../channel/turn-context.js";
import type { UsageTotals } from "../usage/totals.js";

export type OutputItem = ResponseOutputItem;
/** A user message the client sent, as `input_items` and the conversation's items list show it. */
export type InputItem = ResponseInputMessageItem | ResponseOutputMessage;

export interface ResponseRecord {
	continuation?: ContextMessage[];
	desk?: string;
	store?: boolean;
	request_scoped?: boolean;
	context?: ContextMessage[];
	instructions?: string;
	id: string;
	conversation_id: string;
	/** The key name (or `local`) that created the conversation; only it (and `local`) may read the response. */
	owner: string;
	status: ResponseStatus;
	created_at: number;
	completed_at: number | null;
	previous_response_id: string | null;
	background: boolean;
	metadata: Record<string, string> | null;
	input_items: InputItem[];
	output: OutputItem[];
	usage: ResponseUsage | null;
	error: { code: "server_error"; message: string } | null;
	incomplete_details: { reason: string } | null;
}

export const MODEL_NAME = "pipiclaw";

export const TERMINAL_STATUSES: readonly ResponseStatus[] = ["completed", "failed", "cancelled", "incomplete"];
export const isTerminal = (status: ResponseStatus): boolean => TERMINAL_STATUSES.includes(status);

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/**
 * `UsageTotals.input` does not include the cache (`pi-ai` reports `prompt − cacheRead − cacheWrite`),
 * while the API's `input_tokens` does, so the cache is added back (B0, D16).
 */
export function toApiUsage(usage: UsageTotals): ResponseUsage {
	const input = usage.input + usage.cacheRead + usage.cacheWrite;
	return {
		input_tokens: input,
		input_tokens_details: { cached_tokens: usage.cacheRead, cache_write_tokens: usage.cacheWrite },
		output_tokens: usage.output,
		output_tokens_details: { reasoning_tokens: 0 },
		total_tokens: input + usage.output,
	};
}

/** What a response says in words: the `final_answer` messages, in order. */
export function outputTextOf(output: readonly OutputItem[]): string {
	return output
		.filter((item): item is ResponseOutputMessage => item.type === "message" && item.phase === "final_answer")
		.flatMap((message) => message.content.flatMap((part) => (part.type === "output_text" ? [part.text] : [])))
		.join("\n");
}

/** The API's Response object for a record. `skeleton` shows it as it looked when it was created. */
export function toApiResponse(
	record: ResponseRecord,
	options: { skeleton?: ResponseStatus } = {},
): ApiResponse & { store: boolean } {
	const skeleton = options.skeleton;
	const output = skeleton ? [] : record.output;
	return {
		id: record.id,
		object: "response",
		created_at: record.created_at,
		completed_at: skeleton ? null : record.completed_at,
		status: skeleton ?? record.status,
		model: MODEL_NAME,
		output,
		output_text: outputTextOf(output),
		usage: skeleton || !record.usage ? undefined : record.usage,
		error: skeleton || !record.error ? null : record.error,
		incomplete_details: skeleton || !record.incomplete_details ? null : (record.incomplete_details as never),
		conversation: record.request_scoped ? null : { id: record.conversation_id },
		store: record.store !== false,
		previous_response_id: record.previous_response_id,
		background: record.background,
		metadata: record.metadata,
		// Pipiclaw's own configuration decides these; the API reports their neutral values.
		access_programs: null,
		instructions: record.instructions ?? null,
		parallel_tool_calls: true,
		temperature: null,
		tool_choice: "auto",
		tools: [],
		top_p: null,
		max_output_tokens: null,
		truncation: "disabled",
	};
}
