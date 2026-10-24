/**
 * The Web API's core (spec 061, D12–D21): turns a validated request into a message for the
 * runtime's `Ingress`, follows it to a Response, and routes everything the runtime says back —
 * turn events, command replies, dropped messages — to the Response it belongs to. Every route and
 * the WebSocket handler go through here; nothing outside this file creates a Response.
 */

import type { ChannelContext, TurnEvent, TurnOutcome } from "../channel/channel-context.js";
import type { InboundMessage, Ingress, IngressResult } from "../channel/ingress.js";
import type { PushMessage, TurnInfo } from "../channel/transport.js";
import * as log from "../log.js";
import { errorMessage } from "../shared/text-utils.js";
import { createEmptyUsageTotals } from "../usage/totals.js";
import type { Principal } from "./auth.js";
import {
	badRequest,
	forbidden,
	notFound,
	serverError,
	tooManyRequests,
	unavailable,
	type WebApiError,
} from "./errors.js";
import { channelIdOf, isConversationId, newId } from "./ids.js";
import type { ParsedInput } from "./input.js";
import { STREAM_REPLAY_TTL_MS } from "./limits.js";
import type { CreateRequest } from "./request-policy.js";
import { nowSeconds, type ResponseRecord, toApiUsage } from "./response-record.js";
import { LiveResponse } from "./response-state.js";
import type { ConversationRecord, WebApiStore } from "./store.js";

/** A steering input the caller was told is accepted but that has not yet taken effect. */
export interface PendingSteer {
	steerId: string;
	/** The id the successor response will have. */
	successorId: string;
	targetId: string;
	conversationId: string;
	principal: Principal;
	input: ParsedInput;
	/** Told when the successor exists (WebSocket mode forwards its events on the same lane). */
	onSuccessor?: (successor: LiveResponse) => void;
}

export interface ServiceOptions {
	store: WebApiStore;
	/** How long an ended response's event log stays replayable. */
	replayTtlMs?: number;
}

const NO_OUTPUT: ChannelContext = { emit: () => undefined, finish: async () => undefined };

/** The reason a caller sees for a refusal the ingress decided. */
export function rejectionError(result: Extract<IngressResult, { kind: "rejected" }>): WebApiError {
	const { reason } = result;
	switch (reason.code) {
		case "control_command":
			return badRequest(
				"unsupported_value",
				`\`/${reason.command}\` as text is not supported here: use POST /v1/responses/{id}/cancel to stop a response, \`response.steer\` over WebSocket to steer one, or send a new message.`,
				"input",
			);
		case "desk_not_allowed":
			return forbidden("desk_not_allowed", `This key may not use desk "${reason.desk}".`);
		case "queue_full":
			return tooManyRequests("This conversation already has too many requests waiting; retry shortly.", 5);
		case "shutting_down":
			return unavailable("The server is shutting down; retry shortly.");
	}
}

export class WebApiService {
	private ingressRef: Ingress | undefined;
	/** Responses that are running, waiting, or ended within the replay window. */
	private readonly live = new Map<string, LiveResponse>();
	private readonly pendingSteers = new Map<string, PendingSteer>();
	private readonly replayTtlMs: number;
	readonly store: WebApiStore;

	constructor(options: ServiceOptions) {
		this.store = options.store;
		this.replayTtlMs = options.replayTtlMs ?? STREAM_REPLAY_TTL_MS;
	}

	setIngress(ingress: Ingress | undefined): void {
		this.ingressRef = ingress;
	}

	get ingress(): Ingress {
		if (!this.ingressRef) throw serverError("The Web API is not started.");
		return this.ingressRef;
	}

	// ---- lookup ----------------------------------------------------------------------------

	getLive(id: string): LiveResponse | undefined {
		return this.live.get(id);
	}

	/** The record of a response: the live one while it runs, the stored one afterwards. */
	findRecord(id: string): ResponseRecord | undefined {
		return this.live.get(id)?.record ?? this.store.getResponse(id);
	}

