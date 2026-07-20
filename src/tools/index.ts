import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getChannelJobManager } from "../agent/job-manager.js";
import type { Executor } from "../executor.js";
import type { MemoryCandidateStore } from "../memory/candidates.js";
import { APP_HOME_DIR } from "../paths.js";
import type { MediaSender } from "../runtime/channel-context.js";
import { loadSecurityConfig } from "../security/config.js";
import type { SecurityConfig } from "../security/types.js";
import type { PipiclawMemoryRecallSettings, PipiclawSessionSearchSettings } from "../settings.js";
import type { SubAgentDiscoveryResult } from "../subagents/discovery.js";
import { createSubAgentTool } from "../subagents/tool.js";
import type { PipiclawToolsConfig } from "./config.js";
import { loadToolsConfig } from "./config.js";
import { buildToolSet } from "./registry.js";
import { withToolDetails } from "./tool-details.js";

export interface CreatePipiclawToolsOptions {
	executor: Executor;
	getCurrentModel: () => Model<Api>;
	getAvailableModels: () => Model<Api>[];
	resolveApiKey: (model: Model<Api>) => Promise<string>;
	workspaceDir: string;
	channelDir: string;
	channelId: string;
	getSubAgentDiscovery: () => SubAgentDiscoveryResult;
	getMemoryRecallSettings: () => PipiclawMemoryRecallSettings;
	getSubAgentModelReference?: () => string | null;
	getSessionSearchSettings: () => PipiclawSessionSearchSettings;
	memoryCandidateStore: MemoryCandidateStore;
	securityConfig?: SecurityConfig;
	toolsConfig?: PipiclawToolsConfig;
	/** Transport-provided attachment port; when present, enables the `send_media` tool. */
	mediaSender?: MediaSender;
}

export function createPipiclawTools(options: CreatePipiclawToolsOptions): AgentTool<any>[] {
	const securityConfig = options.securityConfig ?? loadSecurityConfig(APP_HOME_DIR);
	const toolsConfig = options.toolsConfig ?? loadToolsConfig(APP_HOME_DIR);
	const securityContext = {
		workspaceDir: options.workspaceDir,
		cwd: process.cwd(),
	};
	// The leaf tools (files, web, memory, skills) come from the single declarative
	// registry so this set, the sub-agent set, and the prompt hints share one source.
	// The `subagent` tool is appended separately: it is never available to sub-agents
	// and keeping it out of the registry avoids a registry ↔ subagents/tool import cycle.
	const leafTools = buildToolSet({
		executor: options.executor,
		securityConfig,
		securityContext,
		channelId: options.channelId,
		channelDir: options.channelDir,
		workspaceDir: options.workspaceDir,
		webConfig: toolsConfig.tools.web,
		toolsConfig,
		rtkEnabled: toolsConfig.tools.rtk.enabled,
		jobManager: getChannelJobManager(options.channelId, options.executor),
		getCurrentModel: options.getCurrentModel,
		getAvailableModels: options.getAvailableModels,
		resolveApiKey: options.resolveApiKey,
		getSessionSearchSettings: options.getSessionSearchSettings,
		memoryCandidateStore: options.memoryCandidateStore,
		mediaSender: options.mediaSender,
	});
	return [
		...leafTools,
		// Bound to the same `details` contract as the registry's tools; it is registered here
		// rather than in TOOL_REGISTRY only to avoid a registry ↔ subagents/tool import cycle.
		withToolDetails(
			createSubAgentTool({
				executor: options.executor,
				getCurrentModel: options.getCurrentModel,
				getAvailableModels: options.getAvailableModels,
				resolveApiKey: options.resolveApiKey,
				workspaceDir: options.workspaceDir,
				channelDir: options.channelDir,
				getSubAgentDiscovery: options.getSubAgentDiscovery,
				getMemoryRecallSettings: options.getMemoryRecallSettings,
				getSubAgentModelReference: options.getSubAgentModelReference,
				memoryCandidateStore: options.memoryCandidateStore,
				securityConfig,
				webConfig: toolsConfig.tools.web,
				rtkEnabled: toolsConfig.tools.rtk.enabled,
				runtimeContext: {
					workspaceDir: options.workspaceDir,
					channelId: options.channelId,
				},
			}),
			"subagent",
		),
	];
}
