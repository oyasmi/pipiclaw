/**
 * Every number the Web API's behaviour depends on (spec 061, D24). They are code constants, not
 * settings: `channel.json` carries intent (what is on, who may use it), not tuning.
 */

/** Largest request body, and the largest WebSocket message, in bytes. */
export const MAX_BODY_BYTES = 30 * 1024 * 1024;
/** How long the server waits for a request to arrive in full; it does not limit how long a turn runs. */
export const REQUEST_TIMEOUT_MS = 30_000;
/** Open connections across both listeners. */
export const MAX_CONNECTIONS = 64;
/** Requests per minute per source address on the TCP listener (the local socket is not limited). */
export const RATE_LIMIT_PER_MINUTE = 300;
/** Longest an idle keep-alive connection is held open. */
export const KEEP_ALIVE_TIMEOUT_MS = 65_000;

/** In-flight responses on one WebSocket connection; the rest wait their turn. */
export const MAX_WS_INFLIGHT_RESPONSES = 16;
/** Requests one WebSocket connection may have accepted but not yet started, and their size in bytes. */
export const MAX_WS_PENDING_REQUESTS = 32;
export const MAX_WS_PENDING_BYTES = 64 * 1024 * 1024;
/** Named `stream_id` lanes on one WebSocket connection. */
export const MAX_WS_STREAMS = 32;
/** A WebSocket connection is closed once it has been open this long (the OpenAI limit). */
export const MAX_WS_CONNECTION_MS = 60 * 60 * 1000;
/** Accepted steering inputs that have not yet taken effect, per response. */
export const MAX_PENDING_STEERS = 4;

/** How much of a tool's output an `mcp_call` item carries. */
export const MAX_TOOL_OUTPUT_CHARS = 4000;
/** How long a background stream's events stay replayable after the response ends. */
export const STREAM_REPLAY_TTL_MS = 5 * 60 * 1000;

/** Largest `metadata` the API accepts: pairs, key length, value length. */
export const MAX_METADATA_PAIRS = 16;
export const MAX_METADATA_KEY_CHARS = 64;
export const MAX_METADATA_VALUE_CHARS = 512;

/** Largest `input_file` once decoded. */
export const MAX_INBOUND_FILE_BYTES = 10 * 1024 * 1024;

/** Page sizes for list endpoints. */
export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;
