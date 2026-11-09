/**
 * AI Card streaming: create a card, stream appended or replaced content into it, and close it.
 * Owns the per-channel card state — the active card, the turn "generation" that invalidates a late
 * writer after `/stop` or `/new`, and the single-flight creation guard.
 */
import axios from "axios";
import * as log from "../log.js";
import { errorMessage } from "../shared/text-utils.js";
import { isRecord } from "../shared/type-guards.js";
import { type ConversationMeta, DINGTALK_API, http } from "./api.js";
import { CardHandles } from "./card-handles.js";
import type { DingTalkConfig } from "./config.js";
import { CARD_REQUEST_MAX_BYTES } from "./progress.js";

interface AICard {
	key: string;
	canWrite: () => boolean;
	instanceId: string;
	conversationId: string;
	accessToken: string;
	templateKey: string;
	createdAt: number;
	lastUpdated: number;
	content: string;
	finished: boolean;
	pendingWrite?: Promise<boolean>;
}

interface CardStreamOptions {
	/** `false` replaces the variable; `true` appends `content` and is sent with `isFull: false`. */
	append: boolean;
	finalize: boolean;
	failed: boolean;
}

const TOKEN_REFRESH_SECS = 90 * 60; // 1.5 hours (tokens expire after 2 hours)
/** Definite remote termination / CREATE-close retries before the local handle is abandoned. */
const MAX_TERMINATION_ATTEMPTS = 5;

/** A streaming variable that is markdown rejects `isFull: false`. The message names one of these. */
function rejectsMarkdownAppend(data: unknown): boolean {
	const text = typeof data === "string" ? data : JSON.stringify(data ?? "");
	const normalized = text.toLowerCase();
	return normalized.includes("isfull") || normalized.includes("markdown");
}

export interface CardControllerDeps {
	canWrite?: (key: string) => boolean;
	config: DingTalkConfig;
	getAccessToken: () => Promise<string | null>;
	getConversationMeta: (channelId: string) => ConversationMeta | null;
	/** Plain-message fallback when a card cannot be finalized; goes through the bot's `sendPlain`. */
	sendPlain: (channelId: string, text: string) => Promise<boolean>;
}

export class CardController {
	// Rebind fences queued HTTP too; ordinary /stop may still close its old card.
	private readonly handles: CardHandles;
	private readonly retired = new Map<string, Map<string, AICard>>();
	private readonly creating = new Set<AICard>();
	private readonly retiring = new Map<AICard, Promise<boolean>>();
	private readonly resetEpochs = new Map<string, symbol>();
	// Active AI cards: channelId → AICard
	private activeCards = new Map<string, AICard>();
	private cardGenerations = new Map<string, symbol>();
	private cardCreationAttempted = new Set<symbol>();
	/** A CREATE may reach DingTalk even when its response is lost. Keep its concrete handle. */
	private readonly unconfirmedCards = new Map<symbol, AICard>();
	/** Per-instance close/CREATE-unknown retries; abandoned handles are forgotten. */
	private readonly terminationAttempts = new Map<string, number>();
	// Share creation within a turn, but never let a late old turn own a new turn's card.
	private cardCreationInFlight = new Map<string, { generation: symbol; promise: Promise<AICard | null> }>();
	/**
	 * The live template accepts appended list items. A markdown variable that does not is remembered
	 * for the process: later progress updates send a full snapshot instead of trying append again.
	 */
	private appendSupported = true;

	/** False after this process has seen the template reject an appended fragment. */
	supportsStreamingAppend(): boolean {
		return this.appendSupported;
	}

	constructor(private deps: CardControllerDeps) {
		this.handles = new CardHandles(deps.config.stateDir);
		for (const handle of this.handles.list())
			this.retainRetired({
				...handle,
				canWrite: () => false,
				accessToken: "",
				conversationId: "",
				createdAt: 0,
				lastUpdated: 0,
				content: "",
				finished: false,
			});
	}

	private retainRetired(card: AICard): void {
		let cards = this.retired.get(card.key);
		if (!cards) {
			cards = new Map();
			this.retired.set(card.key, cards);
		}
		cards.set(card.instanceId, card);
	}

	/** Retired handles admit only fixed termination, independently of current binding/generation. */
	async retryRetired(key?: string): Promise<boolean> {
		let confirmed = true;
		for (const [owner, cards] of this.retired) {
			if (key !== undefined && owner !== key) continue;
			for (const card of cards.values()) {
				if (this.creating.has(card)) {
					confirmed = false;
					continue;
				}
				let pending = this.retiring.get(card);
				if (!pending) {
					pending = this.terminateCard(card).finally(() => this.retiring.delete(card));
					this.retiring.set(card, pending);
				}
				if (await pending) cards.delete(card.instanceId);
				else confirmed = false;
			}
			if (!cards.size) this.retired.delete(owner);
		}
		return confirmed;
	}

