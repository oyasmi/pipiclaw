/**
 * What `POST /v1/responses` and WebSocket `response.create` may carry (spec 061, D14, INV-9). The
 * API accepts only what Pipiclaw can really honour, and says so for the rest: a field that would
 * change behaviour is refused by name, never silently dropped. The table below is the policy;
 * `validateCreateRequest` is the only code that reads it.
 */
import { isPlainObject } from "../shared/type-guards.js";
import { badRequest } from "./errors.js";
import { MAX_METADATA_KEY_CHARS, MAX_METADATA_PAIRS, MAX_METADATA_VALUE_CHARS } from "./limits.js";
import { MODEL_NAME } from "./response-record.js";

export interface CreateRequest {
	store: boolean;
	instructions?: string;
	/** The raw `input`; `input.ts` turns it into a message. */
	input: unknown;
	conversation?: string;
	previousResponseId?: string;
	stream: boolean;
	background: boolean;
	metadata: Record<string, string> | null;
}

/** How a request field is treated. */
type Rule =
	/** Understood; its own validator below checks the value. */
	| "handled"
	/** Absent or `null` only: setting it would ask for behaviour Pipiclaw does not have. */
	| { reject: string }
	/** A hint that does not change behaviour: accepted and dropped. */
	| "ignore";

const NOT_NEGOTIABLE = "Pipiclaw's agent decides this itself; omit it.";

const POLICY: Record<string, Rule> = {
	model: "handled",
	input: "handled",
	conversation: "handled",
	previous_response_id: "handled",
	stream: "handled",
	background: "handled",
	stream_options: "handled",
	metadata: "handled",
	store: "handled",
	instructions: "handled",
	// Behaviour only the agent's own configuration may set.
	tools: { reject: "Pipiclaw's agent uses its own tools; client-side tools are not supported." },
	tool_choice: { reject: NOT_NEGOTIABLE },
	parallel_tool_calls: { reject: NOT_NEGOTIABLE },
	max_tool_calls: { reject: NOT_NEGOTIABLE },
	prompt: { reject: "Prompt templates are not supported; put durable instructions in the workspace root AGENTS.md." },
	text: { reject: "Output formats are not supported; the agent replies in text." },
	reasoning: { reject: "Reasoning effort is set with /model, not per request." },
	temperature: { reject: NOT_NEGOTIABLE },
	top_p: { reject: NOT_NEGOTIABLE },
	top_logprobs: { reject: NOT_NEGOTIABLE },
	max_output_tokens: { reject: NOT_NEGOTIABLE },
	truncation: { reject: NOT_NEGOTIABLE },
	context_management: { reject: "Context is managed by the server (compaction, /new); omit it." },
	include: { reject: "Extra output fields are not supported; omit `include`." },
	moderation: { reject: NOT_NEGOTIABLE },
	access_programs: { reject: NOT_NEGOTIABLE },
	prompt_cache_options: { reject: NOT_NEGOTIABLE },
	prompt_cache_retention: { reject: NOT_NEGOTIABLE },
	// Hints: ignoring them changes nothing.
	user: "ignore",
	safety_identifier: "ignore",
	prompt_cache_key: "ignore",
	service_tier: "ignore",
};

/** WebSocket `response.create` is already a stream, and a response there is never a background one. */
const FORBIDDEN_OVER_WEBSOCKET = ["stream", "stream_options", "background"] as const;

function absent(value: unknown): boolean {
	return value === undefined || value === null;
}

function optionalBoolean(body: Record<string, unknown>, field: string): boolean {
	const value = body[field];
	if (absent(value)) return false;
	if (typeof value !== "boolean") throw badRequest("invalid_value", `\`${field}\` must be a boolean.`, field);
	return value;
}

function validateMetadata(value: unknown): Record<string, string> | null {
	if (absent(value)) return null;
	if (!isPlainObject(value)) {
		throw badRequest("invalid_value", "`metadata` must be an object of string keys and string values.", "metadata");
	}
	const entries = Object.entries(value);
	if (entries.length > MAX_METADATA_PAIRS) {
		throw badRequest("invalid_value", `\`metadata\` may hold at most ${MAX_METADATA_PAIRS} pairs.`, "metadata");
	}
	for (const [key, entry] of entries) {
		if (key.length > MAX_METADATA_KEY_CHARS || typeof entry !== "string" || entry.length > MAX_METADATA_VALUE_CHARS) {
			throw badRequest(
				"invalid_value",
				`\`metadata\` keys are at most ${MAX_METADATA_KEY_CHARS} characters and values are strings of at most ${MAX_METADATA_VALUE_CHARS}.`,
				`metadata.${key}`,
			);
		}
	}
	return Object.fromEntries(entries) as Record<string, string>;
}

