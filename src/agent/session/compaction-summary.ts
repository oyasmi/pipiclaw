/** Bounded, side-effect-free summary inference shared by foreground recovery and background preparation. */
import { randomUUID } from "node:crypto";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	compact,
	convertToLlm,
	type ModelRuntime,
	type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import type { DotConversation } from "../../dot/types.js";
import * as log from "../../log.js";
import { estimateTokens } from "../../shared/format.js";
import { isRecord } from "../../shared/type-guards.js";
import { OperationTimeoutError, withAbortSignal } from "../../shared/with-timeout.js";
import type { UsageLedger } from "../../usage/ledger.js";
import { addUsage, createEmptyUsageTotals } from "../../usage/totals.js";
import { reduceSummaryPayloads, splitSummaryInput } from "./compaction-input.js";

export const COMPACTION_TIMEOUT_MS = 60_000;
export const COMPACTION_IDLE_TIMEOUT_MS = 20_000;
const SUMMARY_RESERVE_TOKENS = 5_120; // SDK's 0.8 multiplier gives a 4096-token output cap.
const SUMMARY_INSTRUCTIONS = `Write a concise working checkpoint, aiming for 1500-2500 tokens.
Preserve the current goal, user constraints and prohibitions, verified results versus assumptions,
unresolved errors, exact paths/identifiers and the next concrete actions. Remove superseded and
irrelevant progress from previous summaries. Do not reproduce file contents or routine tool output.
Exception: when completing the active task requires exact small file contents, JSON objects,
field names/types, command flags or opaque values, quote those literals verbatim. Do not rename
keys, translate identifiers, or infer substitute values. Preserve corrections and prohibitions.
If an exact value is unavailable, mark it unknown and give its raw-history reference rather than guessing.
Older raw conversation remains available via session_search; retain useful search identifiers.
This checkpoint must let the next model continue the task without asking the user to repeat it.`;

export interface CompactionSummaryOptions {
	conversation: DotConversation;
	getRuntime: () => ModelRuntime;
	preserveMemory: (event: SessionBeforeCompactEvent) => Promise<void>;
	ledger: UsageLedger;
}

export class CompactionSummary {
	constructor(private readonly options: CompactionSummaryOptions) {}

