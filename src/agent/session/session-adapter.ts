/**
 * Adapters over the SDK session where Pipiclaw needs compatibility behaviour: the settings-manager
 * shim and thinking-level preservation when a model changes.
 */
import type { Agent, AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai/compat";
import {
	type AgentSession,
	SettingsManager as SDKSettingsManager,
	type SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { PipiclawSettingsManager } from "../../config/settings.js";
import * as log from "../../log.js";

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
		log.logWarn(
			"agent.session.sdk_drift",
			"AgentSession no longer exposes _baseToolsOverride; tool reloads may use stale tools",
			{ channelId: channelId },
		);
	}
	target._baseToolsOverride = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
}

/** One prompt's origin. Raw entries establish safety; projection only decides what still needs omission. */
export class SessionRetryAttempt<T extends Pick<AgentSession, "sessionManager" | "refreshContext"> = AgentSession> {
	private readonly manager: SessionManager;
	private readonly sessionId: string;
	private readonly prefix: string[];
	private retryBranch: string[] | undefined;

	constructor(readonly session: T) {
		this.manager = session.sessionManager;
		this.sessionId = session.sessionManager.getSessionId();
		this.prefix = session.sessionManager.getBranch().map((entry) => entry.id);
	}

	classify(): { kind: "unsubmitted" | "failed-turn"; targets: string[] } | null {
		const manager = this.session.sessionManager;
		if (manager !== this.manager || manager.getSessionId() !== this.sessionId) return null;
		const branch = manager.getBranch();
		if (this.prefix.some((id, index) => branch[index]?.id !== id)) return null;
		if (this.retryBranch) {
			if (this.retryBranch.some((id, index) => branch[index]?.id !== id)) return null;
			// Once prepared, a new interaction or rewinding the failed branch invalidates the plan.
			if (
				branch
					.slice(this.retryBranch.length)
					.some((entry) => entry.type === "message" && entry.message.role !== "system")
			)
				return null;
		}
		const delta = branch.slice(this.prefix.length);
		const users: string[] = [];
		const errors: string[] = [];
		for (const entry of delta) {
			if (entry.type === "message") {
				const message = entry.message;
				if (message.role === "system") continue;
				if (message.role === "user" && errors.length === 0) users.push(entry.id);
				else if (message.role === "assistant" && users.length === 1 && message.stopReason === "error") {
					if (
						message.content.some((part) => part.type === "toolCall" || (part.type === "text" && part.text.trim()))
					) {
						return null;
					}
					errors.push(entry.id);
				} else return null;
			} else if (entry.type === "context_edit") {
				// Only omissions of this attempt's failed messages are understood (including SDK retries).
				if (entry.replacement !== null || ![...users, ...errors].includes(entry.targetId)) return null;
			} else if (!["model_change", "thinking_level_change", "usage"].includes(entry.type)) return null;
		}
		if (users.length === 0 && errors.length === 0) return { kind: "unsubmitted", targets: [] };
		if (users.length !== 1 || errors.length === 0) return null;
		const targets = [...users, ...errors];
		const projection = manager.buildSessionProjection();
		// Even an already omitted entry must have identifiable provenance.
		if (targets.some((id) => !projection.entries.some((entry) => entry.sourceEntry.id === id))) return null;
		return {
			kind: "failed-turn",
			targets: targets.filter((id) =>
				projection.entries.some((entry) => entry.sourceEntry.id === id && entry.messages.length),
			),
		};
	}

	prepare(): ReturnType<SessionRetryAttempt<T>["classify"]> {
		const plan = this.classify();
		if (plan) this.retryBranch ??= this.manager.getBranch().map((entry) => entry.id);
		return plan;
	}

	/** Caller holds the host resource window and must quarantine this session on any exception. */
	omitFailedContext(): boolean {
		const plan = this.prepare();
		if (!plan) return false;
		for (const id of plan.targets) this.session.sessionManager.appendContextEdit(id, null);
		this.session.refreshContext();
		return true;
	}
}
