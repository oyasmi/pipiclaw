/**
 * `GET /v1/responses` upgraded to a WebSocket (spec 061, D14/D18/D19/D22). The connection carries
 * `response.create` (the same request an HTTP call makes, always streamed) and `response.steer`
 * (mid-turn steering). Named `stream_id` lanes run in parallel and each lane runs its responses one
 * at a time; a steered response ends `incomplete` and its successor carries on on the same lane.
 */
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import * as log from "../../log.js";
import { errorMessage } from "../../shared/text-utils.js";
import type { Principal } from "../auth.js";
import { badRequest, serverError, WebApiError, wsErrorEnvelope } from "../errors.js";
import type { RouteContext } from "../http.js";
import { channelIdOf, isStreamId, newId } from "../ids.js";
import { parseInput } from "../input.js";
import { MAX_PENDING_STEERS, MAX_WS_INFLIGHT_RESPONSES, MAX_WS_STREAMS } from "../limits.js";
import { validateCreateRequest } from "../request-policy.js";
import type { LiveResponse } from "../response-state.js";
import type { PendingSteer, WebApiService } from "../service.js";

const DEFAULT_LANE = "";
/** Close a connection whose client reads so slowly that this much is waiting to be written. */
const MAX_BUFFERED_BYTES = 32 * 1024 * 1024;

type SteerErrorCode =
	| "response_not_found"
	| "response_not_active"
	| "response_already_completed"
	| "invalid_input"
	| "too_many_pending_steers";

class Connection {
	/** Responses created on this connection (and their successors): the only ones it may steer. */
	private readonly responses = new Map<string, LiveResponse>();
	/** Each lane runs its responses one after another. */
	private readonly lanes = new Map<string, Promise<void>>();
	private inflight = 0;
	private readonly waiting: Array<() => void> = [];
	private closed = false;
	private readonly timer: NodeJS.Timeout;

	constructor(
		private readonly socket: WebSocket,
		private readonly principal: Principal,
		private readonly service: WebApiService,
		maxMs: number,
	) {
		this.timer = setTimeout(() => this.limitReached(), maxMs);
		this.timer.unref?.();
		socket.on("message", (data) => {
			void this.onMessage(data).catch((error: unknown) => {
				log.logWarn("webapi.ws.handler_failed", "WebSocket message handler failed", {
					reason: errorMessage(error),
				});
				this.sendError(serverError());
			});
		});
		socket.on("close", () => this.onClose());
		socket.on("error", () => this.onClose());
	}

	// ---- wire ------------------------------------------------------------------------------

	private send(message: unknown, streamId?: string): void {
		if (this.closed || this.socket.readyState !== this.socket.OPEN) return;
		const body = streamId ? { ...(message as object), stream_id: streamId } : message;
		this.socket.send(JSON.stringify(body));
		if (this.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
			log.logWarn("webapi.ws.slow_client", "WebSocket closed: the client is not reading");
			this.socket.close(1013, "client too slow");
		}
	}

	private sendError(error: WebApiError, streamId?: string): void {
		if (this.closed || this.socket.readyState !== this.socket.OPEN) return;
		this.socket.send(JSON.stringify(wsErrorEnvelope(error, streamId)));
	}

	private limitReached(): void {
		this.sendError(
			new WebApiError(
				400,
				"invalid_request_error",
				"websocket_connection_limit_reached",
				"This WebSocket connection reached its 60 minute limit; open a new connection to continue.",
			),
		);
		this.socket.close(1000, "connection limit reached");
	}

	private onClose(): void {
		if (this.closed) return;
		this.closed = true;
		clearTimeout(this.timer);
		// Whatever this connection was waiting for or running goes with it (D19).
		for (const live of this.responses.values()) {
			if (!live.terminal) void this.service.cancel(live);
		}
		for (const release of this.waiting.splice(0)) release();
	}

	// ---- messages --------------------------------------------------------------------------