	/** A conversation the caller may use; a stranger's is as good as absent. */
	conversationFor(principal: Principal, id: string): ConversationRecord {
		const conversation = isConversationId(id) ? this.store.getConversation(id) : undefined;
		if (!conversation || !canAccess(principal, conversation.owner)) throw notFound(`Conversation ${id}`);
		return conversation;
	}

	recordFor(principal: Principal, id: string): ResponseRecord {
		const record = this.findRecord(id);
		if (!record || !canAccess(principal, record.owner)) throw notFound(`Response ${id}`);
		return record;
	}

	/** The responses of a conversation, with a running one shown as it stands. */
	responsesOf(conversationId: string): ResponseRecord[] {
		return this.store.listResponses(conversationId).map((stored) => this.live.get(stored.id)?.record ?? stored);
	}

	// ---- creating --------------------------------------------------------------------------

	/**
	 * Admit one message. The response exists in memory first and is invisible until the ingress has
	 * decided what to do with the message, so a refused request leaves nothing behind (INV-5), and
	 * whatever the runtime says in the meantime (a command's reply, an early turn event) waits for
	 * the response to be announced.
	 */
	async create(principal: Principal, request: CreateRequest, input: ParsedInput): Promise<LiveResponse> {
		const target = this.resolveTarget(principal, request);
		// A refused message may leave an empty conversation behind; it holds nothing and is listed nowhere.
		if (target.isNew) await this.store.createConversation(target.owner, null, target.conversationId);
		const id = newId("resp");
		const record: ResponseRecord = {
			id,
			conversation_id: target.conversationId,
			owner: target.owner,
			status: "queued",
			created_at: nowSeconds(),
			completed_at: null,
			previous_response_id: target.previousResponseId,
			background: request.background,
			metadata: request.metadata,
			input_items: input.items,
			output: [],
			usage: null,
			error: null,
			incomplete_details: null,
		};
		const live = this.register(record, request.background && request.stream);
		const message: InboundMessage = {
			channelId: channelIdOf(target.conversationId),
			user: principal.name,
			userName: principal.name,
			text: input.text,
			...(input.attachments.length > 0 ? { attachments: input.attachments } : {}),
			ref: id,
			ts: String(Date.now()),
			...(principal.desks ? { allowedDesks: principal.desks } : {}),
		};
		let result: IngressResult;
		try {
			result = await this.ingress.receive(message);
		} catch (error) {
			this.live.delete(id);
			log.logWarn("webapi.ingress.failed", "Ingress refused a message with an error", {
				reason: errorMessage(error),
			});
			throw serverError();
		}
		if (result.kind === "rejected") {
			this.live.delete(id);
			throw rejectionError(result);
		}
		live.announce(result.kind === "queued" ? "queued" : "in_progress");
		if (result.kind === "replied") live.complete(toApiUsage(createEmptyUsageTotals()));
		return live;
	}

	private resolveTarget(
		principal: Principal,
		request: CreateRequest,
	): { conversationId: string; owner: string; previousResponseId: string | null; isNew: boolean } {
		if (request.conversation !== undefined) {
			const conversation = this.conversationFor(principal, request.conversation);
			return {
				conversationId: conversation.id,
				owner: conversation.owner,
				previousResponseId: this.store.latestResponseId(conversation.id) ?? null,
				isNew: false,
			};
		}
		if (request.previousResponseId !== undefined) {
			const previous = this.findRecord(request.previousResponseId);
			if (!previous || !canAccess(principal, previous.owner)) {
				throw notFound(`Response ${request.previousResponseId}`, "previous_response_not_found");
			}
			if (this.store.latestResponseId(previous.conversation_id) !== previous.id) {
				throw badRequest(
					"branching_not_supported",
					"Only the latest response of a conversation can be continued; branching is not supported.",
					"previous_response_id",
				);
			}
			return {
				conversationId: previous.conversation_id,
				owner: previous.owner,
				previousResponseId: previous.id,
				isNew: false,
			};
		}
		return { conversationId: newId("conv"), owner: principal.name, previousResponseId: null, isNew: true };
	}

