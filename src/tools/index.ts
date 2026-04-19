import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { MemoryCandidateStore } from "../memory/candidates.js";
import { APP_HOME_DIR } from "../paths.js";
import type { Executor, SandboxConfig } from "../sandbox.js";
import { loadSecurityConfig } from "../security/config.js";
import type { SecurityConfig, SecurityRuntimeContext } from "../security/types.js";
import type { PipiclawMemoryRecallSettings, PipiclawSessionSearchSettings } from "../settings.js";
import type { SubAgentDiscoveryResult } from "../subagents/discovery.js";
import { createSubAgentTool } from "../subagents/tool.js";
import { createBashTool } from "./bash.js";
import type { PipiclawToolsConfig } from "./config.js";
import { loadToolsConfig } from "./config.js";
import { createEditTool } from "./edit.js";
import { createReadTool } from "./read.js";
import { createSessionSearchTool } from "./session-search.js";
import { createSkillListTool } from "./skill-list.js";
import { createSkillManageTool } from "./skill-manage.js";
import { createSkillViewTool } from "./skill-view.js";
import { createWebFetchTool } from "./web-fetch.js";
import { createWebSearchTool } from "./web-search.js";
import { createWriteTool } from "./write.js";

export interface CreatePipiclawToolsOptions {
	executor: Executor;
	getCurrentModel: () => Model<Api>;
	getAvailableModels: () => Model<Api>[];
	resolveApiKey: (model: Model<Api>) => Promise<string>;
	workspaceDir: string;
	channelDir: string;
	workspacePath: string;
	channelId: string;
	sandboxConfig: SandboxConfig;
	getSubAgentDiscovery: () => SubAgentDiscoveryResult;
	getMemoryRecallSettings: () => PipiclawMemoryRecallSettings;
	getSessionSearchSettings: () => PipiclawSessionSearchSettings;
	memoryCandidateStore: MemoryCandidateStore;
	securityConfig?: SecurityConfig;
	toolsConfig?: PipiclawToolsConfig;
}

export interface CreatePipiclawBaseToolsOptions {
	securityConfig?: SecurityConfig;
	securityContext?: SecurityRuntimeContext;
	channelId?: string;
}

export function createPipiclawBaseTools(
	executor: Executor,
	options: CreatePipiclawBaseToolsOptions = {},
): AgentTool<any>[] {
	const hasSecurityOptions = options.securityConfig || options.securityContext || options.channelId;
	const toolOptions = hasSecurityOptions
		? {
				securityConfig: options.securityConfig,
				securityContext: options.securityContext,
				channelId: options.channelId,
			}
		: undefined;
	return [
		createReadTool(executor, toolOptions),
		createBashTool(executor, toolOptions),
		createEditTool(executor, toolOptions),
		createWriteTool(executor, toolOptions),
	];
}

export function createPipiclawTools(options: CreatePipiclawToolsOptions): AgentTool<any>[] {
	const securityConfig = options.securityConfig ?? loadSecurityConfig(APP_HOME_DIR);
	const toolsConfig = options.toolsConfig ?? loadToolsConfig(APP_HOME_DIR);
	const securityContext = {
		workspaceDir: options.workspaceDir,
		workspacePath: options.workspacePath,
		cwd: process.cwd(),
	};
	const baseTools = createPipiclawBaseTools(options.executor, {
		securityConfig,
		securityContext,
		channelId: options.channelId,
	});
	const webTools =
		toolsConfig.tools.web.enable === false
			? []
			: [
					createWebSearchTool({
						webConfig: toolsConfig.tools.web,
						securityConfig,
						workspaceDir: options.workspaceDir,
						channelId: options.channelId,
					}),
					createWebFetchTool({
						webConfig: toolsConfig.tools.web,
						securityConfig,
						workspaceDir: options.workspaceDir,
						channelId: options.channelId,
					}),
				];
	const memoryTools =
		toolsConfig.tools.memory.sessionSearch.enabled === false
			? []
			: [
					createSessionSearchTool({
						channelDir: options.channelDir,
						getCurrentModel: options.getCurrentModel,
						resolveApiKey: options.resolveApiKey,
						getSessionSearchSettings: options.getSessionSearchSettings,
					}),
				];
	const skillTools =
		toolsConfig.tools.skills.manage.enabled === false
			? []
			: [
					createSkillListTool({
						workspaceDir: options.workspaceDir,
						workspacePath: options.workspacePath,
					}),
					createSkillViewTool({
						workspaceDir: options.workspaceDir,
						workspacePath: options.workspacePath,
					}),
					createSkillManageTool({
						workspaceDir: options.workspaceDir,
						workspacePath: options.workspacePath,
					}),
				];
	return [
		...baseTools,
		...webTools,
		...memoryTools,
		...skillTools,
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
			runtimeContext: {
				workspacePath: options.workspacePath,
				channelId: options.channelId,
				sandbox: options.sandboxConfig.type === "host" ? "host" : `docker:${options.sandboxConfig.container}`,
			},
		}),
	];
}
