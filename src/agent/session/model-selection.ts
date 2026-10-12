/**
 * Which model a channel is on: the preferred (active) model, the backup-model switch and its
 * cooldown, resolving the configured backup, and the thinking-level handling that has to stay in
 * step with a model change. Reads the live session through callbacks, since the session is rebuilt
 * on `/new`, fork and task binding.
 */
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	AgentSession,
	ModelRegistry,
	SettingsManager as SDKSettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { PipiclawSettingsManager } from "../../config/settings.js";
import * as log from "../../log.js";
import { getApiKeyForModel } from "../../models/api-keys.js";
import { PRIMARY_COOLDOWN_MS, shouldRestorePrimary } from "../../models/fallback.js";
import { findExactModelReferenceMatch, formatModelReference } from "../../models/reference.js";
import { defaultModel } from "../../models/runtime.js";
import { errorMessage } from "../../shared/text-utils.js";
import {
	cycleThinkingLevelWithConditionalPersist,
	setModelWithThinkingPreservation,
	setThinkingLevelWithConditionalPersist,
} from "./session-adapter.js";

export interface ModelSelectionDeps {
	channelId: string;
	settingsManager: PipiclawSettingsManager;
	getSession: () => AgentSession;
	getSessionSettingsManager: () => SDKSettingsManager;
	getModelRegistry: () => ModelRegistry;
}

export class ModelSelection {
	/** The preferred model. Replaced from settings once the model registry exists, and by `/model`. */
	activeModel: Model<Api> = defaultModel;
	/** When the primary model last failed and we switched to the backup. null = on primary. */
	private primaryFailedAt: number | null = null;

	constructor(private deps: ModelSelectionDeps) {}

	markPrimaryFailed(): void {
		this.primaryFailedAt = Date.now();
	}

	/** A manual `/model` switch redefines the preferred model and clears fallback state. */
	clearFallbackState(): void {
		this.primaryFailedAt = null;
	}

	/** Set while running on the backup model: what the primary is and when it may be retried. */
	fallbackStatus(current: Model<Api>): { primary: string; cooldownUntilMs: number } | undefined {
		if (formatModelReference(current) === formatModelReference(this.activeModel)) return undefined;
		return {
			primary: formatModelReference(this.activeModel),
			cooldownUntilMs: (this.primaryFailedAt ?? Date.now()) + PRIMARY_COOLDOWN_MS,
		};
	}

	/**
	 * At turn start, if a fallback is active and the primary's cooldown has elapsed,
	 * switch back to the preferred model. Silent — no user notice on recovery.
	 */
	async maybeRestorePrimaryModel(): Promise<void> {
		const current = this.deps.getSession().model;
		if (!current || formatModelReference(current) === formatModelReference(this.activeModel)) {
			this.primaryFailedAt = null;
			return;
		}
		if (!shouldRestorePrimary(this.primaryFailedAt, Date.now())) {
			return;
		}
		try {
			await this.setModelWithThinkingPreservation(this.activeModel);
			this.primaryFailedAt = null;
			log.logInfo(`[${this.deps.channelId}] Restored primary model ${formatModelReference(this.activeModel)}`);
		} catch (err) {
			log.logWarn("agent.model.restore_failed", "Primary model restore failed", {
				channelId: this.deps.channelId,
				reason: errorMessage(err),
			});
		}
	}

	async setModelWithThinkingPreservation(model: Model<Api>): Promise<void> {
		await setModelWithThinkingPreservation(this.deps.getSession(), this.deps.getSessionSettingsManager(), model);
	}

	setThinkingLevelCompat(level: ThinkingLevel): void {
		setThinkingLevelWithConditionalPersist(this.deps.getSession(), level);
	}

	cycleThinkingLevelCompat(): ThinkingLevel | undefined {
		return cycleThinkingLevelWithConditionalPersist(this.deps.getSession());
	}

	/**
	 * Resolve the configured backup model reference against available models.
	 * Returns null when unset, unresolvable/ambiguous, or missing an API key —
	 * each case logs a warning and disables fallback for this turn.
	 */
	async resolveFallbackModel(): Promise<Model<Api> | null> {
		const reference = this.deps.settingsManager.getFallbackModelReference();
		if (!reference) {
			return null;
		}
		const modelRegistry = this.deps.getModelRegistry();
		await modelRegistry.refresh();
		const available = modelRegistry.getAvailable();
		const { match, ambiguous } = findExactModelReferenceMatch(reference, available);
		if (!match) {
			log.logWarn("agent.model.fallback_unresolved", "Fallback model skipped", {
				channelId: this.deps.channelId,
				fields: { reference, problem: ambiguous ? "ambiguous" : "not found" },
			});
			return null;
		}
		try {
			await getApiKeyForModel(modelRegistry, match);
		} catch {
			log.logWarn("agent.model.fallback_unresolved", "Fallback model skipped", {
				channelId: this.deps.channelId,
				fields: { reference, problem: "no API key" },
			});
			return null;
		}
		return match;
	}
}
