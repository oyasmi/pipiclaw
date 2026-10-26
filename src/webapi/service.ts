/**
 * The Web API's core (spec 061, D12–D21): turns a validated request into a message for the
 * runtime's `Ingress`, follows it to a Response, and routes everything the runtime says back —
 * turn events, command replies, dropped messages — to the Response it belongs to. Every route and
 * the WebSocket handler go through here; nothing outside this file creates a Response.
 */

import { loadContextAt } from "../agent/session/context-snapshot.js";
import type { ChannelContext, TurnEvent, TurnOutcome } from "../channel/channel-context.js";
import type { InboundMessage, Ingress, IngressResult } from "../channel/ingress.js";
import type { PushMessage, TurnInfo } from "../channel/transport.js";
import type { ContextMessage } from "../channel/turn-context.js";
import { slashCommandName } from "../commands/catalog.js";
import * as log from "../log.js";
import { errorMessage } from "../shared/text-utils.js";
import { createEmptyUsageTotals } from "../usage/totals.js";
import type { Principal } from "./auth.js";
import {
	badRequest,
	conflict,
	forbidden,
	notFound,
	serverError,
	tooManyRequests,
	unavailable,
	type WebApiError,
} from "./errors.js";
import { channelIdOf, isConversationId, newId } from "./ids.js";
import { type ParsedInput, parseInput } from "./input.js";
import { STREAM_REPLAY_TTL_MS } from "./limits.js";
import type { CreateRequest } from "./request-policy.js";
import { isTerminal, nowSeconds, type ResponseRecord, toApiUsage } from "./response-record.js";
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
		case "request_capacity":
			return tooManyRequests("Too many request-scoped generations are running; retry after one completes.", 5);
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
	private accepting = true;
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

	/** A conversation the caller may use; a stranger's is as good as absent, and so is one being deleted. */
	conversationFor(principal: Principal, id: string): ConversationRecord {
		const conversation = isConversationId(id) ? this.store.getConversation(id) : undefined;
		if (!conversation || this.closing.has(id) || !canAccess(principal, conversation.owner))
			throw notFound(`Conversation ${id}`);
		return conversation;
	}

	/** Conversations whose delete is under way: no new message may bind them again meanwhile. */
	private readonly closing = new Set<string>();

	/**
	 * `DELETE /v1/conversations/{id}`: the conversation's channel is released by the runtime (its
	 * binding, runner and background scans) and its history removed. Refused while something runs.
	 */
	async deleteConversation(principal: Principal, id: string): Promise<void> {
		const conversation = this.conversationFor(principal, id);
		this.closing.add(conversation.id);
		try {
			if ((await this.ingress.closeChannel(channelIdOf(conversation.id))) === "busy") {
				throw conflict(
					"conversation_busy",
					"The conversation has a response running or queued; cancel it or wait for it to end, then delete again.",
				);
			}
			for (const record of this.store.listResponses(conversation.id)) this.live.delete(record.id);
			await this.store.deleteConversation(conversation.id);
		} finally {
			this.closing.delete(conversation.id);
		}
	}

	recordFor(principal: Principal, id: string): ResponseRecord {
		const record = this.findRecord(id);
		if (record?.store === false) throw notFound(`Response ${id}`);
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
		if (!this.accepting) throw unavailable("The server is shutting down; retry shortly.");
		const target = await this.resolveTarget(principal, request);
		const context = [...target.context, ...input.context];
		// A conversation's user messages are an ordinary channel turn (memory bootstrap, desk context,
		// commands, attachments saved to the desk), as a string input is. Only history with other roles,
		// and every request-scoped generation, is imported as context.
		const imported = target.requestScoped || input.context.some((message) => message.role !== "user");
		if (imported && input.binaryFile)
			throw badRequest(
				"unsupported_value",
				"Binary files (PDF, Office documents…) cannot be read inline. Send them in a `conversation` whose input is user messages only, where they are saved to the desk for the agent's tools; send text files here.",
				input.binaryFile,
			);
		const id = newId("resp");
		const record: ResponseRecord = {
			store: request.store,
			request_scoped: target.requestScoped,
			// Only a request-scoped generation is continued from its own input; what came before it is
			// its parent's, kept there. A conversation's context is its session (`context_ref`).
			...(target.requestScoped ? { context: input.context } : {}),
			...(target.previousResponseId && target.requestScoped ? { context_parent: target.previousResponseId } : {}),
			instructions: request.instructions,
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
		if (target.requestScoped) this.generationInputs.set(id, context);
		const message: InboundMessage = {
			channelId: channelIdOf(target.conversationId),
			user: principal.name,
			userName: principal.name,
			text: input.text,
			desk: target.desk,
			...(imported
				? { context: { messages: context, instructions: request.instructions } }
				: request.instructions !== undefined
					? { context: { messages: [], instructions: request.instructions } }
					: {}),
			...(!target.requestScoped && input.attachments.length > 0 ? { attachments: input.attachments } : {}),
			ref: id,
			ts: String(Date.now()),
			...(principal.desks ? { allowedDesks: principal.desks } : {}),
		};
		let result: IngressResult;
		try {
			if (target.requestScoped) {
				if (!this.ingress.execute) throw new Error("Request execution is unavailable.");
				result = await this.ingress.execute(message);
			} else result = await this.ingress.receive(message);
		} catch (error) {
			this.live.delete(id);
			this.generationInputs.delete(id);
			log.logWarn("webapi.ingress.failed", "Ingress refused a message with an error", {
				reason: errorMessage(error),
			});
			throw serverError();
		}
		if (result.kind === "rejected") {
			this.live.delete(id);
			this.generationInputs.delete(id);
			throw rejectionError(result);
		}
		live.announce(result.kind === "queued" ? "queued" : "in_progress");
		if (result.kind === "replied") live.complete(toApiUsage(createEmptyUsageTotals()));
		return live;
	}

	private async resolveTarget(
		principal: Principal,
		request: CreateRequest,
	): Promise<{
		conversationId: string;
		owner: string;
		previousResponseId: string | null;
		requestScoped: boolean;
		context: ContextMessage[];
		desk?: string;
	}> {
		if (request.conversation !== undefined) {
			const conversation = this.conversationFor(principal, request.conversation);
			return {
				conversationId: conversation.id,
				owner: conversation.owner,
				previousResponseId: this.store.latestResponseId(conversation.id) ?? null,
				requestScoped: false,
				context: [],
			};
		}
		if (request.previousResponseId !== undefined) {
			const previous = this.findRecord(request.previousResponseId);
			if (!previous || previous.store === false || !canAccess(principal, previous.owner)) {
				throw notFound(`Response ${request.previousResponseId}`, "previous_response_not_found");
			}
			if (!isTerminal(previous.status))
				throw badRequest(
					"invalid_value",
					"Wait for the previous response to finish before continuing it.",
					"previous_response_id",
				);
			const context = await this.contextAfter(previous);
			if (!context)
				throw badRequest(
					"invalid_value",
					"The context of that response is no longer on the server. Continue with its `conversation`, or send the history in `input`.",
					"previous_response_id",
				);
			return {
				conversationId: newId("conv"),
				owner: principal.name,
				previousResponseId: previous.id,
				desk: previous.desk,
				requestScoped: true,
				context,
			};
		}
		return {
			conversationId: newId("conv"),
			owner: principal.name,
			previousResponseId: null,
			requestScoped: true,
			context: [],
		};
	}

	/**
	 * The context a request continuing from `target` starts with: everything `target`'s generation
	 * saw and said. Request-scoped responses are followed back through their parents to one whose
	 * context stands on its own, then rebuilt forward; `undefined` when a piece is gone.
	 */
	private async contextAfter(target: ResponseRecord): Promise<ContextMessage[] | undefined> {
		const links: ResponseRecord[] = [];
		let record: ResponseRecord | undefined = target;
		let context: ContextMessage[] | undefined;
		while (record) {
			if (!record.request_scoped) {
				context = await this.conversationContextAt(record);
				break;
			}
			if (record.continuation) {
				context = record.continuation;
				break;
			}
			links.push(record);
			if (!record.context_parent) {
				context = [];
				break;
			}
			record = this.store.getResponse(record.context_parent);
		}
		if (!context) return undefined;
		for (const link of links.reverse()) {
			const input: ContextMessage[] = [...context, ...(link.context ?? [])];
			// No tail: the generation never finished (a restart failed it), so what it said is its output.
			context = link.continuation_tail ? [...input, ...link.continuation_tail] : [...input, ...outputContext(link)];
		}
		return context;
	}

	/**
	 * A conversation's model context as of `target`: the session where the last turn up to it left
	 * off. A command's reply never entered the session, so it shares the turn before it; `/new`
	 * started an empty one.
	 */
	private async conversationContextAt(target: ResponseRecord): Promise<ContextMessage[] | undefined> {
		const records = this.responsesOf(target.conversation_id);
		const end = records.findIndex((record) => record.id === target.id);
		for (let index = end; index >= 0; index--) {
			const record = records[index];
			if (record.context_ref) return loadContextAt(record.context_ref);
			if (record.continuation) return record.continuation;
			if (slashCommandName(inputTextOf(record)) === "new") return [];
		}
		return [];
	}

	/** Each request-scoped generation's full input, until it ends and its tail is cut against it. */
	private readonly generationInputs = new Map<string, ContextMessage[]>();

	/** Record how a later request continues from `live` (see `ResponseRecord`). */
	recordContinuation(live: LiveResponse, outcome: TurnOutcome): void {
		const input = this.generationInputs.get(live.id);
		this.generationInputs.delete(live.id);
		if (outcome.contextRef) live.record.context_ref = outcome.contextRef;
		const full = outcome.continuation;
		if (!full) return;
		if (input && startsWith(full, input)) live.record.continuation_tail = full.slice(input.length);
		else live.record.continuation = full;
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
	 * started is taken out of the queue, and only the turn that answers it is stopped — not `/stop`,
	 * which would also drop what every other caller has queued on the conversation.
	 */
	async cancel(live: LiveResponse): Promise<void> {
		if (live.terminal) return;
		const channelId = channelIdOf(live.record.conversation_id);
		const wasWaiting = live.status === "queued";
		const root = this.rootOf(live.id);
		live.cancel();
		this.pendingSteers.forEach((steer, ref) => {
			if (steer.targetId === root) this.pendingSteers.delete(ref);
		});
		if (wasWaiting && this.ingress.dropQueued(channelId, live.id)) return;
		// A steered successor answers its turn under the response that began it; a steer that missed
		// its turn runs as a turn of its own, under its own id.
		if (await this.ingress.cancelTurn(channelId, live.id)) return;
		if (root !== live.id) await this.ingress.cancelTurn(channelId, root);
	}

	/** Shutdown has begun: refuse new messages, keep delivering what runs (see `Transport.stopAccepting`). */
	stopAccepting(): void {
		this.accepting = false;
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
				this.recordContinuation(live, outcome);
				if (outcome.executionDesk) live.record.desk = outcome.executionDesk;
				if (outcome.kind === "failed") live.fail(outcome.message ?? "回合异常结束。", toApiUsage(outcome.usage));
				else if (outcome.kind === "cancelled") live.cancel();
				else live.complete(toApiUsage(outcome.usage));
			},
		};
	}

	// ---- steering --------------------------------------------------------------------------

	/**
	 * A turn can be steered several times and each steer ends the response it split, so one turn is a
	 * chain of responses. Pending steers belong to the turn, keyed by the response that began it.
	 */
	private readonly turnRoots = new Map<string, string>();

	private rootOf(responseId: string): string {
		return this.turnRoots.get(responseId) ?? responseId;
	}

	registerSteer(steer: PendingSteer): void {
		this.pendingSteers.set(steer.successorId, { ...steer, targetId: this.rootOf(steer.targetId) });
	}

	/** The steers still waiting to be applied to the turn `responseId` belongs to, oldest first. */
	pendingSteersOf(responseId: string): PendingSteer[] {
		const root = this.rootOf(responseId);
		return [...this.pendingSteers.values()].filter((steer) => steer.targetId === root);
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
		return this.createSuccessor(steer, "in_progress", current.id);
	}

	private createSuccessor(steer: PendingSteer, initial: "queued" | "in_progress", followsId?: string): LiveResponse {
		this.pendingSteers.delete(steer.successorId);
		this.turnRoots.set(steer.successorId, steer.targetId);
		const target = this.findRecord(steer.targetId);
		const conversation = this.store.getConversation(steer.conversationId);
		const live = this.register({
			id: steer.successorId,
			conversation_id: steer.conversationId,
			owner: conversation?.owner ?? steer.principal.name,
			status: "in_progress",
			created_at: nowSeconds(),
			completed_at: null,
			previous_response_id: followsId ?? steer.targetId,
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
				if (!this.quiet) live.endToolCall(event.callId, event.ok, event.output, event.failure);
				return;
			case "reasoning":
				if (!this.quiet) live.addReasoning(event.text);
				return;
			case "commentary":
				if (!this.quiet) live.addMessage("commentary", event.text, event.level);
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
		this.service.recordContinuation(live, outcome);
		if (outcome.executionDesk) live.record.desk = outcome.executionDesk;
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

function outputContext(record: ResponseRecord): ContextMessage[] {
	return record.output.flatMap((item) => parseInput([item]).context);
}

/** What the caller typed, as one string (for recognising a command). */
function inputTextOf(record: ResponseRecord): string {
	return record.input_items
		.flatMap((item) =>
			item.type === "message" && Array.isArray(item.content)
				? item.content.flatMap((part) => (part.type === "input_text" ? [part.text] : []))
				: [],
		)
		.join("\n");
}

/** Whether `full` begins with exactly the messages of `prefix` (field by field: key order differs). */
function startsWith(full: readonly ContextMessage[], prefix: readonly ContextMessage[]): boolean {
	const same = (a: ContextMessage, b: ContextMessage) =>
		a.role === b.role && a.phase === b.phase && JSON.stringify(a.content) === JSON.stringify(b.content);
	return prefix.length <= full.length && prefix.every((message, index) => same(message, full[index]));
}
