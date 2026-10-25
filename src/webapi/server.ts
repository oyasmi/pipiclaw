/**
 * The Web API's HTTP servers (spec 061, D24): Fastify, on the local socket and — when configured —
 * on TCP. Two instances share one route set (so a request knows which listener it came in on, which
 * decides whether a key and a Host check apply); everything that guards the door lives in the
 * `onRequest` hook, which runs before the body is read (INV-6).
 */
import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import * as log from "../log.js";
import type { SecurityLogEvent } from "../security/types.js";
import { errorMessage } from "../shared/text-utils.js";
import { authenticate, LOCAL_PRINCIPAL, type Principal } from "./auth.js";
import type { WebApiConfig } from "./config.js";
import { badRequest, forbidden, notFound, serverError, tooManyRequests, unauthorized, WebApiError } from "./errors.js";
import { type Listener, type RouteContext, sendError } from "./http.js";
import {
	KEEP_ALIVE_TIMEOUT_MS,
	MAX_BODY_BYTES,
	MAX_CONNECTIONS,
	MAX_WS_CONNECTION_MS,
	RATE_LIMIT_PER_MINUTE,
	REQUEST_TIMEOUT_MS,
} from "./limits.js";
import { registerConversationRoutes } from "./routes/conversations.js";
import { registerModelRoutes } from "./routes/models.js";
import { registerResponseRoutes } from "./routes/responses.js";
import { registerWebSocketRoute } from "./routes/websocket.js";
import type { WebApiService } from "./service.js";

export interface ServerDeps {
	config: WebApiConfig;
	service: WebApiService;
	/** Where the local socket is created; its directory is made private. */
	socketPath: string;
	audit: (event: SecurityLogEvent) => void;
	maxWebSocketMs?: number;
}

/** Hosts a loopback TCP listener answers to: a rebinding page cannot make a browser send these. */
function allowedHosts(config: WebApiConfig): Set<string> {
	const tcp = config.tcp;
	if (!tcp?.loopback) return new Set();
	const hosts = new Set([`127.0.0.1:${tcp.port}`, `localhost:${tcp.port}`, `[::1]:${tcp.port}`]);
	hosts.add(`${tcp.host.includes(":") ? `[${tcp.host}]` : tcp.host}:${tcp.port}`);
	return hosts;
}

