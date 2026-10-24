/**
 * `/v1/responses` over HTTP (spec 061, D13/D14/D17/D19/D20). One request is one message and one
 * Response; what the caller gets back — the finished object, an event stream, or the object at once
 * with the work continuing in the background — is the only thing the four modes differ in.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { badRequest, notFound } from "../errors.js";
import { type RouteContext, sendError } from "../http.js";
import { parseInput } from "../input.js";
import { defaultPage, paginate, UnknownCursorError } from "../items.js";
import { MAX_PAGE_LIMIT } from "../limits.js";
import { validateCreateRequest } from "../request-policy.js";
import { toApiResponse } from "../response-record.js";
import type { LiveResponse } from "../response-state.js";
import { openEventStream, pumpEvents } from "../stream.js";

const EMPTY_INCLUDE = { type: "array", maxItems: 0 } as const;

const RETRIEVE_QUERY = {
	type: "object",
	additionalProperties: false,
	properties: {
		stream: { type: "boolean" },
		starting_after: { type: "integer", minimum: 0 },
		include: EMPTY_INCLUDE,
		include_obfuscation: { type: "boolean" },
	},
} as const;

const INPUT_ITEMS_QUERY = {
	type: "object",
	additionalProperties: false,
	properties: {
		after: { type: "string" },
		limit: { type: "integer", minimum: 1, maximum: MAX_PAGE_LIMIT },
		order: { type: "string", enum: ["asc", "desc"] },
		include: EMPTY_INCLUDE,
	},
} as const;

export function registerResponseRoutes(app: FastifyInstance, context: RouteContext): void {
	const { service } = context;

	/** Cancel `live` if the caller walks away before it is done (a synchronous or streamed request). */
	function cancelOnDisconnect(request: FastifyRequest, live: LiveResponse): () => void {
		const socket = request.raw.socket;
		const onClose = () => {
			if (!live.terminal) void service.cancel(live);
		};
		socket.once("close", onClose);
		return () => socket.off("close", onClose);
	}

	app.post("/v1/responses", async (request, reply) => {
		const create = validateCreateRequest(request.body, "http");
		const input = parseInput(create.input);
		const live = await service.create(request.principal, create, input);
		request.auditConversationId = live.record.conversation_id;

		if (create.stream) {
			const stopWatching = create.background ? () => undefined : cancelOnDisconnect(request, live);
			reply.hijack();
			openEventStream(reply.raw);
			try {
				await pumpEvents(live, 0, reply.raw);
			} finally {
				stopWatching();
				reply.raw.end();
				context.auditHijacked(request, 200);
			}
			return reply;
		}
		if (create.background) return live.snapshot();

		// Synchronous: the caller waits for the end, and leaving cancels the work.
		const stopWatching = cancelOnDisconnect(request, live);
		try {
			await live.whenEnded();
		} finally {
			stopWatching();
		}
		return live.snapshot();
	});

	app.get<{ Params: { id: string }; Querystring: { stream?: boolean; starting_after?: number } }>(
		"/v1/responses/:id",
		{ schema: { querystring: RETRIEVE_QUERY } },
		async (request, reply) => {
			const record = service.recordFor(request.principal, request.params.id);
			request.auditConversationId = record.conversation_id;
			const live = service.getLive(record.id);
			if (!request.query.stream) return live ? live.snapshot() : toApiResponse(record);

			if (!live?.replayable) {
				return sendError(
					reply,
					badRequest(
						"stream_not_available",
						"Only a response created with `background: true` and `stream: true` can be streamed again, and only for a few minutes after it ends.",
						"stream",
					),
				);
			}
			const from = request.query.starting_after === undefined ? 0 : request.query.starting_after + 1;
			reply.hijack();
			openEventStream(reply.raw);
			try {
				await pumpEvents(live, from, reply.raw);
			} finally {
				reply.raw.end();
				context.auditHijacked(request, 200);
			}
			return reply;
		},
	);

	app.post<{ Params: { id: string } }>("/v1/responses/:id/cancel", async (request, reply) => {
		const record = service.recordFor(request.principal, request.params.id);
		request.auditConversationId = record.conversation_id;
		if (!record.background) {
			return sendError(
				reply,
				badRequest(
					"invalid_value",
					"Only a response created with `background: true` can be cancelled. To cancel a synchronous or streamed request, close the connection.",
				),
			);
		}
		const live = service.getLive(record.id);
		if (!live) return toApiResponse(record);
		await service.cancel(live);
		return live.snapshot();
	});

	app.get<{ Params: { id: string }; Querystring: { after?: string; limit?: number; order?: "asc" | "desc" } }>(
		"/v1/responses/:id/input_items",
		{ schema: { querystring: INPUT_ITEMS_QUERY } },
		async (request, reply) => {
			const record = service.recordFor(request.principal, request.params.id);
			request.auditConversationId = record.conversation_id;
			try {
				return paginate(record.input_items, defaultPage(request.query));
			} catch (error) {
				if (error instanceof UnknownCursorError) return sendError(reply, notFound(`Item ${error.message}`));
				throw error;
			}
		},
	);
}
