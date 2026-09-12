import type { Agent, AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai/compat";
import {
	type AgentSession,
	SettingsManager as SDKSettingsManager,
	type SessionManager,
} from "@earendil-works/pi-coding-agent";
import * as log from "../log.js";
import type { PipiclawSettingsManager } from "../settings.js";

export function asSdkSettingsManager(manager: PipiclawSettingsManager): SDKSettingsManager {
	// The upstream session needs its broad interactive SettingsManager surface, while
	// Pipiclaw deliberately owns a small runtime-specific settings contract. Build a
	// real upstream manager from that contract instead of making PipiclawSettingsManager
	// pretend to implement dozens of unrelated no-op UI preferences.
	return SDKSettingsManager.inMemory({
		defaultProvider: manager.getDefaultProvider(),
		defaultModel: manager.getDefaultModel(),
		defaultThinkingLevel: manager.getDefaultThinkingLevel() ?? DEFAULT_MAIN_THINKING_LEVEL,
		compaction: manager.getCompactionSettings(),
		retry: manager.getRetrySettings(),
	});
}

export const DEFAULT_MAIN_THINKING_LEVEL: ThinkingLevel = "medium";

/** Apply the pi 0.83 source-model thinking compatibility branch to one real AgentSession. */
export async function setModelWithThinkingPreservation(
	session: AgentSession,
	manager: SDKSettingsManager,
	model: Model<Api>,
): Promise<void> {
	const source = session.model;
	if (!source?.reasoning) {
		await session.setModel(model);
		return;
	}
	const previousDefault = manager.getDefaultThinkingLevel();
	manager.setDefaultThinkingLevel(session.thinkingLevel);
	try {
		await session.setModel(model);
	} finally {
		manager.setDefaultThinkingLevel(previousDefault ?? DEFAULT_MAIN_THINKING_LEVEL);
	}
}

export function setThinkingLevelWithConditionalPersist(session: AgentSession, level: ThinkingLevel): void {
	const before = session.thinkingLevel;
	session.setThinkingLevel(level);
	const effective = session.thinkingLevel;
	if (effective === before) return;
	if (!session.model?.reasoning && effective === "off") return;
	session.setThinkingLevel(effective, { persist: true });
}

export function cycleThinkingLevelWithConditionalPersist(session: AgentSession): ThinkingLevel | undefined {
	const before = session.thinkingLevel;
	const next = session.cycleThinkingLevel();
	const effective = session.thinkingLevel;
	if (next && effective !== before && (session.model?.reasoning || effective !== "off")) {
		session.setThinkingLevel(effective, { persist: true });
	}
	return next;
}

export function initializeThinkingLevelCompat(
	agent: Agent,
	model: Model<Api>,
	sessionManager: SessionManager,
	configuredDefault: ThinkingLevel | undefined,
): ThinkingLevel {
	const branch = sessionManager.getBranch();
	const hasThinkingEntry = branch.some((entry) => entry.type === "thinking_level_change");
	const historical = sessionManager.buildSessionContext().thinkingLevel as ThinkingLevel;
	const requested = hasThinkingEntry ? historical : (configuredDefault ?? DEFAULT_MAIN_THINKING_LEVEL);
	const effective = clampThinkingLevel(model, requested);
	agent.state.thinkingLevel = effective;
	if (!hasThinkingEntry) sessionManager.appendThinkingLevelChange(effective);
	return effective;
}

/**
 * Overwrite the SDK session's `baseToolsOverride` map so a resource reload swaps in
 * freshly-built tools. The SDK exposes no public setter for this, so we reach into the
 * private `_baseToolsOverride` field. This is the single, isolated point of that coupling:
 * if a future SDK renames or removes the field, the guard below warns loudly instead of
 * silently leaving stale tools in place. Replace with a public setter once upstream adds one.
 */
export function setSessionBaseToolsOverride(session: AgentSession, tools: AgentTool<any>[], channelId: string): void {
	const target = session as unknown as { _baseToolsOverride?: Record<string, AgentTool<any>> };
	if (!("_baseToolsOverride" in target)) {
		log.logWarning(
			`[${channelId}] AgentSession no longer exposes _baseToolsOverride; tool reloads may use stale tools (SDK change?)`,
		);
	}
	target._baseToolsOverride = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
}
