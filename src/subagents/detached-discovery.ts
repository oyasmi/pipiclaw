import { createModelRuntime, wrapModelRegistry } from "../models/utils.js";
import { discoverSubAgents, type SubAgentDiscoveryResult } from "./discovery.js";

/**
 * Resolve the role directory for `/subagents roles` when no `ChannelRunner` is currently active
 * for the channel (spec 041) — mirrors `loadDetachedMaintenanceContext` in
 * `agent/maintenance-context.ts`: deliberately much lighter than a full runner (no Agent, no
 * AgentSession, no tool set), just enough to resolve model references in role frontmatter so
 * `unavailable` reasons are accurate instead of guessed from an empty model list.
 */
export async function loadDetachedSubAgentDiscovery(options: {
	workspaceDir: string;
	authConfigPath: string;
	modelsConfigPath: string;
}): Promise<SubAgentDiscoveryResult> {
	const modelRuntime = await createModelRuntime({
		authConfigPath: options.authConfigPath,
		modelsConfigPath: options.modelsConfigPath,
	});
	const modelRegistry = wrapModelRegistry(modelRuntime);
	return discoverSubAgents(options.workspaceDir, modelRegistry.getAvailable());
}
