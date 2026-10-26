/**
 * The error format of the Web API (spec 061, D22): `{ error: { message, type, param, code } }`,
 * with the HTTP status chosen so the official SDK throws the right error class. Messages are
 * English and say what to do; they never echo a key, a file's contents or an internal detail.
 */
export type ErrorType = "invalid_request_error" | "rate_limit_error" | "server_error";

export class WebApiError extends Error {
	constructor(
		readonly status: number,
		readonly type: ErrorType,
		readonly code: string | null,
		message: string,
		readonly param: string | null = null,
		readonly headers: Record<string, string> = {},
	) {
		super(message);
		this.name = "WebApiError";
	}
}

export const badRequest = (code: string, message: string, param?: string) =>
	new WebApiError(400, "invalid_request_error", code, message, param ?? null);

export const unauthorized = () =>
	new WebApiError(
		401,
		"invalid_request_error",
		"invalid_api_key",
		"Missing or invalid API key. Send `Authorization: Bearer <key>`; create one with `pipiclaw webapi key add`.",
	);

export const forbidden = (code: string, message: string) =>
	new WebApiError(403, "invalid_request_error", code, message);

export const conflict = (code: string, message: string) => new WebApiError(409, "invalid_request_error", code, message);
export const notFound = (what: string, code = "not_found") =>
	new WebApiError(404, "invalid_request_error", code, `${what} was not found.`);

export const tooManyRequests = (message: string, retryAfterSeconds: number) =>
	new WebApiError(429, "rate_limit_error", "rate_limit_exceeded", message, null, {
		"retry-after": String(retryAfterSeconds),
	});

export const serverError = (message = "The server hit an internal error.") =>
	new WebApiError(500, "server_error", "server_error", message);

export const unavailable = (message: string) => new WebApiError(503, "server_error", "service_unavailable", message);

export interface ErrorBody {
	error: { message: string; type: ErrorType; param: string | null; code: string | null };
}

export function errorBody(error: WebApiError): ErrorBody {
	return { error: { message: error.message, type: error.type, param: error.param, code: error.code } };
}

/** The error event a WebSocket connection carries instead of an HTTP status line. */
export interface WsErrorEnvelope {
	type: "error";
	status: number;
	error: ErrorBody["error"];
	stream_id?: string;
}

export function wsErrorEnvelope(error: WebApiError, streamId?: string): WsErrorEnvelope {
	return {
		type: "error",
		status: error.status,
		error: errorBody(error).error,
		...(streamId !== undefined ? { stream_id: streamId } : {}),
	};
}
