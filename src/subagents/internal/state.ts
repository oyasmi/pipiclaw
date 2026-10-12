/**
 * Mutable facts about one internal run, shared by the worker watcher, provider-retry recovery and
 * outcome assembly. One object instead of a dozen closure variables, so each of those can live in
 * its own file while still observing the same live values.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import { formatModelReference } from "../../models/utils.js";
import { createEmptyUsageTotals, type UsageTotals } from "../../usage/totals.js";
import type { ResolvedInternalSubAgentConfig } from "../discovery.js";
import { createDetails } from "../result.js";
import type { SubAgentRunContext, SubAgentToolFields } from "../types.js";

export interface InternalRunState {
	readonly startedAt: number;
	readonly usage: UsageTotals;
	assistantTurns: number;
	toolCalls: number;
	failureReason: string | undefined;
	/** Set alongside failureReason only for the three self-inflicted budget aborts, distinct from an explicit cancel. */
	budgetExceeded: boolean;
	/** Set only by the `subagent_run op=cancel` handle registered as soon as the run is durable. */
	externallyCancelled: boolean;
	/** True once the sync grace window has elapsed and a "still running" placeholder has been returned. */
	detached: boolean;
	lastUpdateText: string;
	/** The model actually answering; differs from `config.model` once a backup-model switch happened. */
	activeModel: Model<Api>;
	/** Set when the run switched to the backup model, for the reply and the record. */
	fallbackNote: string | undefined;
	/** Read on every provider request, so a backup-model switch only has to replace the key. */
	apiKey: string;
}

export function createInternalRunState(model: Model<Api>, apiKey: string): InternalRunState {
	return {
		startedAt: Date.now(),
		usage: createEmptyUsageTotals(),
		assistantTurns: 0,
		toolCalls: 0,
		failureReason: undefined,
		budgetExceeded: false,
		externallyCancelled: false,
		detached: false,
		lastUpdateText: "",
		activeModel: model,
		fallbackNote: undefined,
		apiKey,
	};
}

/** Progress sink: forwards a status line to the dispatching tool call until the run detaches. */
export function createUpdateEmitter(input: {
	config: ResolvedInternalSubAgentConfig;
	runContext: SubAgentRunContext;
	state: InternalRunState;
	onUpdate?: (update: { content: Array<{ type: "text"; text: string }>; details: SubAgentToolFields }) => void;
}): (text: string) => void {
	const { config, runContext, state, onUpdate } = input;
	return (text: string) => {
		// Once detached, execute() has already returned to the SDK; nothing is listening
		// for further progress on this (from its view, finished) tool call.
		if (state.detached) return;
		const nextText = text.trim();
		if (!nextText || nextText === state.lastUpdateText) {
			return;
		}
		state.lastUpdateText = nextText;
		onUpdate?.({
			content: [{ type: "text", text: nextText }],
			details: createDetails({
				config,
				runContext,
				usage: state.usage,
				turns: state.assistantTurns,
				toolCalls: state.toolCalls,
				durationMs: Date.now() - state.startedAt,
				failed: Boolean(state.failureReason),
				failureReason: state.failureReason,
				modelOverride: state.fallbackNote ? formatModelReference(state.activeModel) : undefined,
			}),
		});
	};
}