	async generate(session: AgentSession, event: SessionBeforeCompactEvent, operationId: string = randomUUID()) {
		const controller = new AbortController();
		const signal = AbortSignal.any([event.signal, controller.signal]);
		const startedAt = Date.now();
		const total = setTimeout(
			() => controller.abort(new OperationTimeoutError("compaction", COMPACTION_TIMEOUT_MS)),
			COMPACTION_TIMEOUT_MS,
		);
		total.unref?.();
		let idle: NodeJS.Timeout | undefined;
		let active = true;
		const progress = () => {
			if (!active) return;
			if (idle) clearTimeout(idle);
			idle = setTimeout(
				() => controller.abort(new OperationTimeoutError("compaction progress", COMPACTION_IDLE_TIMEOUT_MS)),
				COMPACTION_IDLE_TIMEOUT_MS,
			);
			idle.unref?.();
		};
		progress();
		try {
			const result = await withAbortSignal(signal, async () => {
				await this.options.preserveMemory({ ...event, signal });
				signal.throwIfAborted();
				const runtime = this.options.getRuntime();
				const selected = session.model;
				if (!selected) throw new Error("No model selected. Use /model to select a model.");
				const model =
					runtime.getPhysicalModel(selected.provider, selected.id) ??
					(
						await runtime.resolveModel(selected, convertToLlm(session.messages), {
							reason: "direct",
							thinkingLevel: "off",
							signal,
						})
					).model;
				const auth = await runtime.getAuth(model, { signal });
				signal.throwIfAborted();
				if (!auth) throw new Error(`No credentials for ${model.provider}; configure credentials on the server.`);
				const requestModel: Model<Api> = auth.auth.baseUrl ? { ...model, baseUrl: auth.auth.baseUrl } : model;
				const reserveTokens = Math.min(SUMMARY_RESERVE_TOKENS, Math.floor(model.contextWindow / 4));
				const previousTokens = estimateTokens(event.preparation.previousSummary ?? "");
				if (model.contextWindow - previousTokens <= reserveTokens + 2048) {
					throw new Error("Previous checkpoint cannot fit this model. Select a larger /model or start /new.");
				}
				const chunks = splitSummaryInput(
					reduceSummaryPayloads(
						[...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages],
						event.branchEntries,
						session.sessionManager.getSessionFile(),
					),
					model.contextWindow - Math.max(previousTokens, SUMMARY_RESERVE_TOKENS * 2),
					reserveTokens,
				);
				const stream: StreamFn = async (target, context, options) => {
					signal.throwIfAborted();
					const response = await session.agent.streamFunction(target, context, options);
					// The SDK awaits result(); consuming deltas here does not change the result promise.
					void (async () => {
						for await (const item of response) {
							if ((item.type === "text_delta" || item.type === "thinking_delta") && item.delta.trim())
								progress();
						}
					})().catch(() => undefined);
					const completion = response.result();
					void completion
						.then(
							(message) =>
								this.options.ledger.record({
									channelId: this.options.conversation.channelId,
									dot: this.options.conversation.dot,
									kind: "sidecar",
									label: "compaction",
									correlationId: operationId,
									model: `${target.provider}/${target.id}`,
									usage: { ...message.usage, total: message.usage.totalTokens },
									cost: message.usage.cost,
								}),
							() => undefined,
						)
						.catch(() => undefined);
					return response;
				};
				const headers = Object.fromEntries(
					Object.entries(auth.auth.headers ?? {}).filter(
						(entry): entry is [string, string] => typeof entry[1] === "string",
					),
				);
				// SDK treats custom summaries as opaque; restore our cumulative file metadata explicitly.
				const previous = [...event.branchEntries].reverse().find((entry) => entry.type === "compaction");
				if (
					previous?.type === "compaction" &&
					isRecord(previous.details) &&
					previous.details.pipiclawSummary === 1
				) {
					for (const [field, target] of [
						["readFiles", event.preparation.fileOps.read],
						["modifiedFiles", event.preparation.fileOps.edited],
					] as const) {
						const files = previous.details[field];
						if (Array.isArray(files)) for (const file of files) if (typeof file === "string") target.add(file);
					}
				}
				let summary: Awaited<ReturnType<typeof compact>> | undefined;
				const totals = createEmptyUsageTotals();
				for (let index = 0; index < chunks.length; index++) {
					summary = await compact(
						{
							...event.preparation,
							messagesToSummarize: chunks[index]!,
							previousSummary: summary?.summary ?? event.preparation.previousSummary,
							turnPrefixMessages: [],
							isSplitTurn: false,
							settings: { ...event.preparation.settings, reserveTokens },
						},
						requestModel,
						auth.auth.apiKey,
						headers,
						`${SUMMARY_INSTRUCTIONS}\nTranscript part ${index + 1}/${chunks.length}; incorporate this part into the checkpoint, retaining earlier constraints and recovery references.\n${event.customInstructions ?? ""}`,
						signal,
						"off",
						stream,
						auth.env,
						{ ...session.settingsManager.getRetrySettings(), maxRetries: 1 },
					);
					signal.throwIfAborted();
					if (summary.usage) addUsage(totals, summary.usage);
				}
				if (!summary) throw new Error("No summary generated. Retry /compact or use /new.");
				if (!summary.summary.trim()) throw new Error("Empty compaction summary. Retry /compact or use /new.");
				log.logInfoEvent("agent.compaction.summary_ready", "Compaction summary ready", {
					channelId: this.options.conversation.channelId,
					fields: {
						operationId,
						durationMs: Date.now() - startedAt,
						model: `${model.provider}/${model.id}`,
						parts: chunks.length,
					},
				});
				return {
					...summary,
					usage: { ...totals, totalTokens: totals.total },
					details: { ...(isRecord(summary.details) ? summary.details : {}), pipiclawSummary: 1 },
				};
			});
			return result;
		} catch (error) {
			controller.abort(error);
			throw error;
		} finally {
			active = false;
			clearTimeout(total);
			if (idle) clearTimeout(idle);
		}
	}
}