function paramOf(error: FastifyError): string | null {
	const first = error.validation?.[0];
	if (!first) return null;
	const extra = (first.params as { additionalProperty?: string } | undefined)?.additionalProperty;
	const path = first.instancePath.replace(/^\//, "").replace(/\//g, ".");
	return extra ? (path ? `${path}.${extra}` : extra) : path || null;
}

/** Whatever Fastify or a route throws, in the API's own error format. */
function toWebApiError(error: unknown): WebApiError {
	if (error instanceof WebApiError) return error;
	const failure = error as FastifyError;
	if (failure.validation) {
		const param = paramOf(failure);
		return badRequest(
			failure.validation[0]?.keyword === "additionalProperties" ? "unknown_parameter" : "invalid_value",
			param ? `Invalid \`${param}\`.` : "The request is not valid.",
			param ?? undefined,
		);
	}
	switch (failure.code) {
		case "FST_ERR_CTP_BODY_TOO_LARGE":
			return new WebApiError(413, "invalid_request_error", "request_too_large", "The request body is too large.");
		case "FST_ERR_CTP_INVALID_MEDIA_TYPE":
			return new WebApiError(
				415,
				"invalid_request_error",
				"unsupported_media_type",
				"Send the body as application/json.",
			);
		case "FST_ERR_CTP_EMPTY_JSON_BODY":
			return badRequest("invalid_json", "The request body is empty; send a JSON object.");
		case "FST_ERR_CTP_INVALID_CONTENT_LENGTH":
		case "FST_ERR_CTP_INVALID_JSON_BODY":
			return badRequest("invalid_json", "The request body is not valid JSON.");
	}
	if (error instanceof SyntaxError || failure.statusCode === 400) {
		return badRequest("invalid_json", "The request body is not valid JSON.");
	}
	log.logWarn("webapi.request.failed", "Request failed", { reason: errorMessage(error) });
	return serverError();
}

async function buildApp(
	listener: Listener,
	deps: ServerDeps,
	https: { cert: Buffer; key: Buffer } | undefined,
): Promise<FastifyInstance> {
	const app = Fastify({
		logger: false,
		...(https ? { https } : {}),
		bodyLimit: MAX_BODY_BYTES,
		requestTimeout: REQUEST_TIMEOUT_MS,
		connectionTimeout: 0,
		keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
		onProtoPoisoning: "error",
		onConstructorPoisoning: "error",
		trustProxy: false,
		ajv: { customOptions: { removeAdditional: false, coerceTypes: "array", useDefaults: true, allErrors: false } },
	});
	app.server.maxConnections = MAX_CONNECTIONS;
	// JSON only: Fastify would otherwise also accept text/plain bodies.
	app.removeContentTypeParser("text/plain");
	app.decorateRequest("principal", undefined as unknown as Principal);

	app.addHook("onRequest", async (request, reply) => {
		if (request.headers.origin === undefined) return;
		// Write to raw so hijacked SSE responses retain these headers too. Register before
		// rate limiting and authentication so browsers can read their error responses.
		reply.raw.setHeader("access-control-allow-origin", "*");
		reply.raw.setHeader("access-control-expose-headers", "Retry-After");
	});

	if (listener === "tcp") {
		// First, so a flood is turned away before it reaches the key check.
		await app.register(rateLimit, {
			max: RATE_LIMIT_PER_MINUTE,
			timeWindow: "1 minute",
			keyGenerator: (request) => request.ip,
			errorResponseBuilder: (_request, context) =>
				tooManyRequests("Too many requests from this address.", Math.ceil(context.ttl / 1000)),
		});
	}

	const hosts = allowedHosts(deps.config);
	const remoteOf = (request: FastifyRequest): string => (listener === "socket" ? "socket" : request.ip);
	const refuse = (
		request: FastifyRequest,
		reply: FastifyReply,
		reason: "missing_key" | "invalid_key" | "host",
		error: WebApiError,
	) => {
		deps.audit({
			type: "webapi-auth",
			tool: "webapi",
			listener,
			reason,
			remote: remoteOf(request),
			method: request.method,
			path: request.url.split("?")[0] ?? "",
		});
		return sendError(reply, error);
	};

	app.addHook("onRequest", async (request, reply) => {
		if (listener === "tcp" && hosts.size > 0 && !hosts.has(String(request.headers.host ?? "").toLowerCase())) {
			return refuse(
				request,
				reply,
				"host",
				forbidden("host_not_allowed", "The Host header is not one this server answers to."),
			);
		}
		if (
			request.method === "OPTIONS" &&
			request.headers.origin !== undefined &&
			request.headers["access-control-request-method"] !== undefined
		) {
			// Preflight carries no bearer key; only the subsequent API request is authenticated.
			reply.header("access-control-allow-methods", "GET, POST, OPTIONS");
			reply.header("vary", "Access-Control-Request-Headers");
			const headers = request.headers["access-control-request-headers"];
			if (headers) reply.header("access-control-allow-headers", headers);
			return reply.code(204).send();
		}
		if (listener === "socket") {
			request.principal = LOCAL_PRINCIPAL;
			return;
		}
		const header = request.headers.authorization;
		const principal = authenticate(header, deps.config.keys);
		if (!principal) return refuse(request, reply, header ? "invalid_key" : "missing_key", unauthorized());
		request.principal = principal;
	});

	const audit = (request: FastifyRequest, status: number): void =>
		deps.audit({
			type: "webapi-request",
			tool: "webapi",
			listener,
			principal: request.principal?.name ?? "-",
			method: request.method,
			path: request.url.split("?")[0] ?? "",
			status,
			...(request.auditConversationId ? { conversationId: request.auditConversationId } : {}),
		});
	app.addHook("onResponse", async (request, reply) => audit(request, reply.statusCode));

	app.setErrorHandler((error, _request, reply) => sendError(reply, toWebApiError(error)));
	app.setNotFoundHandler((_request, reply) => sendError(reply, notFound("The requested endpoint", "not_found")));

	await app.register(websocket, { options: { maxPayload: MAX_BODY_BYTES } });
	const context: RouteContext = {
		service: deps.service,
		listener,
		maxWebSocketMs: deps.maxWebSocketMs ?? MAX_WS_CONNECTION_MS,
		auditHijacked: (request, status) => audit(request, status),
	};
	registerModelRoutes(app);
	registerConversationRoutes(app, context);
	registerResponseRoutes(app, context);
	registerWebSocketRoute(app, context);
	await app.ready();
	return app;
}

export class WebApiServer {
	private readonly apps: FastifyInstance[] = [];

	constructor(private readonly deps: ServerDeps) {}

	/** Create `app` for the instance under test without listening (route-level tests use `inject`). */
	static build(listener: Listener, deps: ServerDeps): Promise<FastifyInstance> {
		return buildApp(listener, deps, undefined);
	}

	async start(): Promise<void> {
		const { config, socketPath } = this.deps;
		if (config.socket) {
			const app = await buildApp("socket", this.deps, undefined);
			await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
			await chmod(dirname(socketPath), 0o700);
			// A stale socket file is safe to remove: the daemon lock says no other runtime owns this home.
			await rm(socketPath, { force: true });
			await app.listen({ path: socketPath });
			await chmod(socketPath, 0o600);
			this.apps.push(app);
			log.logInfoEvent("webapi.listening", "Web API listening on the local socket", {
				fields: { socket: socketPath },
			});
		}
		if (config.tcp) {
			const https = config.tls
				? { cert: await readFile(config.tls.cert), key: await readFile(config.tls.key) }
				: undefined;
			const app = await buildApp("tcp", this.deps, https);
			await app.listen({ host: config.tcp.host, port: config.tcp.port });
			this.apps.push(app);
			log.logInfoEvent("webapi.listening", "Web API listening on TCP", {
				fields: { host: config.tcp.host, port: config.tcp.port, tls: Boolean(https) },
			});
		}
	}

	async stop(): Promise<void> {
		// Open connections (a running stream, a WebSocket) must not hold shutdown up.
		await Promise.all(
			this.apps.splice(0).map(async (app) => {
				app.server.closeAllConnections?.();
				await app.close();
			}),
		);
		await rm(this.deps.socketPath, { force: true });
	}
}
