import { statSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { AuthStorage, type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import type { MemoryMaintenanceRuntimeContext } from "../memory/scheduler.js";
import { getApiKeyForModel } from "../models/api-keys.js";
import { createModelRegistry, resolveInitialModel } from "../models/utils.js";
import type { PipiclawSettingsManager } from "../settings.js";
import { loadPipiclawSkills } from "./workspace-resources.js";

export interface DetachedMaintenanceContextOptions {
	channelId: string;
	channelDir: string;
	workspaceDir: string;
	authConfigPath: string;
	modelsConfigPath: string;
	settingsManager: PipiclawSettingsManager;
}

interface CachedTranscript {
	mtimeMs: number;
	size: number;
	messages: AgentMessage[];
	sessionEntries: SessionEntry[];
}

// The maintenance scheduler visits idle channels every tick; re-parsing an
// unchanged context.jsonl each time would be pure I/O waste for long-dead
// channels. Keyed by channelDir, replaced whenever the file changes.
const transcriptCache = new Map<string, CachedTranscript>();

/** Test hook: drop cached transcripts so a fresh read is forced. */
export function clearDetachedMaintenanceCache(): void {
	transcriptCache.clear();
}

/**
 * Build a MemoryMaintenanceRuntimeContext for a channel with no live runner,
 * straight from disk. This is deliberately much lighter than a ChannelRunner:
 * no Agent, no AgentSession, no tool set, no sub-agent discovery — just the
 * persisted transcript, the resolved model, and current settings. Channels
 * that spoke this boot keep using their runner's in-memory context instead.
 *
 * Returns null when the channel has no persisted transcript (nothing for the
 * memory pipeline to work with) or the transcript cannot be read.
 */
export async function loadDetachedMaintenanceContext(
	options: DetachedMaintenanceContextOptions,
): Promise<MemoryMaintenanceRuntimeContext | null> {
	const contextFile = join(options.channelDir, "context.jsonl");
	let stats: { mtimeMs: number; size: number };
	try {
		stats = statSync(contextFile);
	} catch {
		return null;
	}

	let cached = transcriptCache.get(options.channelDir);
	if (!cached || cached.mtimeMs !== stats.mtimeMs || cached.size !== stats.size) {
		try {
			const sessionManager = SessionManager.open(contextFile, options.channelDir);
			cached = {
				mtimeMs: stats.mtimeMs,
				size: stats.size,
				messages: sessionManager.buildSessionContext().messages,
				sessionEntries: sessionManager.getBranch(),
			};
		} catch {
			return null;
		}
		transcriptCache.set(options.channelDir, cached);
	}

	const authStorage = AuthStorage.create(options.authConfigPath);
	const modelRegistry = createModelRegistry(authStorage, options.modelsConfigPath);
	const model = resolveInitialModel(modelRegistry, options.settingsManager);

	options.settingsManager.reload();
	return {
		channelId: options.channelId,
		channelDir: options.channelDir,
		workspaceDir: options.workspaceDir,
		messages: [...cached.messages],
		sessionEntries: [...cached.sessionEntries],
		model,
		resolveApiKey: async (candidate) => getApiKeyForModel(modelRegistry, candidate),
		settings: {
			sessionMemory: options.settingsManager.getSessionMemorySettings(),
			memoryGrowth: options.settingsManager.getMemoryGrowthSettings(),
			memoryMaintenance: options.settingsManager.getMemoryMaintenanceSettings(),
		},
		loadedSkills: loadPipiclawSkills(options.channelDir).map((skill) => ({
			name: skill.name,
			description: skill.description,
		})),
	};
}