	private retryRetiredSoon(key: string): void {
		void this.retryRetired(key).catch((error) =>
			log.logWarn("dingtalk.card.retire_failed", "Card termination failed", {
				reason: errorMessage(error),
			}),
		);
	}

	/** Capture the current turn's identity; close, /stop and /new invalidate it. */
	getCardGeneration(channelId: string): symbol {
		let generation = this.cardGenerations.get(channelId);
		if (!generation) {
			generation = Symbol(channelId);
			this.cardGenerations.set(channelId, generation);
		}
		return generation;
	}

	isCardGenerationCurrent(channelId: string, generation: symbol): boolean {
		return this.cardGenerations.get(channelId) === generation && this.deps.canWrite?.(channelId) !== false;
	}

	/** Get or create an AI card without joining an earlier turn's in-flight creation. */
	async ensureCard(channelId: string, generation = this.getCardGeneration(channelId)): Promise<void> {
		if (!this.deps.config.cardTemplateId || !this.isCardGenerationCurrent(channelId, generation)) return;
		const existing = this.activeCards.get(channelId);
		if (existing && !existing.finished) return;
		await this.createCard(channelId, generation);
	}

	/**
	 * Replace the active card content with a full snapshot.
	 */
	async replaceCard(
		channelId: string,
		content: string,
		finalize: boolean = false,
		failed: boolean = false,
		generation = this.getCardGeneration(channelId),
	): Promise<boolean> {
		return this.writeCard(channelId, content, { append: false, finalize, failed }, generation);
	}

	/**
	 * Append a delta to the active card transcript.
	 */
	async appendToCard(
		channelId: string,
		content: string,
		finalize: boolean = false,
		failed: boolean = false,
		generation = this.getCardGeneration(channelId),
	): Promise<boolean> {
		return this.writeCard(channelId, content, { append: true, finalize, failed }, generation);
	}

	/**
	 * Shared body of `replaceCard`/`appendToCard`: whether to open a fresh card differs between the
	 * two (a full-snapshot replace opens one for a finalize/failed close too; a delta append only
	 * opens one for genuinely new content), so that predicate stays keyed on `append` rather than
	 * being collapsed away — everything after it (stream, then drop the card on finalize/failed/a
	 * failed stream) is identical either way.
	 */
	private async writeCard(
		channelId: string,
		content: string,
		options: { append: boolean; finalize: boolean; failed: boolean },
		generation: symbol,
	): Promise<boolean> {
		if (!this.isCardGenerationCurrent(channelId, generation)) return false;
		const { append, finalize, failed } = options;
		if (append && !this.appendSupported) return false;
		if (append && !content && !finalize && !failed) {
			return true;
		}

		let card = this.activeCards.get(channelId);
		const shouldEnsure = append
			? !finalize && !failed && content.trim().length > 0
			: content.trim().length > 0 || !finalize || failed;
		if ((!card || card.finished) && this.deps.config.cardTemplateId && shouldEnsure) {
			await this.ensureCard(channelId, generation);
			if (!this.isCardGenerationCurrent(channelId, generation)) return false;
			card = this.activeCards.get(channelId);
		}
		if (!card || card.finished) {
			return false;
		}

		// Never erase a visible card, including callers finishing with no new text.
		const snapshot = !append && !content.trim() ? card.content || "处理已结束。" : content;
		const streamed = await this.streamCard(card, snapshot, { append, finalize, failed });
		if (streamed && (finalize || failed) && this.activeCards.get(channelId) === card) {
			this.activeCards.delete(channelId);
			this.cardCreationAttempted.delete(generation);
		}
		return streamed;
	}

	/**
	 * Finalize and remove the active card for a channel.
	 */
	async finalizeCard(
		channelId: string,
		content: string,
		generation = this.getCardGeneration(channelId),
	): Promise<boolean> {
		if (!content.trim() || !this.isCardGenerationCurrent(channelId, generation)) return false;
		const finalized = await this.replaceCard(channelId, content, true, false, generation);
		if (!finalized && this.isCardGenerationCurrent(channelId, generation)) {
			return this.deps.sendPlain(channelId, content);
		}
		return finalized;
	}