	private async onMessage(data: import("ws").RawData): Promise<void> {
		let event: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(data.toString());
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
			event = parsed as Record<string, unknown>;
		} catch {
			this.sendError(badRequest("invalid_json", "A WebSocket message must be a JSON object."));
			return;
		}
		const streamId = typeof event.stream_id === "string" ? event.stream_id : undefined;
		try {
			switch (event.type) {
				case "response.create":
					await this.create(event);
					return;
				case "response.steer":
					await this.steer(event);
					return;
				default:
					throw badRequest(
						"invalid_value",
						"Only `response.create` and `response.steer` events are accepted.",
						"type",
					);
			}
		} catch (error) {
			if (error instanceof WebApiError) this.sendError(error, streamId);
			else throw error;
		}
	}

	// ---- response.create -------------------------------------------------------------------

	private laneFor(event: Record<string, unknown>): string {
		const streamId = event.stream_id;
		if (streamId === undefined || streamId === null) return DEFAULT_LANE;
		if (!isStreamId(streamId)) {
			throw new WebApiError(
				400,
				"invalid_request_error",
				"invalid_stream_id",
				"`stream_id` must be 1–64 letters, digits, `-` or `_`.",
				"stream_id",
			);
		}
		if (
			!this.lanes.has(streamId) &&
			[...this.lanes.keys()].filter((id) => id !== DEFAULT_LANE).length >= MAX_WS_STREAMS
		) {
			throw new WebApiError(
				400,
				"invalid_request_error",
				"websocket_stream_limit_reached",
				`A connection may use at most ${MAX_WS_STREAMS} named streams.`,
				"stream_id",
			);
		}
		return streamId;
	}

	private async create(event: Record<string, unknown>): Promise<void> {
		const lane = this.laneFor(event);
		const { type: _type, stream_id: _streamId, ...fields } = event;
		const request = validateCreateRequest(fields, "websocket");
		const input = parseInput(request.input);
		const streamId = lane === DEFAULT_LANE ? undefined : lane;

		// Each lane is a chain: a response starts when the one before it on the lane has ended.
		const previous = this.lanes.get(lane) ?? Promise.resolve();
		const run = previous.then(async () => {
			if (this.closed) return;
			await this.acquire();
			try {
				if (this.closed) return;
				const live = await this.service.create(this.principal, request, input);
				this.responses.set(live.id, live);
				this.laneOf.set(live.id, streamId);
				await this.follow(live, streamId);
			} catch (error) {
				if (error instanceof WebApiError) this.sendError(error, streamId);
				else {
					log.logWarn("webapi.ws.create_failed", "WebSocket response.create failed", {
						reason: errorMessage(error),
					});
					this.sendError(serverError(), streamId);
				}
			} finally {
				this.release();
			}
		});
		this.lanes.set(lane, run);
	}

	/** Forward `live`'s events, and its successors', until the chain of responses ends. */
	private async follow(first: LiveResponse, streamId: string | undefined): Promise<void> {
		let current: LiveResponse | undefined = first;
		while (current) {
			const live: LiveResponse = current;
			current = await this.forward(live, streamId);
		}
	}

	/** Send one response's events; resolves with its successor when it ended because it was steered. */
	private forward(live: LiveResponse, streamId: string | undefined): Promise<LiveResponse | undefined> {
		return new Promise((resolve) => {
			let successor: LiveResponse | undefined;
			this.successorWatchers.set(live.id, (next) => {
				successor = next;
			});
			live.subscribe(0, {
				onEvent: (logged) => this.send(logged, streamId),
				onEnd: () => {
					// The successor of a steered response is made in the same tick the response ends.
					queueMicrotask(() => {
						this.successorWatchers.delete(live.id);
						resolve(successor);
					});
				},
			});
		});
	}

	private readonly successorWatchers = new Map<string, (next: LiveResponse) => void>();
	/** The lane each response (and each successor) is on, so a late successor lands on the right one. */
	private readonly laneOf = new Map<string, string | undefined>();

	private async acquire(): Promise<void> {
		while (this.inflight >= MAX_WS_INFLIGHT_RESPONSES && !this.closed) {
			await new Promise<void>((resolve) => this.waiting.push(resolve));
		}
		this.inflight++;
	}

	private release(): void {
		this.inflight--;
		this.waiting.shift()?.();
	}

	// ---- response.steer --------------------------------------------------------------------

	private steerFailed(
		code: SteerErrorCode,
		message: string,
		target: LiveResponse | undefined,
		steerId?: string,
	): void {
		this.send({
			type: "response.steer.failed",
			sequence_number: target?.logLength ?? 0,
			error: { type: "invalid_request_error", code, message },
			steer: { ...(steerId ? { id: steerId } : {}), input: null },
		});
	}

	private async steer(event: Record<string, unknown>): Promise<void> {
		const targetId = event.previous_response_id;
		const target = typeof targetId === "string" ? this.responses.get(targetId) : undefined;
		if (!target) {
			this.steerFailed("response_not_found", "That response is not on this connection.", undefined);
			return;
		}
		if (target.terminal) {
			this.steerFailed("response_already_completed", "That response has already ended.", target);
			return;
		}
		if (target.status !== "in_progress") {
			this.steerFailed("response_not_active", "That response is not running yet.", target);
			return;
		}
		let input: ReturnType<typeof parseInput>;
		try {
			input = parseInput(event.input);
		} catch (error) {
			this.steerFailed(
				"invalid_input",
				error instanceof WebApiError ? error.message : "The input is not valid.",
				target,
			);
			return;
		}
		if (this.service.pendingSteersOf(target.id).length >= MAX_PENDING_STEERS) {
			this.steerFailed("too_many_pending_steers", "Too many steering inputs are waiting for this response.", target);
			return;
		}

		const steer: PendingSteer = {
			steerId: newId("steer"),
			successorId: newId("resp"),
			targetId: target.id,
			conversationId: target.record.conversation_id,
			principal: this.principal,
			input,
			onSuccessor: (successor) => this.adopt(target, successor),
		};
		this.service.registerSteer(steer);
		let result: Awaited<ReturnType<WebApiService["ingress"]["steer"]>>;
		try {
			result = await this.service.ingress.steer(channelIdOf(target.record.conversation_id), {
				channelId: channelIdOf(target.record.conversation_id),
				user: this.principal.name,
				userName: this.principal.name,
				text: input.text,
				...(input.attachments.length > 0 ? { attachments: input.attachments } : {}),
				ref: steer.successorId,
				ts: String(Date.now()),
				...(this.principal.desks ? { allowedDesks: this.principal.desks } : {}),
			});
		} catch (error) {
			this.service.forgetSteer(steer.successorId);
			throw error;
		}
		if (result.kind === "rejected") {
			this.service.forgetSteer(steer.successorId);
			this.steerFailed(result.code, "The running turn could not take this input.", target, steer.steerId);
			return;
		}
		this.send({
			type: "response.steer.accepted",
			sequence_number: target.logLength,
			steer: { id: steer.steerId, previous_response_id: target.id },
		});
	}

	/** A steering input became a response: forward it where the response it follows was going. */
	private adopt(target: LiveResponse, successor: LiveResponse): void {
		this.responses.set(successor.id, successor);
		this.laneOf.set(successor.id, this.laneOf.get(target.id));
		const watcher = this.successorWatchers.get(target.id);
		if (watcher) {
			watcher(successor);
			return;
		}
		// The response it follows has already been forwarded to its end: start a new forwarding.
		void this.follow(successor, this.laneOf.get(target.id));
	}
}

export function registerWebSocketRoute(app: FastifyInstance, context: RouteContext): void {
	const { service, maxWebSocketMs } = context;
	app.route({
		method: "GET",
		url: "/v1/responses",
		handler: async (_request, reply) =>
			reply.status(426).send({
				error: {
					message: "This endpoint is for WebSocket connections; upgrade the request.",
					type: "invalid_request_error",
					param: null,
					code: "upgrade_required",
				},
			}),
		wsHandler: (socket, request) => {
			context.auditHijacked(request, 101);
			new Connection(socket, request.principal, service, maxWebSocketMs);
		},
	});
}