	private register(record: ResponseRecord, replayable = false): LiveResponse {
		const live = new LiveResponse(
			record,
			{
				persist: (snapshot) => this.store.saveResponse(snapshot),
				onTerminal: (ended) => {
					const timer = setTimeout(() => this.live.delete(ended.id), this.replayTtlMs);
					timer.unref?.();
				},
			},
			replayable,
		);
		this.live.set(record.id, live);
		return live;
	}

	// ---- ending ----------------------------------------------------------------------------

	/**
	 * Cancel a response the caller no longer wants (`cancel`, a dropped connection): what has not
	 * started is taken out of the queue, what is running is stopped like `/stop`.
	 */
	async cancel(live: LiveResponse): Promise<void> {
		if (live.terminal) return;
		const channelId = channelIdOf(live.record.conversation_id);
		const wasWaiting = live.status === "queued";
		live.cancel();
		this.pendingSteers.forEach((steer, ref) => {
			if (steer.targetId === live.id) this.pendingSteers.delete(ref);
		});
		const dropped = wasWaiting && this.ingress.dropQueued(channelId, live.id);
		if (!dropped) await this.ingress.cancel(channelId);
	}

	/** Fail whatever is still running: the process is going away. */
	async shutdown(): Promise<void> {
		for (const live of this.live.values()) {
			if (!live.terminal) live.fail("服务关闭，回合被中断。");
		}
		await Promise.all([...this.live.values()].map((live) => live.whenPersisted()));
	}

	// ---- the runtime talks back ------------------------------------------------------------

	openTurn(turn: TurnInfo, opts: { quiet: boolean }): ChannelContext {
		const live = this.liveFor(turn);
		if (live) {
			live.start();
			return new ResponseTurn(this, live, opts.quiet);
		}
		if (turn.ref !== undefined) return NO_OUTPUT;
		return new SyntheticTurn(this, turn);
	}

	/** The response a turn answers: the one that was asked, or the successor a steering input made. */
	private liveFor(turn: TurnInfo): LiveResponse | undefined {
		if (turn.ref === undefined) return undefined;
		const existing = this.live.get(turn.ref);
		if (existing) return existing;
		const steer = this.pendingSteers.get(turn.ref);
		return steer ? this.createSuccessor(steer, "in_progress") : undefined;
	}

	push(channelId: string, message: PushMessage): boolean {
		if (message.ref !== undefined) {
			const live = this.live.get(message.ref);
			if (!live || live.terminal) return false;
			live.addMessage("final_answer", message.text);
			return true;
		}
		const conversation = this.store.getConversation(channelId.slice("webapi:".length));
		if (!conversation) return false;
		// A notice nobody asked for is a response of its own: one `final_answer`, already complete.
		const response = this.synthesize(conversation);
		response.add(message.text);
		response.complete({ kind: "completed", usage: createEmptyUsageTotals() });
		return true;
	}

	/** Messages that were queued behind a stopped turn will never run. */
	dropped(refs: string[]): void {
		for (const ref of refs) {
			this.live.get(ref)?.cancel();
			this.pendingSteers.delete(ref);
		}
	}

	// ---- responses nobody asked for (task reports, wake results) ---------------------------

	/** A response with no request behind it, in `conversation`: its `input_items` are empty (INV-4). */
	synthesize(conversation: ConversationRecord): { add(text: string): void; complete(outcome: TurnOutcome): void } {
		let live: LiveResponse | undefined;
		const open = (): LiveResponse => {
			if (live) return live;
			live = this.register({
				id: newId("resp"),
				conversation_id: conversation.id,
				owner: conversation.owner,
				status: "in_progress",
				created_at: nowSeconds(),
				completed_at: null,
				previous_response_id: this.store.latestResponseId(conversation.id) ?? null,
				background: false,
				metadata: null,
				input_items: [],
				output: [],
				usage: null,
				error: null,
				incomplete_details: null,
			});
			live.announce("in_progress");
			return live;
		};
		return {
			add: (text) => {
				const response = open();
				response.addMessage("final_answer", text);
			},
			complete: (outcome) => {
				// A turn that had nothing to say makes no response; one that said something ends it.
				if (!live) return;
				if (outcome.kind === "failed") live.fail(outcome.message ?? "回合异常结束。", toApiUsage(outcome.usage));
				else if (outcome.kind === "cancelled") live.cancel();
				else live.complete(toApiUsage(outcome.usage));
			},
		};
	}