	/** Finish progress only: never create a card or send a fallback chat message. */
	async finalizeExistingCard(
		channelId: string,
		content: string,
		generation = this.getCardGeneration(channelId),
	): Promise<boolean> {
		if (!this.isCardGenerationCurrent(channelId, generation) || !this.activeCards.has(channelId)) return false;
		return this.replaceCard(channelId, content, true, false, generation);
	}

	/** Confirm no card remains open. Failed writes retain the same handle for retry. */
	async closeCard(
		channelId: string,
		content: string,
		generation = this.getCardGeneration(channelId),
	): Promise<boolean> {
		if (!this.isCardGenerationCurrent(channelId, generation)) return false;
		const retiredClosed = await this.retryRetired(channelId);
		const creation = this.cardCreationInFlight.get(channelId);
		if (creation?.generation === generation) await creation.promise;
		if (!this.isCardGenerationCurrent(channelId, generation)) return false;
		if (!this.activeCards.has(channelId)) {
			const uncertain = this.unconfirmedCards.get(generation);
			if (!uncertain) return retiredClosed && !this.cardCreationAttempted.has(generation);
			const confirmed = await this.terminateCard(uncertain);
			if (confirmed) {
				this.unconfirmedCards.delete(generation);
				this.cardCreationAttempted.delete(generation);
			}
			return confirmed && retiredClosed;
		}
		const currentClosed = await this.finalizeExistingCard(channelId, content, generation);
		return retiredClosed && currentClosed;
	}

	/** Invalidate this turn's local state. This is not a remote message deletion. */
	discardCard(channelId: string, generation = this.cardGenerations.get(channelId)): void {
		if (!generation || !this.isCardGenerationCurrent(channelId, generation)) return;
		this.dropChannel(channelId);
	}

	/** Rebinding cannot reuse a revoked guard or any active/in-flight old generation. */
	resetGeneration(key: string): void {
		this.resetEpochs.set(key, Symbol(key));
		this.dropChannel(key);
		this.cardCreationInFlight.delete(key);
		this.cardGenerations.set(key, Symbol(key));
	}

	/** True while this channel has a card being created (the idle-cache sweep must not reclaim it). */
	hasCreationInFlight(channelId: string): boolean {
		return this.cardCreationInFlight.has(channelId);
	}

	/** True when the channel's card was updated after `cutoffMs` (epoch ms). */
	hasCardUpdatedSince(channelId: string, cutoffMs: number): boolean {
		const card = this.activeCards.get(channelId);
		return card !== undefined && card.lastUpdated * 1000 > cutoffMs;
	}

	/** Forget everything held for an idle channel. */
	dropChannel(channelId: string): void {
		const active = this.activeCards.get(channelId);
		if (active) this.retainRetired(active);
		this.activeCards.delete(channelId);
		const generation = this.cardGenerations.get(channelId);
		if (generation) {
			const uncertain = this.unconfirmedCards.get(generation);
			if (uncertain) this.retainRetired(uncertain);
			this.cardCreationAttempted.delete(generation);
			this.unconfirmedCards.delete(generation);
		}
		this.cardGenerations.delete(channelId);
		this.retryRetiredSoon(channelId);
	}

	private async createCard(channelId: string, generation: symbol): Promise<AICard | null> {
		// Re-check under the singleflight: a concurrent caller may have already
		// created the card while we awaited, so avoid a duplicate create.
		const existing = this.activeCards.get(channelId);
		if (existing && !existing.finished) {
			return existing;
		}
		const inFlight = this.cardCreationInFlight.get(channelId);
		if (inFlight?.generation === generation) {
			return inFlight.promise;
		}
		// A failed create may already have reached DingTalk. Never mint another ID in this turn.
		if (this.cardCreationAttempted.has(generation)) return null;
		const creation = this.createCardUncached(channelId, generation).finally(() => {
			if (this.cardCreationInFlight.get(channelId)?.generation === generation) {
				this.cardCreationInFlight.delete(channelId);
			}
		});
		this.cardCreationInFlight.set(channelId, { generation, promise: creation });
		return creation;
	}