/** The `metadata` an update may set (conversations share the rules). */
export const validateMetadataParam = validateMetadata;

function conversationId(value: unknown): string | undefined {
	if (absent(value)) return undefined;
	if (typeof value === "string") return value;
	if (isPlainObject(value) && typeof value.id === "string" && Object.keys(value).length === 1) return value.id;
	throw badRequest("invalid_value", '`conversation` must be a conversation id or `{ "id": … }`.', "conversation");
}

/** Check a create request against the policy and read it. Throws a `WebApiError` naming the first violation. */
export function validateCreateRequest(body: unknown, transport: "http" | "websocket"): CreateRequest {
	if (!isPlainObject(body)) {
		throw badRequest("invalid_value", "The request body must be a JSON object.");
	}
	if (transport === "websocket") {
		for (const field of FORBIDDEN_OVER_WEBSOCKET) {
			if (body[field] !== undefined) {
				throw badRequest(
					"unsupported_parameter",
					`\`${field}\` must not be set over WebSocket: the connection already streams.`,
					field,
				);
			}
		}
	}

	for (const [field, value] of Object.entries(body)) {
		const rule = POLICY[field];
		if (rule === undefined) {
			throw badRequest("unknown_parameter", `Unknown parameter \`${field}\`.`, field);
		}
		if (typeof rule === "object" && !absent(value)) {
			throw badRequest("unsupported_parameter", `\`${field}\` is not supported: ${rule.reject}`, field);
		}
	}

	if (!absent(body.model) && body.model !== MODEL_NAME) {
		throw badRequest(
			"unsupported_value",
			`\`model\` must be "${MODEL_NAME}". Switch the underlying model with the /model command.`,
			"model",
		);
	}
	if (!absent(body.store) && typeof body.store !== "boolean") {
		throw badRequest("invalid_value", "`store` must be a boolean.", "store");
	}
	if (!absent(body.instructions) && typeof body.instructions !== "string")
		throw badRequest("invalid_value", "`instructions` must be a string.", "instructions");
	if (!absent(body.service_tier) && body.service_tier !== "auto" && body.service_tier !== "default") {
		throw badRequest("unsupported_value", '`service_tier` must be "auto" or "default".', "service_tier");
	}
	if (body.input === undefined || body.input === null) {
		throw badRequest("missing_required_parameter", "`input` is required.", "input");
	}

	const stream = optionalBoolean(body, "stream");
	const background = optionalBoolean(body, "background");
	if (background && body.store === false)
		throw badRequest(
			"invalid_value",
			"Background responses need `store: true` so their result can be retrieved.",
			"store",
		);
	if (!absent(body.stream_options)) {
		if (!stream) {
			throw badRequest("invalid_value", "`stream_options` is only allowed with `stream: true`.", "stream_options");
		}
		const options = body.stream_options;
		if (!isPlainObject(options))
			throw badRequest("invalid_value", "`stream_options` must be an object.", "stream_options");
		for (const [key, value] of Object.entries(options)) {
			// Obfuscation pads events against side channels; Pipiclaw sends none, which changes no semantics.
			if (key !== "include_obfuscation" || typeof value !== "boolean") {
				throw badRequest(
					"unknown_parameter",
					`Unknown parameter \`stream_options.${key}\`.`,
					`stream_options.${key}`,
				);
			}
		}
	}

	const conversation = conversationId(body.conversation);
	const previous = absent(body.previous_response_id) ? undefined : body.previous_response_id;
	if (previous !== undefined && typeof previous !== "string") {
		throw badRequest("invalid_value", "`previous_response_id` must be a string.", "previous_response_id");
	}
	if (conversation !== undefined && previous !== undefined) {
		throw badRequest(
			"invalid_value",
			"`conversation` and `previous_response_id` cannot be used together.",
			"previous_response_id",
		);
	}

	return {
		store: body.store !== false,
		...(typeof body.instructions === "string" ? { instructions: body.instructions } : {}),
		input: body.input,
		...(conversation !== undefined ? { conversation } : {}),
		...(previous !== undefined ? { previousResponseId: previous } : {}),
		stream,
		background,
		metadata: validateMetadata(body.metadata),
	};
}