	// ---- steering --------------------------------------------------------------------------

	registerSteer(steer: PendingSteer): void {
		this.pendingSteers.set(steer.successorId, steer);
	}

	pendingSteersOf(targetId: string): PendingSteer[] {
		return [...this.pendingSteers.values()].filter((steer) => steer.targetId === targetId);
	}

	forgetSteer(successorId: string): void {
		this.pendingSteers.delete(successorId);
	}

	/**
	 * The running response was steered: it ends `incomplete` and its successor takes over. Returns
	 * the successor; `undefined` when no steering input was waiting (a message the SDK injected on
	 * its own), in which case the response simply carries on.
	 */
	splitForSteer(current: LiveResponse): LiveResponse | undefined {
		const steer = this.pendingSteersOf(current.id)[0];
		if (!steer) return undefined;
		current.incomplete("steered");
		return this.createSuccessor(steer, "in_progress");
	}

	private createSuccessor(steer: PendingSteer, initial: "queued" | "in_progress"): LiveResponse {
		this.pendingSteers.delete(steer.successorId);
		const target = this.findRecord(steer.targetId);
		const conversation = this.store.getConversation(steer.conversationId);
		const live = this.register({
			id: steer.successorId,
			conversation_id: steer.conversationId,
			owner: conversation?.owner ?? steer.principal.name,
			status: "in_progress",
			created_at: nowSeconds(),
			completed_at: null,
			previous_response_id: steer.targetId,
			background: false,
			metadata: target?.metadata ?? null,
			input_items: steer.input.items,
			output: [],
			usage: null,
			error: null,
			incomplete_details: null,
		});
		live.announce(initial);
		steer.onSuccessor?.(live);
		return live;
	}
}

export function canAccess(principal: Principal, owner: string): boolean {
	return principal.local || principal.name === owner;
}

/** A turn that answers a request: its events become the response's items. */
class ResponseTurn implements ChannelContext {
	constructor(
		private readonly service: WebApiService,
		private current: LiveResponse,
		private readonly quiet: boolean,
	) {}

	emit(event: TurnEvent): void {
		const live = this.current;
		switch (event.type) {
			case "tool.start":
				if (!this.quiet) live.beginToolCall(event.callId, event.tool, event.args);
				return;
			case "tool.end":
				if (!this.quiet) live.endToolCall(event.callId, event.ok, event.output);
				return;
			case "reasoning":
				if (!this.quiet) live.addReasoning(event.text);
				return;
			case "commentary":
				if (!this.quiet) live.addMessage("commentary", event.text);
				return;
			case "answer":
				live.addMessage("final_answer", event.text);
				return;
			case "steer.applied": {
				const successor = this.service.splitForSteer(live);
				if (successor) this.current = successor;
				return;
			}
			case "tool.update":
			case "compaction":
				return;
		}
	}

	async finish(outcome: TurnOutcome): Promise<void> {
		const live = this.current;
		const usage = toApiUsage(outcome.usage);
		switch (outcome.kind) {
			case "completed":
			case "silent":
				live.complete(usage);
				return;
			case "failed":
				live.fail(outcome.message ?? "回合异常结束。", usage);
				return;
			case "cancelled":
				live.cancel();
				return;
		}
	}
}

/** A wake's turn: no request behind it, so a response exists only if the turn says something. */
class SyntheticTurn implements ChannelContext {
	private readonly response: ReturnType<WebApiService["synthesize"]> | undefined;

	constructor(service: WebApiService, turn: TurnInfo) {
		const conversation = service.store.getConversation(turn.channelId.slice("webapi:".length));
		this.response = conversation ? service.synthesize(conversation) : undefined;
	}

	emit(event: TurnEvent): void {
		// A wake delivers its result, never its process.
		if (event.type === "answer") this.response?.add(event.text);
	}

	async finish(outcome: TurnOutcome): Promise<void> {
		this.response?.complete(outcome);
	}
}
