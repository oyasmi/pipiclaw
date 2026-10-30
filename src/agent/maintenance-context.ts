import { statSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { peekActiveSessionFile } from "../channel/active-session-store.js";
import type { PipiclawSettingsManager } from "../config/settings.js";
import type { DeskConversation } from "../desk/types.js";
import { enqueueBoundaryReflectEntries } from "../memory/boundary-work.js";
import type { MemoryMaintenanceRuntimeContext } from "../memory/scheduler.js";
import { getApiKeyForModel } from "../models/api-keys.js";
import { createModelRuntime, resolveInitialModel, wrapModelRegistry } from "../models/runtime.js";

/** /new's local persistence path: no runner, credentials, inference, or memory queue. */
export async function preserveMemoryBeforeNewSession(conversation: DeskConversation): Promise<void> {
	const file = join(conversation.conversationDir, peekActiveSessionFile(conversation.conversationDir));
	try {
		statSync(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	const session = SessionManager.open(file, conversation.conversationDir, conversation.cwd);
	await enqueueBoundaryReflectEntries(conversation, session.getBranch());
}

export interface DetachedMaintenanceContextOptions {
	conversation: DeskConversation;
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

// The maintenance scheduler visits idle conversations every tick; re-parsing an
// unchanged session file each time would be pure I/O waste for long-dead
// conversations. Keyed by session file, replaced whenever the file changes.
const transcriptCache = new Map<string, CachedTranscript>();

/** Test hook: drop cached transcripts so a fresh read is forced. */
export function clearDetachedMaintenanceCache(): void {
	transcriptCache.clear();
}

/**
 * Build a MemoryMaintenanceRuntimeContext for a conversation with no live runner,
 * straight from its active session on disk (the same file a runner would open). This is deliberately much lighter than a ChannelRunner:
 * no Agent, no AgentSession, no tool set, no sub-agent discovery — just the
 * persisted transcript, the resolved model, and current settings. Channels
 * that spoke this boot keep using their runner's in-memory context instead.
 *
 * Returns null when the conversation has no persisted transcript (nothing for the
 * memory pipeline to work with) or the transcript cannot be read.
 */
export async function loadDetachedMaintenanceContext(
	options: DetachedMaintenanceContextOptions,
): Promise<MemoryMaintenanceRuntimeContext | null> {
	const { conversation } = options;
	const contextFile = join(conversation.conversationDir, peekActiveSessionFile(conversation.conversationDir));
	let stats: { mtimeMs: number; size: number };
	try {
		stats = statSync(contextFile);
	} catch {
		return null;
	}

	let cached = transcriptCache.get(contextFile);
	if (!cached || cached.mtimeMs !== stats.mtimeMs || cached.size !== stats.size) {
		try {
			const sessionManager = SessionManager.open(contextFile, conversation.conversationDir, conversation.cwd);
			cached = {
				mtimeMs: stats.mtimeMs,
				size: stats.size,
				messages: sessionManager.buildSessionContext().messages,
				sessionEntries: sessionManager.getBranch(),
			};
		} catch {
			return null;
		}
		transcriptCache.set(contextFile, cached);
	}
	const cachedTranscript = cached;

	const modelRuntime = await createModelRuntime({
		authConfigPath: options.authConfigPath,
		modelsConfigPath: options.modelsConfigPath,
	});
	const modelRegistry = wrapModelRegistry(modelRuntime);
	const model = resolveInitialModel(modelRegistry, options.settingsManager);

	options.settingsManager.reload();
	return {
		conversation,
		workspaceDir: options.workspaceDir,
		messages: () => [...cachedTranscript.messages],
		sessionEntries: () => [...cachedTranscript.sessionEntries],
		model,
		resolveApiKey: async (candidate) => getApiKeyForModel(modelRegistry, candidate),
		settings: { memoryMaintenance: options.settingsManager.getMemoryMaintenanceSettings() },
	};
}