	private async createCardUncached(channelId: string, generation: symbol): Promise<AICard | null> {
		const resetEpoch = this.resetEpochs.get(channelId);
		const { config } = this.deps;
		const token = await this.deps.getAccessToken();
		if (!token || !this.isCardGenerationCurrent(channelId, generation)) return null;

		const meta = this.deps.getConversationMeta(channelId);
		if (!meta) {
			log.logWarn("dingtalk.card.no_metadata", "Card not created: no conversation metadata", {
				channelId: channelId,
			});
			return null;
		}

		const isGroup = meta.conversationType === "2";
		const instanceId = `card_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
		const robotCode = config.robotCode || config.clientId;

		// openSpaceId format:
		//   群聊: dtv1.card//IM_GROUP.{openConversationId}
		//   单聊: dtv1.card//IM_ROBOT.{userId}
		const openSpaceId = isGroup
			? `dtv1.card//IM_GROUP.${meta.conversationId}`
			: `dtv1.card//IM_ROBOT.${meta.senderId}`;

		const body: Record<string, unknown> = {
			cardTemplateId: config.cardTemplateId,
			outTrackId: instanceId,
			cardData: {
				cardParamMap: {
					[config.cardTemplateKey || "content"]: "正在处理…",
					sys_full_json_obj: JSON.stringify({
						config: {
							autoLayout: config.cardAutoLayout ?? true,
						},
					}),
				},
			},
			callbackType: "STREAM",
			imGroupOpenSpaceModel: { supportForward: true },
			imRobotOpenSpaceModel: { supportForward: true },
			openSpaceId,
			userIdType: 1,
		};

		if (isGroup) {
			body.imGroupOpenDeliverModel = { robotCode };
		} else {
			body.imRobotOpenDeliverModel = { spaceType: "IM_ROBOT" };
		}

		const card: AICard = {
			key: channelId,
			canWrite: () => this.resetEpochs.get(channelId) === resetEpoch && this.deps.canWrite?.(channelId) !== false,
			instanceId,
			conversationId: meta.conversationId,
			accessToken: token,
			templateKey: config.cardTemplateKey || "content",
			createdAt: Date.now() / 1000,
			lastUpdated: Date.now() / 1000,
			content: "正在处理…",
			finished: false,
		};
		// Write ahead of CREATE: a lost response or process cannot erase its termination handle.
		this.handles.remember({ key: channelId, instanceId, templateKey: card.templateKey });
		this.cardCreationAttempted.add(generation);
		this.unconfirmedCards.set(generation, card);
		this.creating.add(card);
		let confirmed = false;
		let definiteFailure = false;
		try {
			const response = await http.post<unknown>(`${DINGTALK_API}/v1.0/card/instances/createAndDeliver`, body, {
				headers: {
					"x-acs-dingtalk-access-token": token,
					"Content-Type": "application/json",
				},
			});
			const data = response.data;
			if (
				!isRecord(data) ||
				data.success !== true ||
				!isRecord(data.result) ||
				data.result.outTrackId !== instanceId ||
				!Array.isArray(data.result.deliverResults) ||
				data.result.deliverResults.length === 0 ||
				!data.result.deliverResults.every((result: unknown) => isRecord(result) && result.success === true)
			) {
				log.logWarn("dingtalk.card.create_unconfirmed", "Card creation confirmation failed", { channelId });
			} else confirmed = true;
		} catch (err) {
			if (axios.isAxiosError(err) && err.response) {
				const status = err.response.status;
				// 4xx except 429 means the card was not created; do not retire it for endless PUT.
				definiteFailure = status >= 400 && status < 500 && status !== 429;
				log.logWarn("dingtalk.card.create_failed", "Card create failed", {
					reason: JSON.stringify(err.response.data),
					fields: { status },
				});
			} else {
				log.logWarn("dingtalk.card.create_failed", "Card create failed", { reason: errorMessage(err) });
			}
		}

		this.creating.delete(card);
		if (!this.isCardGenerationCurrent(channelId, generation)) {
			this.unconfirmedCards.delete(generation);
			if (!definiteFailure) this.retainRetired(card);
			else this.abandonHandle(card);
			await this.retryRetired(channelId);
			return null;
		}
		if (definiteFailure) {
			this.unconfirmedCards.delete(generation);
			this.cardCreationAttempted.delete(generation);
			this.abandonHandle(card);
			return null;
		}
		if (!confirmed) return null;
		this.unconfirmedCards.delete(generation);
		this.activeCards.set(channelId, card);
		return card;
	}

	/** Fixed termination only: never routes by key or admits stale producer content. */
	private async terminateCard(card: AICard): Promise<boolean> {
		const attempts = (this.terminationAttempts.get(card.instanceId) ?? 0) + 1;
		this.terminationAttempts.set(card.instanceId, attempts);
		const confirmed = await this.streamCard(
			card,
			"处理已结束。",
			{ append: false, finalize: true, failed: false },
			true,
		);
		if (confirmed) {
			this.terminationAttempts.delete(card.instanceId);
			return this.forgetFinishedCard(card);
		}
		if (attempts < MAX_TERMINATION_ATTEMPTS) return false;
		log.logWarn("dingtalk.card.terminate_abandoned", "Card termination abandoned", {
			fields: { instanceId: card.instanceId, attempts },
		});
		this.terminationAttempts.delete(card.instanceId);
		this.abandonHandle(card);
		return true;
	}

