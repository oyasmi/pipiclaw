/**
 * What the route modules share with the server that mounts them (spec 061, D24): which listener a
 * request came in on, the service behind the routes, and the one way an error becomes a response.
 */
import type { FastifyReply } from "fastify";
import type { Principal } from "./auth.js";
import { errorBody, type WebApiError } from "./errors.js";
import type { WebApiService } from "./service.js";

export type Listener = "socket" | "tcp";

declare module "fastify" {
	interface FastifyRequest {
		principal: Principal;
		/** The conversation a request touched, for the audit record. */
		auditConversationId?: string;
	}
}

export interface RouteContext {
	service: WebApiService;
	listener: Listener;
	/** The longest a WebSocket connection may stay open (tests shorten it). */
	maxWebSocketMs: number;
	/** Record the end of a request that took over its own reply (a stream), which Fastify does not report. */
	auditHijacked(request: import("fastify").FastifyRequest, status: number): void;
}

export function sendError(reply: FastifyReply, error: WebApiError): FastifyReply {
	return reply.status(error.status).headers(error.headers).send(errorBody(error));
}
