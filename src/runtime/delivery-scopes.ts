/** Request/task delivery coordination. Work facts stay in the run/job/task domains. */
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChannelContext, TurnEvent, TurnOutcome } from "../channel/channel-context.js";
import {
	type DeliveryScopeRef,
	deliveryScopeKey,
	type FinalIntent,
	isDeliveryScopeRef,
	type ScopeWork,
	type ScopeWriter,
} from "../channel/delivery-scope.js";
import * as log from "../log.js";
import { writeFileAtomically } from "../shared/atomic-file.js";
import { createSerialQueue } from "../shared/serial-queue.js";
import { errorMessage } from "../shared/text-utils.js";
import { isRecord } from "../shared/type-guards.js";
import type { TaskDelivery } from "../tasks/delivery.js";
import type { TransportRegistry } from "./transports.js";

/** After this many unconfirmed final attempts the intent is retained for inspection but never retried. */
const MAX_FINAL_ATTEMPTS = 8;
/** Sentinel nextAttemptAt: retry() skips forever without a new state field. */
const ABANDONED_ATTEMPT_AT = Number.MAX_SAFE_INTEGER;

interface ScopeState {
	owner: DeliveryScopeRef;
	epoch: string;
	revision: number;
	consumed: string[];
	reports: string[];
	closed?: boolean;
	/** Progress ended after work disappeared; late owned completions still remain admissible. */
	progressClosed?: boolean;
	/** An explicit cancel retains its close responsibility across retries/restart. */
	closeRequested?: boolean;
	final?: FinalIntent & {
		confirmed?: boolean;
		attempts: number;
		nextAttemptAt: number;
		result?: "confirmed" | "unknown" | "blocked";
	};
}

export class DeliveryScopes {
	private readonly epoch = randomUUID();
	private readonly states = new Map<string, ScopeState>();
	private readonly writers = new Map<string, symbol>();
	private readonly queue = createSerialQueue();
	private readonly operations = new Set<Promise<unknown>>();
	private serial<T>(key: string, work: () => Promise<T>): Promise<T> {
		const operation = this.queue.run(key, work);
		this.operations.add(operation);
		void operation.finally(() => this.operations.delete(operation)).catch(() => undefined);
		return operation;
	}
	private timer?: NodeJS.Timeout;
	private stopped = false;
	constructor(
		private readonly options: {
			directory: string;
			transports: TransportRegistry;
			isBoundTo: (channel: string, desk: string) => boolean;
			work: (owner: DeliveryScopeRef) => ScopeWork[];
		},
	) {}

	private path(owner: DeliveryScopeRef): string {
		return join(this.options.directory, `${deliveryScopeKey(owner)}.json`);
	}
	private save(state: ScopeState): Promise<void> {
		return writeFileAtomically(this.path(state.owner), JSON.stringify(state));
	}
	/** Publish to memory only after the atomic disk commit succeeds. Callers hold the owner queue. */
	private async commit(state: ScopeState, next: ScopeState): Promise<void> {
		await this.save(next);
		Object.assign(state, next);
	}
	private reachable(owner: DeliveryScopeRef): boolean {
		return (
			this.options.isBoundTo(owner.channelId, owner.desk) && this.options.transports.isReachable(owner.channelId)
		);
	}
	private port(state: ScopeState, opts?: { deferCard?: boolean }): ScopeWriter | undefined {
		if (!this.reachable(state.owner)) return undefined;
		return this.options.transports
			.forChannel(state.owner.channelId)
			?.scopes?.open(state.owner, state.epoch !== this.epoch, () => this.reachable(state.owner), opts);
	}
	private async state(owner: DeliveryScopeRef): Promise<ScopeState> {
		if (!isDeliveryScopeRef(owner))
			throw new Error("Invalid delivery owner; inspect the scope record before retrying.");
		const key = deliveryScopeKey(owner);
		const existing = this.states.get(key);
		if (existing) return existing;
		const state: ScopeState = { owner: { ...owner }, epoch: this.epoch, revision: 0, consumed: [], reports: [] };
		// Required persistence before any card creation or final send.
		await this.save(state);
		this.states.set(key, state);
		return state;
	}

