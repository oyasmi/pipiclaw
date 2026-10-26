/**
 * `/v1/conversations` (spec 061, D12/D13): create, retrieve, update metadata, list items. A
 * conversation is a channel; its items are what its responses said and were asked, not the model's
 * context. Deleting and editing items are not offered (404).
 */
import type { FastifyInstance } from "fastify";
import { badRequest, notFound } from "../errors.js";
import { type RouteContext, sendError } from "../http.js";
import { conversationItems, defaultPage, paginate, UnknownCursorError } from "../items.js";
import { MAX_PAGE_LIMIT } from "../limits.js";
import { validateMetadataParam } from "../request-policy.js";
import type { ConversationRecord } from "../store.js";

function toApiConversation(conversation: ConversationRecord) {
	return {
		id: conversation.id,
		object: "conversation" as const,
		created_at: conversation.created_at,
		metadata: conversation.metadata ?? {},
	};
}

const ITEMS_QUERY = {
	type: "object",
	additionalProperties: false,
	properties: {
		after: { type: "string" },
		limit: { type: "integer", minimum: 1, maximum: MAX_PAGE_LIMIT },
		order: { type: "string", enum: ["asc", "desc"] },
		include: { type: "array", maxItems: 0 },
	},
} as const;

export function registerConversationRoutes(app: FastifyInstance, { service }: RouteContext): void {
	app.post("/v1/conversations", async (request, reply) => {
		const body = (request.body ?? {}) as Record<string, unknown>;
		for (const key of Object.keys(body)) {
			if (key !== "metadata" && key !== "items") {
				return sendError(reply, badRequest("unknown_parameter", `Unknown parameter \`${key}\`.`, key));
			}
		}
		if (Array.isArray(body.items) ? body.items.length > 0 : body.items !== undefined && body.items !== null) {
			return sendError(
				reply,
				badRequest("unsupported_parameter", "Seeding a conversation with `items` is not supported.", "items"),
			);
		}
		const conversation = await service.store.createConversation(
			request.principal.name,
			validateMetadataParam(body.metadata),
		);
		request.auditConversationId = conversation.id;
		return toApiConversation(conversation);
	});

	app.get<{ Params: { id: string } }>("/v1/conversations/:id", async (request, reply) => {
		try {
			const conversation = service.conversationFor(request.principal, request.params.id);
			request.auditConversationId = conversation.id;
			return toApiConversation(conversation);
		} catch (error) {
			return sendError(reply, error as never);
		}
	});

	app.post<{ Params: { id: string } }>("/v1/conversations/:id", async (request, reply) => {
		const conversation = service.conversationFor(request.principal, request.params.id);
		const body = (request.body ?? {}) as Record<string, unknown>;
		for (const key of Object.keys(body)) {
			if (key !== "metadata")
				return sendError(reply, badRequest("unknown_parameter", `Unknown parameter \`${key}\`.`, key));
		}
		if (body.metadata === undefined) {
			return sendError(reply, badRequest("missing_required_parameter", "`metadata` is required.", "metadata"));
		}
		request.auditConversationId = conversation.id;
		return toApiConversation(
			await service.store.updateConversationMetadata(conversation.id, validateMetadataParam(body.metadata)),
		);
	});

	app.delete<{ Params: { id: string } }>("/v1/conversations/:id", async (request) => {
		await service.deleteConversation(request.principal, request.params.id);
		request.auditConversationId = request.params.id;
		return { id: request.params.id, object: "conversation.deleted" as const, deleted: true };
	});

	app.get<{ Params: { id: string }; Querystring: { after?: string; limit?: number; order?: "asc" | "desc" } }>(
		"/v1/conversations/:id/items",
		{ schema: { querystring: ITEMS_QUERY } },
		async (request, reply) => {
			const conversation = service.conversationFor(request.principal, request.params.id);
			request.auditConversationId = conversation.id;
			try {
				return paginate(conversationItems(service.responsesOf(conversation.id)), defaultPage(request.query));
			} catch (error) {
				if (error instanceof UnknownCursorError) {
					return sendError(reply, notFound(`Item ${error.message}`));
				}
				throw error;
			}
		},
	);
}
