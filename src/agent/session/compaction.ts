/** Background preparation, fenced adoption, and bounded foreground recovery. */
import { randomUUID } from "node:crypto";
import type { AgentSession, CompactionResult, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import * as log from "../../log.js";
import { errorMessage } from "../../shared/text-utils.js";
import { isRecord } from "../../shared/type-guards.js";
import { withAbortSignal } from "../../shared/with-timeout.js";
import type { RunState } from "../types.js";
import {
	type CompactionSnapshot,
	captureCompaction,
	compactionBudget,
	compactionGain,
	estimateContext,
	snapshotInvalidation,
} from "./compaction-snapshot.js";
import { CompactionSummary, type CompactionSummaryOptions } from "./compaction-summary.js";

const FAILURE_COOLDOWN_MS = 30_000;
const CONTEXT_FULL = "会话上下文空间不足，自动压缩暂未完成。请用 /compact 重试，或用 /new 开新会话。";
interface CompactionOptions extends CompactionSummaryOptions {
	getSession: () => AgentSession;
	getRunState: () => RunState;
	isEnabled?: () => boolean;
	onAdopt?: () => void;
	onPersistenceFault?: (session: AgentSession, error: unknown) => Error;
}
interface Candidate {
	id: string;
	snapshot: CompactionSnapshot;
	controller: AbortController;
	promise: Promise<void>;
	result?: CompactionResult;
	startedAt: number;
}
export class SessionCompaction {
	private readonly cooldowns = new WeakMap<AgentSession, number>();
	private readonly summary: CompactionSummary;
	private candidate?: Candidate;
	private retired = false;
	revision = 0;
	constructor(private readonly options: CompactionOptions) {
		this.summary = new CompactionSummary(options);
	}
	canPrevent(): boolean {
		return !this.retired && Date.now() >= (this.cooldowns.get(this.options.getSession()) ?? 0);
	}
	cancel(reason: string): void {
		const candidate = this.candidate;
		this.candidate = undefined;
		candidate?.controller.abort(new Error(`Background compaction cancelled: ${reason}`));
		if (candidate) this.record("discarded", candidate, { reason });
		if (reason === "stop" && candidate)
			this.cooldowns.set(candidate.snapshot.session, Date.now() + FAILURE_COOLDOWN_MS);
	}
	retire(): void {
		this.retired = true;
		this.cancel("retired");
	}
	private enabled(): boolean {
		return (
			!this.retired &&
			(this.options.isEnabled?.() ?? this.options.getSession().settingsManager.getCompactionEnabled())
		);
	}

	/** A pending candidate never blocks while the complete next input has safe budget. */
	async beforePrompt(incoming: number): Promise<void> {
		if (!this.enabled()) {
			this.cancel("disabled");
			return;
		}
		const session = this.options.getSession();
		if (!session.isIdle) return;
		this.adopt();
		let budget = compactionBudget(session, incoming);
		if (budget.projected >= budget.soft) this.start();
		if (budget.projected < budget.hard) return;
		const candidate = this.candidate;
		if (candidate) await this.wait(candidate);
		if (session !== this.options.getSession() || this.retired || candidate?.controller.signal.aborted)
			throw new Error(CONTEXT_FULL);
		this.adopt();
		budget = compactionBudget(session, incoming);
		if (budget.projected >= budget.hard) throw new Error(CONTEXT_FULL);
	}

	private start(): void {
		if (this.candidate || !this.canPrevent() || !this.enabled()) return;
		const session = this.options.getSession();
		const snapshot = captureCompaction(session);
		if (
			!snapshot ||
			estimateContext(snapshot.preparation.messagesToSummarize) <
				Math.min(8192, compactionBudget(session).window * 0.04) + 4096
		)
			return;
		const candidate: Candidate = {
			id: randomUUID(),
			snapshot,
			controller: new AbortController(),
			promise: Promise.resolve(),
			startedAt: Date.now(),
		};
		this.candidate = candidate;
		this.record("started", candidate);
		candidate.promise = this.summary
			.generate(
				session,
				{
					type: "session_before_compact",
					reason: "threshold",
					willRetry: false,
					branchEntries: snapshot.entries,
					preparation: snapshot.preparation,
					signal: candidate.controller.signal,
				},
				candidate.id,
			)
			.then((result) => {
				if (this.candidate !== candidate || candidate.controller.signal.aborted || this.retired) return;
				candidate.result = {
					...result,
					details: {
						...result.details,
						background: true,
						operationId: candidate.id,
						sessionId: snapshot.sessionId,
						baseCompactionId: snapshot.baseCompactionId,
						throughEntryId: snapshot.throughEntryId,
						prefixHash: snapshot.prefixHash,
					},
				};
				this.record("ready", candidate);
			})
			.catch((error: unknown) => {
				if (this.candidate !== candidate) return;
				this.cooldowns.set(session, Date.now() + FAILURE_COOLDOWN_MS);
				this.cancel("failed");
				log.logWarn("agent.compaction.background_failed", "Background compaction failed", {
					channelId: this.options.conversation.channelId,
					reason: errorMessage(error),
					fields: { operationId: candidate.id },
				});
			});
	}

	private ready(): Candidate | undefined {
		if (!this.enabled()) {
			this.cancel("disabled");
			return;
		}
		const candidate = this.candidate;
		if (!candidate?.result) return;
		const reason = snapshotInvalidation(candidate.snapshot, this.options.getSession());
		if (reason) {
			this.cancel(reason);
			return;
		}
		const gain = compactionGain(candidate.snapshot, candidate.result);
		if (!gain.accepted) {
			this.cooldowns.set(candidate.snapshot.session, Date.now() + FAILURE_COOLDOWN_MS);
			this.record("low_gain", candidate, gain);
			this.cancel("low-gain");
			return;
		}
		return candidate;
	}

	/** Synchronous commit at idle or after all results of a tool batch are persisted. */
	private adopt(): boolean {
		const candidate = this.ready();
		if (!candidate) return false;
		const session = candidate.snapshot.session;
		const result = candidate.result!;
		const gain = compactionGain(candidate.snapshot, result);
		this.candidate = undefined;
		try {
			session.sessionManager.appendCompaction(
				result.summary,
				result.firstKeptEntryId,
				session.getContextUsage()?.tokens ?? result.tokensBefore,
				result.details,
				true,
				result.usage,
			);
			session.refreshContext();
		} catch (error) {
			// SDK indexing precedes disk append: never reuse a generation after a partial commit.
			this.retire();
			const fault = this.options.onPersistenceFault?.(session, error) ?? error;
			void session.abort().catch(() => undefined);
			throw fault;
		}
		this.revision++;
		this.options.onAdopt?.();
		this.record("adopted", candidate, gain);
		return true;
	}

	private async boundary(completed: boolean): Promise<void> {
		const session = this.options.getSession();
		if (!completed || !this.enabled()) {
			this.cancel(completed ? "disabled" : "aborted");
			return;
		}
		try {
			this.adopt();
			let budget = compactionBudget(this.options.getSession());
			if (budget.projected < budget.soft) return;
			this.start();
			if (budget.projected < budget.hard) return;
			const pending = this.candidate;
			if (pending) await this.wait(pending);
			if (this.retired || session !== this.options.getSession() || pending?.controller.signal.aborted) return;
			this.adopt();
			budget = compactionBudget(this.options.getSession());
			if (budget.projected >= budget.hard) throw new Error(CONTEXT_FULL);
		} catch (error) {
			this.failure(error);
			void session.abort().catch(() => undefined);
		}
	}

	createExtensionFactory(): ExtensionFactory {
		return (pi) => {
			pi.on("turn_end", async (event, ctx) => {
				if (ctx.sessionManager === this.options.getSession().sessionManager)
					await this.boundary(event.outcome === "completed");
			});
			pi.on("session_before_switch", () => {
				this.cancel("session-switch");
			});
			pi.on("session_before_fork", () => {
				this.cancel("fork");
			});
			pi.on("session_before_tree", () => {
				this.cancel("tree");
			});
			pi.on("model_select", () => {
				this.cancel("model-switch");
			});
			pi.on("session_compact", (event) => {
				this.revision++;
				const details = event.compactionEntry.details;
				if (isRecord(details) && details.background === true)
					log.logInfoEvent("agent.compaction.adopted", "Background compaction adopted", {
						channelId: this.options.conversation.channelId,
						fields: { operationId: details.operationId, sessionId: details.sessionId, mode: "sdk" },
					});
			});
			pi.on("session_before_compact", async (event, ctx) => {
				const session = this.options.getSession();
				if (this.retired || (ctx && ctx.sessionManager !== session.sessionManager)) return { cancel: true };
				if (event.reason !== "manual" && !this.canPrevent()) return { cancel: true };
				try {
					if (event.reason === "manual") this.cancel("manual");
					else if (this.candidate) {
						const pending = this.candidate;
						await withAbortSignal(event.signal, () => pending.promise);
						const candidate = this.ready();
						if (!candidate || event.signal.aborted) return { cancel: true };
						this.candidate = undefined;
						this.record("offered_to_sdk", candidate);
						return { compaction: candidate.result! };
					}
					const compaction = await this.summary.generate(session, event);
					this.cooldowns.delete(session);
					return { compaction };
				} catch (error) {
					if (event.signal.aborted) this.cancel("foreground-cancelled");
					this.cooldowns.set(session, Date.now() + FAILURE_COOLDOWN_MS);
					if (!event.signal.aborted) this.failure(error);
					// SDK emit swallows exceptions; explicit cancellation forbids default inference.
					session.abortCompaction();
					return { cancel: true };
				}
			});
		};
	}

	private failure(error: unknown): void {
		const state = this.options.getRunState();
		state.lastCompactionError = errorMessage(error);
		log.logWarn("agent.compaction.failed", "Compaction failed", {
			channelId: this.options.conversation.channelId,
			reason: errorMessage(error),
		});
		const ctx = state.ctx;
		if (ctx)
			state.queue?.enqueue(
				() => ctx.respondInThread("⚠️ 上下文压缩未完成，原会话已保留。可用 `/compact` 重试，或用 `/new` 开新会话。"),
				"compaction failure",
			);
	}
	private wait(candidate: Candidate): Promise<void> {
		this.record("waiting", candidate);
		const state = this.options.getRunState();
		const ctx = state.ctx;
		if (ctx)
			state.queue?.enqueue(
				() => ctx.respondInThread("⏳ 正在整理上下文，可用 `/stop` 停止当前回合，或用 `/new` 开新会话。"),
				"compaction wait",
			);
		return candidate.promise;
	}
	private record(state: string, candidate: Candidate, fields: Record<string, unknown> = {}): void {
		log.logInfoEvent(`agent.compaction.${state}`, "Background compaction state changed", {
			channelId: this.options.conversation.channelId,
			fields: {
				operationId: candidate.id,
				sessionId: candidate.snapshot.sessionId,
				state,
				durationMs: Date.now() - candidate.startedAt,
				...fields,
			},
		});
	}
}