	/** Corruption refuses startup. Never overwrite an unreadable owner's pending final. */
	async restore(): Promise<void> {
		let names: string[];
		try {
			names = await readdir(this.options.directory);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		for (const name of names.filter((name) => name.endsWith(".json"))) {
			const value = JSON.parse(await readFile(join(this.options.directory, name), "utf-8")) as ScopeState;
			if (
				!isDeliveryScopeRef(value?.owner) ||
				name !== `${deliveryScopeKey(value.owner)}.json` ||
				typeof value.epoch !== "string" ||
				(value.closed !== undefined && typeof value.closed !== "boolean") ||
				(value.progressClosed !== undefined && typeof value.progressClosed !== "boolean") ||
				(value.closeRequested !== undefined && typeof value.closeRequested !== "boolean") ||
				!Number.isSafeInteger(value.revision) ||
				value.revision < 0 ||
				!Array.isArray(value.consumed) ||
				!value.consumed.every((id) => typeof id === "string") ||
				!Array.isArray(value.reports) ||
				!value.reports.every((id) => typeof id === "string") ||
				(value.final !== undefined &&
					(!isRecord(value.final) ||
						typeof value.final.id !== "string" ||
						!value.final.id ||
						(value.final.confirmed !== undefined && typeof value.final.confirmed !== "boolean") ||
						typeof value.final.text !== "string" ||
						!value.final.text.trim() ||
						(value.final.confirmed === true && value.final.result !== "confirmed") ||
						!Number.isSafeInteger(value.final.attempts) ||
						value.final.attempts < 0 ||
						!Number.isFinite(value.final.nextAttemptAt) ||
						value.final.nextAttemptAt < 0))
			)
				throw new Error(`Invalid delivery scope ${name}; have the deployer inspect it before restarting.`);
			this.states.set(deliveryScopeKey(value.owner), value);
		}
	}

	/** Only committed consumption suppresses model admission; an unsaved final must replay. */
	isConsumed(owner: DeliveryScopeRef, id: string): boolean {
		return this.states.get(deliveryScopeKey(owner))?.consumed.includes(id) ?? false;
	}

	/** Exhausted/suppressed wakes will never arrive; drop them from the final gate without a model turn. */
	async acknowledge(owner: DeliveryScopeRef, ids: string[]): Promise<void> {
		if (ids.length === 0) return;
		await this.serial(deliveryScopeKey(owner), async () => {
			const state = await this.state(owner);
			const consumed = [...new Set([...state.consumed, ...ids])];
			if (consumed.length === state.consumed.length) return;
			await this.commit(state, { ...state, consumed, revision: state.revision + 1 });
		});
	}

	/** A writer ends with the SDK turn; its scope can outlive it without holding a runner. */
	async openTurn(owner: DeliveryScopeRef, completionIds: string[]): Promise<ChannelContext> {
		const key = deliveryScopeKey(owner);
		const state = await this.serial(key, () => this.state(owner));
		const generation = Symbol(key);
		this.writers.set(key, generation);
		const writer = state.closed || state.final || state.progressClosed ? undefined : this.port(state);
		let ended = false;
		let finishing: Promise<void> | undefined;
		let answer: string | undefined;
		const current = () => !ended && this.writers.get(key) === generation;
		return {
			emit: (event) => {
				if (!current() || !this.reachable(owner)) return;
				if (event.type === "answer") answer = event.text.trim() || undefined;
				else writer?.emit(event);
			},
			finish: (outcome) => {
				if (finishing) return finishing;
				if (!current()) return Promise.resolve();
				ended = true; // Fence callbacks immediately, before the first await.
				finishing = this.serial(key, async () => {
					if (this.writers.get(key) !== generation) return;
					try {
						await this.finish(state, writer, answer, completionIds, outcome);
					} finally {
						if (this.writers.get(key) === generation) this.writers.delete(key);
					}
				});
				return finishing;
			},
		};
	}

	private async finish(
		state: ScopeState,
		writer: ScopeWriter | undefined,
		answer: string | undefined,
		ids: string[],
		outcome: TurnOutcome,
	): Promise<void> {
		if (state.closed || state.final) return;
		const successful = outcome.kind === "completed" || outcome.kind === "silent";
		// /stop consumes the current wake ids and closes progress; a later owned completion may still final.
		const stopped = outcome.kind === "cancelled";
		const consumed = successful || stopped ? [...new Set([...state.consumed, ...ids])] : state.consumed;
		const work = this.options.work(state.owner);
		const unsettled = work.some(
			(item) => item.pending || (item.completionId && !consumed.includes(item.completionId)),
		);
		const next: ScopeState = { ...state, consumed, revision: state.revision + 1 };
		if (successful && answer && !unsettled)
			next.final = { id: `request-final:${randomUUID()}`, text: answer, attempts: 0, nextAttemptAt: 0 };
		// Consuming inputs and retaining their final are one commit. A rejected commit leaves
		// both memory and disk retryable; another finish cannot acknowledge an unsaved answer.
		await this.commit(state, next);
		if (next.final) {
			// Once the intent is durable, retry delivery only. An attempt/ack storage fault must
			// not replay the model to manufacture another answer for this same completion.
			await this.publishFinal(state).catch((error) =>
				log.logWarn("delivery.scope.final_failed", "Scope final delivery failed", {
					reason: errorMessage(error),
					fields: { owner: state.owner, intentId: state.final?.id },
				}),
			);
		} else {
			if (answer && !stopped) writer?.emit({ type: "commentary", text: answer });
			if (outcome.kind === "failed" && outcome.message)
				writer?.emit({ type: "commentary", level: "notice", text: outcome.message });
			const summary =
				outcome.kind === "failed"
					? "未完成"
					: stopped
						? "已停止"
						: outcome.kind === "silent"
							? "已处理，无需答复。"
							: undefined;
			if (!unsettled || stopped) {
				await this.closeProgress(state, writer ?? this.port(state), successful, summary);
			} else await writer?.flush();
		}
	}

	/** Best-effort run notices are progress, with an explicit stalled interaction handled by caller. */
	async activity(owner: DeliveryScopeRef, event: TurnEvent): Promise<void> {
		if (this.stopped) return;
		await this.serial(deliveryScopeKey(owner), async () => {
			const state = await this.state(owner);
			if (!state.closed && !state.final) this.port(state)?.emit(event);
		});
	}

	/** The task outbox keeps ownership of retry/FIFO and its report-delivered gate. */
	async task(desk: string, message: TaskDelivery): Promise<boolean> {
		if (this.stopped) return false;
		const owner: DeliveryScopeRef = { desk, channelId: message.channel, scopeId: `task:${message.taskId}` };
		return this.serial(deliveryScopeKey(owner), async () => {
			const state = await this.state(owner);
			if (message.kind === "report") {
				if (state.reports.includes(message.id)) return true;
				if (state.closed || state.final) return false;
				const port = this.port(state);
				if (!port) return false;
				if ((await port.report({ id: message.id, text: message.text })).status !== "confirmed") return false;
				await this.commit(state, {
					...state,
					reports: [...state.reports, message.id],
					revision: state.revision + 1,
				});
				return true;
			}
			if (state.final && state.final.id !== message.id)
				throw new Error("Task has a different final intent; inspect the delivery queue before retrying.");
			if (!state.final) {
				await this.commit(state, {
					...state,
					final: { id: message.id, text: message.text, attempts: 0, nextAttemptAt: 0 },
				});
			}
			return this.publishFinal(state);
		});
	}

	/** Same-channel user cancel already has a command receipt: close progress without another final. */
	async close(owner: DeliveryScopeRef): Promise<void> {
		await this.serial(deliveryScopeKey(owner), async () => {
			const state = await this.state(owner);
			if (state.final) return;
			await this.commit(state, { ...state, closeRequested: true });
			// deferCard: cancel must not CREATE a waiting card just to close it.
			await this.closeProgress(state, this.port(state, { deferCard: true }), true, "已停止");
		});
	}

	private async closeProgress(
		state: ScopeState,
		writer: ScopeWriter | undefined,
		terminal: boolean,
		summary?: string,
	): Promise<void> {
		if ((await writer?.close(summary))?.status !== "confirmed") return;
		await this.commit(state, {
			...state,
			progressClosed: true,
			...(terminal ? { closed: true, closeRequested: false } : {}),
		});
	}

	private async publishFinal(state: ScopeState): Promise<boolean> {
		const intent = state.final!;
		if (intent.confirmed) {
			await this.closeFinalProgress(state);
			return true;
		}
		if (intent.nextAttemptAt > Date.now()) return false;
		if (intent.attempts >= MAX_FINAL_ATTEMPTS) {
			log.logWarn("delivery.scope.final_abandoned", "Scope final delivery abandoned", {
				fields: { owner: state.owner, intentId: intent.id, attempts: intent.attempts },
			});
			await this.commit(state, {
				...state,
				final: { ...intent, result: "blocked", nextAttemptAt: ABANDONED_ATTEMPT_AT, confirmed: false },
				progressClosed: true,
				closed: true,
				closeRequested: false,
			});
			return false;
		}
		const attempt = {
			...intent,
			attempts: intent.attempts + 1,
			nextAttemptAt: Date.now() + Math.min(900_000, 60_000 * 2 ** Math.min(intent.attempts, 4)),
			result: "unknown" as const,
			confirmed: false,
		};
		await this.commit(state, { ...state, final: attempt });
		let result: "confirmed" | "unknown" | "blocked" = "unknown";
		try {
			result = (await this.port(state)?.finalize({ id: intent.id, text: intent.text }))?.status ?? "blocked";
		} catch (error) {
			log.logWarn("delivery.scope.final_failed", "Scope final delivery failed", {
				reason: errorMessage(error),
				fields: { owner: state.owner, intentId: intent.id },
			});
		}
		await this.commit(state, { ...state, final: { ...attempt, result, confirmed: result === "confirmed" } });
		if (result === "confirmed") await this.closeFinalProgress(state);
		return result === "confirmed";
	}

	private async closeFinalProgress(state: ScopeState): Promise<void> {
		if (state.progressClosed) return;
		try {
			await this.closeProgress(state, this.port(state), true);
		} catch (error) {
			log.logWarn("delivery.scope.close_failed", "Scope progress close failed", { reason: errorMessage(error) });
		}
	}

	start(): void {
		this.timer = setInterval(() => {
			void this.retry().catch((error) =>
				log.logWarn("delivery.scope.retry_failed", "Scope retry failed", { reason: errorMessage(error) }),
			);
		}, 30_000);
		this.timer.unref();
	}
	/** Retry durable finals and close quiescent request progress; never replay a model turn. */
	async retry(): Promise<void> {
		for (const [key, state] of this.states) {
			if (this.stopped) return;
			try {
				await this.serial(key, async () => {
					if (state.final) {
						if (!state.final.confirmed || !state.progressClosed) await this.publishFinal(state);
						return;
					}
					if (state.closeRequested) {
						await this.closeProgress(state, this.port(state, { deferCard: true }), true, "已停止");
						return;
					}
					// Tasks retain their outbox close gate. A request's active turn or an unseen
					// completion still owns progress; cancellation/removal needs no copied work state.
					if (
						state.owner.scopeId.startsWith("task:") ||
						state.closed ||
						state.progressClosed ||
						this.writers.has(key) ||
						!this.reachable(state.owner)
					)
						return;
					if (
						this.options
							.work(state.owner)
							.some((item) => item.pending || (item.completionId && !state.consumed.includes(item.completionId)))
					)
						return;
					await this.closeProgress(state, this.port(state), false);
				});
			} catch (error) {
				log.logWarn("delivery.scope.retry_failed", "Scope retry failed", {
					reason: errorMessage(error),
					fields: { owner: state.owner },
				});
			}
		}
	}
	async stop(): Promise<void> {
		this.stopped = true;
		if (this.timer) clearInterval(this.timer);
		await Promise.allSettled([...this.operations]);
	}
}
