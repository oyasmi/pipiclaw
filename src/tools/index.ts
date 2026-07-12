import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getChannelJobManager } from "../agent/job-manager.js";
import type { Executor } from "../executor.js";
import type { MemoryCandidateStore } from "../memory/candidates.js";
import { APP_HOME_DIR } from "../paths.js";
import { loadSecurityConfig } from "../security/config.js";
import type { SecurityConfig } from "../security/types.js";
import type { PipiclawMemoryRecallSettings, PipiclawSessionSearchSettings } from "../settings.js";
import type { SubAgentDiscoveryResult } from "../subagents/discovery.js";
import { createSubAgentTool } from "../subagents/tool.js";
import type { PipiclawToolsConfig } from "./config.js";
import { loadToolsConfig } from "./config.js";
import { buildToolSet } from "./registry.js";

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
	getSessionSearchSettings: () => PipiclawSessionSearchSettings;
	memoryCandidateStore: MemoryCandidateStore;
	securityConfig?: SecurityConfig;
	toolsConfig?: PipiclawToolsConfig;
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
	});
	return [
		...leafTools,
		createSubAgentTool({
			executor: options.executor,
			getCurrentModel: options.getCurrentModel,
			getAvailableModels: options.getAvailableModels,
			resolveApiKey: options.resolveApiKey,
			workspaceDir: options.workspaceDir,
			channelDir: options.channelDir,
			getSubAgentDiscovery: options.getSubAgentDiscovery,
			getMemoryRecallSettings: options.getMemoryRecallSettings,
			memoryCandidateStore: options.memoryCandidateStore,
			securityConfig,
			webConfig: toolsConfig.tools.web,
			rtkEnabled: toolsConfig.tools.rtk.enabled,
			runtimeContext: {
				workspaceDir: options.workspaceDir,
				channelId: options.channelId,
			},
		}),
	];
}
