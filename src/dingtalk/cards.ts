/**
 * AI Card streaming: create a card, stream appended or replaced content into it, and close it.
 * Owns the per-channel card state — the active card, the turn "generation" that invalidates a late
 * writer after `/stop` or `/new`, and the single-flight creation guard.
 */
import axios from "axios";
import * as log from "../log.js";
import { errorMessage } from "../shared/text-utils.js";
import { type ConversationMeta, DINGTALK_API, http } from "./api.js";
import type { DingTalkConfig } from "./config.js";

interface AICard {
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
	append: boolean;
	finalize: boolean;
	failed: boolean;
}

const TOKEN_REFRESH_SECS = 90 * 60; // 1.5 hours (tokens expire after 2 hours)

export interface CardControllerDeps {
	config: DingTalkConfig;
	getAccessToken: () => Promise<string | null>;
	getConversationMeta: (channelId: string) => ConversationMeta | null;
	/** Plain-message fallback when a card cannot be finalized; goes through the bot's `sendPlain`. */
	sendPlain: (channelId: string, text: string) => Promise<boolean>;
}

export class CardController {
	// Active AI cards: channelId → AICard
	private activeCards = new Map<string, AICard>();
	private cardGenerations = new Map<string, symbol>();
	private cardCreationAttempted = new Set<symbol>();
	// Share creation within a turn, but never let a late old turn own a new turn's card.
	private cardCreationInFlight = new Map<string, { generation: symbol; promise: Promise<AICard | null> }>();

	constructor(private deps: CardControllerDeps) {}

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
		return this.cardGenerations.get(channelId) === generation;
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

	/** Invalidate this turn's local state. This is not a remote message deletion. */
	discardCard(channelId: string, generation = this.cardGenerations.get(channelId)): void {
		if (!generation || !this.isCardGenerationCurrent(channelId, generation)) return;
		this.cardGenerations.delete(channelId);
		this.cardCreationAttempted.delete(generation);
		const card = this.activeCards.get(channelId);
		this.activeCards.delete(channelId);
		// /stop and /new may invalidate a turn before its controller gets to finish.
		if (card && !card.finished) {
			void this.streamCard(card, `${card.content || "正在处理…"}\n\n处理已结束。`, {
				append: false,
				finalize: true,
				failed: false,
			});
		}
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
		this.activeCards.delete(channelId);
		const generation = this.cardGenerations.get(channelId);
		if (generation) this.cardCreationAttempted.delete(generation);
		this.cardGenerations.delete(channelId);
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
		this.cardCreationAttempted.add(generation);
		const creation = this.createCardUncached(channelId, generation).finally(() => {
			if (this.cardCreationInFlight.get(channelId)?.generation === generation) {
				this.cardCreationInFlight.delete(channelId);
			}
		});
		this.cardCreationInFlight.set(channelId, { generation, promise: creation });
		return creation;
	}

	private async createCardUncached(channelId: string, generation: symbol): Promise<AICard | null> {
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

		try {
			await http.post(`${DINGTALK_API}/v1.0/card/instances/createAndDeliver`, body, {
				headers: {
					"x-acs-dingtalk-access-token": token,
					"Content-Type": "application/json",
				},
			});
		} catch (err) {
			if (axios.isAxiosError(err) && err.response) {
				log.logWarn("dingtalk.card.create_failed", "Card create failed", {
					reason: JSON.stringify(err.response.data),
					fields: { status: err.response.status },
				});
			} else {
				log.logWarn("dingtalk.card.create_failed", "Card create failed", { reason: errorMessage(err) });
			}
			return null;
		}

		const card: AICard = {
			instanceId,
			conversationId: meta.conversationId,
			accessToken: token,
			templateKey: config.cardTemplateKey || "content",
			createdAt: Date.now() / 1000,
			lastUpdated: Date.now() / 1000,
			content: "正在处理…",
			finished: false,
		};
		if (!this.isCardGenerationCurrent(channelId, generation)) {
			await this.streamCard(card, "处理已结束。", { append: false, finalize: true, failed: false });
			return null;
		}
		this.activeCards.set(channelId, card);
		return card;
	}

	private async streamCard(card: AICard, content: string, options: CardStreamOptions): Promise<boolean> {
		// A stop/new-session close can arrive while the prior HTTP write is in flight.
		// Order writes by instance so that close remains the last update to the old card.
		const pending = (card.pendingWrite ?? Promise.resolve(true))
			.then(async () => {
				if (card.finished) return false;
				return this.streamCardRequest(card, content, options);
			})
			.catch((error: unknown) => {
				log.logWarn("dingtalk.card.stream_failed", "Card streaming failed", { reason: errorMessage(error) });
				return false;
			});
		card.pendingWrite = pending;
		return pending;
	}

	private async streamCardRequest(card: AICard, content: string, options: CardStreamOptions): Promise<boolean> {
		// Refresh token if needed
		const ageSecs = Date.now() / 1000 - card.createdAt;
		if (ageSecs > TOKEN_REFRESH_SECS) {
			const token = await this.deps.getAccessToken();
			if (token) {
				card.accessToken = token;
			}
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
			await http.put(`${DINGTALK_API}/v1.0/card/streaming`, body, {
				headers: {
					"x-acs-dingtalk-access-token": card.accessToken,
					"Content-Type": "application/json",
				},
			});

			const duration = Date.now() - start;
			if (duration > 1000) {
				log.logWarn("dingtalk.card.stream_slow", "Card streaming request slow", {
					fields: { durationMs: duration },
				});
			}

			card.lastUpdated = Date.now() / 1000;
			card.content = options.append ? `${card.content}${content}` : content;
			if (options.finalize || options.failed) {
				card.finished = true;
			}
			return true;
		} catch (err) {
			if (axios.isAxiosError(err) && err.response) {
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