	private abandonHandle(card: AICard): void {
		this.retired.get(card.key)?.delete(card.instanceId);
		if (!this.retired.get(card.key)?.size) this.retired.delete(card.key);
		try {
			this.handles.forget(card.instanceId);
		} catch (error) {
			log.logWarn("dingtalk.card.handle_failed", "Card handle cleanup failed", { reason: errorMessage(error) });
		}
	}

	private forgetFinishedCard(card: AICard): boolean {
		try {
			this.handles.forget(card.instanceId);
			return true;
		} catch (error) {
			this.retainRetired(card);
			log.logWarn("dingtalk.card.handle_failed", "Card handle cleanup failed", { reason: errorMessage(error) });
			return false;
		}
	}

	private async streamCard(
		card: AICard,
		content: string,
		options: CardStreamOptions,
		termination = false,
	): Promise<boolean> {
		// A stop/new-session close can arrive while the prior HTTP write is in flight.
		// Order writes by instance so that close remains the last update to the old card.
		const pending = (card.pendingWrite ?? Promise.resolve(true))
			.then(async () => {
				// A finished card must not acknowledge a later body write as delivered.
				if (card.finished) return termination ? this.forgetFinishedCard(card) : false;
				return this.streamCardRequest(card, content, options, termination);
			})
			.catch((error: unknown) => {
				log.logWarn("dingtalk.card.stream_failed", "Card streaming failed", { reason: errorMessage(error) });
				return false;
			});
		card.pendingWrite = pending;
		return pending;
	}

	private async streamCardRequest(
		card: AICard,
		content: string,
		options: CardStreamOptions,
		termination: boolean,
	): Promise<boolean> {
		if (!termination && !card.canWrite()) return false;
		// Refresh token if needed
		const ageSecs = Date.now() / 1000 - card.createdAt;
		if (!card.accessToken || ageSecs > TOKEN_REFRESH_SECS) {
			const token = await this.deps.getAccessToken();
			if (!token) return false;
			card.accessToken = token;
		}

		if (!termination && !card.canWrite()) return false;

		// Progress updates stay within one request. A finalized answer is the model's own markdown
		// and may be longer; a failed finalize falls back to a normal message.
		if (!options.finalize && !options.failed && Buffer.byteLength(content) > CARD_REQUEST_MAX_BYTES) {
			log.logWarn("dingtalk.card.frame_too_large", "Card streaming skipped an oversized frame", {
				fields: { bytes: Buffer.byteLength(content) },
			});
			return false;
		}

		const body = {
			outTrackId: card.instanceId,
			guid: `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
			key: card.templateKey,
			content,
			append: options.append,
			finished: options.finalize,
			failed: options.failed,
			isFull: !options.append,
			isFinalize: options.finalize,
			isError: options.failed,
		};

		const start = Date.now();
		try {
			const response = await http.put<unknown>(`${DINGTALK_API}/v1.0/card/streaming`, body, {
				headers: {
					"x-acs-dingtalk-access-token": card.accessToken,
					"Content-Type": "application/json",
				},
			});

			if (!isRecord(response.data) || response.data.success !== true || response.data.result !== true) {
				log.logWarn("dingtalk.card.stream_unconfirmed", "Card streaming confirmation failed", {});
				return false;
			}
			const duration = Date.now() - start;
			if (duration > 1000) {
				log.logWarn("dingtalk.card.stream_slow", "Card streaming request slow", {
					fields: { durationMs: duration },
				});
			}

			card.lastUpdated = Date.now() / 1000;
			card.content = options.append ? card.content + content : content;
			if (options.finalize || options.failed) {
				card.finished = true;
				// Cleanup I/O cannot revoke an observed body delivery acknowledgement.
				this.forgetFinishedCard(card);
			}
			return true;
		} catch (err) {
			if (axios.isAxiosError(err) && err.response) {
				if (options.append && rejectsMarkdownAppend(err.response.data)) this.appendSupported = false;
				log.logWarn("dingtalk.card.stream_failed", "Card streaming failed", {
					reason: JSON.stringify(err.response.data),
					fields: { status: err.response.status },
				});
			} else {
				log.logWarn("dingtalk.card.stream_failed", "Card streaming failed", { reason: errorMessage(err) });
			}
			return false;
		}
	}
}
