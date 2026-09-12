import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ChannelJobManager } from "../agent/job-manager.js";
import type { MediaSender } from "../channel/channel-context.js";
import type { Executor } from "../executor.js";
import type { FileStore } from "../file-store.js";
import type { SecurityConfig, SecurityRuntimeContext } from "../security/types.js";
import type { PipiclawSessionSearchSettings } from "../settings.js";
import type { SubAgentRunManager } from "../subagents/runs.js";
import { createBashTool } from "./bash.js";
import type { PipiclawToolsConfig, PipiclawWebToolsConfig } from "./config.js";
import { createEditTool } from "./edit.js";
import { createEventManageTool } from "./event-manage.js";
import { createGlobTool } from "./glob.js";
import { createGrepTool } from "./grep.js";
import { createJobTool } from "./job.js";
import { createMemoryForgetTool, createMemorySaveTool, createMemorySearchTool } from "./memory-manage.js";
import { createReadTool } from "./read.js";
import { createSendMediaTool } from "./send-media.js";
import { createSessionSearchTool } from "./session-search.js";
import { createSkillTool } from "./skill.js";
import { SUBAGENT_TOOL_NAMES } from "./subagent-tool-names.js";
import {
	createTaskCloseTool,
	createTaskCreateTool,
	createTaskListTool,
	createTaskLogTool,
	createTaskStepEndTool,
	createTaskUpdateTool,
} from "./task-manage.js";
import { type ToolDetailsKind, withToolDetails } from "./tool-details.js";
import { createWebFetchTool } from "./web-fetch.js";
import { createWebSearchTool } from "./web-search.js";
import { createWriteTool } from "./write.js";

/**
 * Unified build context passed to every tool's `create` closure. It carries the union
 * of everything any registered tool might need; each closure reads only its own fields.
 *
 * Fields used exclusively by main-agent-only tools (models, session-search settings,
 * memory store) are optional: the sub-agent tool set never builds those tools, so it
 * does not supply them. Closures assert presence via `req()` to turn a missing
 * dependency into a loud error instead of a silent undefined.
 */
export interface ToolBuildContext {
	executor: Executor;
	/** File-content port for the generic file tools (spec 044, D1); `Executor` stays command-only. */
	fileStore: FileStore;
	securityConfig: SecurityConfig;
	securityContext: SecurityRuntimeContext;
	channelId: string;
	channelDir: string;
	workspaceDir: string;
	/** Main set: `toolsConfig.tools.web`; sub-agent set: the sub-agent's own webConfig. */
	webConfig?: PipiclawWebToolsConfig;
	/** Present only on the main path; gates the task_* tools and the bash interceptor. */
	toolsConfig?: PipiclawToolsConfig;
	/** Sub-agent set passes its per-invocation bash timeout; the main set relies on the built-in default. */
	bashDefaultTimeoutSeconds?: number;
	/** Gates the bash tool's rtk command optimizer (`tools.rtk.enabled`). Threaded to both sets. */
	rtkEnabled?: boolean;
	/**
	 * Set by `buildToolSet` from `BuildToolSetOptions.forSubagent`. A sub-agent's `securityContext`
	 * has no `channelDir` and may be project-bounded, so tools that would otherwise write into the
	 * channel directory (bash/job output spill) must fall back to a neutral location for it.
	 */
	forSubagent?: boolean;
	/**
	 * Present only on the main path. Enables bash `async` and the `job` tool.
	 * The sub-agent set never supplies it, so sub-agents get neither.
	 */
	jobManager?: ChannelJobManager;
	runManager?: SubAgentRunManager;
	getCurrentModel?: () => Model<Api>;
	getAvailableModels?: () => Model<Api>[];
	resolveApiKey?: (model: Model<Api>) => Promise<string>;
	getSessionSearchSettings?: () => PipiclawSessionSearchSettings;
	/**
	 * Present only on the main path, and only when the driving transport can deliver
	 * files. Gates the `send_media` tool; sub-agents never receive it.
	 */
	mediaSender?: MediaSender;
	/**
	 * Present only inside a task loop step (spec 051, D3): which task this tool set belongs to,
	 * and the cycle it is running in. `task_step_end` is registered only when this is set, so the
	 * chat surface can never end a step that is not running.
	 */
	taskLoop?: { taskId: string; cycleId: string };
	/** Tools completed in the current turn; only the task loop reads it. */
	getToolsUsed?: () => string[];
}

export interface ToolRegistration {
	/** Also the tool's `details.kind`: the name is the authoritative discriminator. */
	name: ToolDetailsKind;
	/** Config gate; when omitted the tool is always enabled. */
	enabledBy?: (ctx: ToolBuildContext) => boolean;
	create: (ctx: ToolBuildContext) => AgentTool<any>;
}

function req<T>(value: T | undefined, name: string): T {
	if (value === undefined) {
		throw new Error(`Tool build context is missing required dependency "${name}"`);
	}
	return value;
}

function fileToolOptions(ctx: ToolBuildContext) {
	return {
		securityConfig: ctx.securityConfig,
		securityContext: ctx.securityContext,
		channelId: ctx.channelId,
	};
}

function memoryToolOptions(ctx: ToolBuildContext) {
	return {
		channelId: ctx.channelId,
		channelDir: ctx.channelDir,
		workspaceDir: ctx.workspaceDir,
	};
}

function taskToolOptions(ctx: ToolBuildContext) {
	return {
		jobManager: req(ctx.jobManager, "jobManager"),
		runManager: req(ctx.runManager, "runManager"),
		workspaceDir: ctx.workspaceDir,
		channelDir: ctx.channelDir,
		channelId: ctx.channelId,
		workingDirectory: ctx.securityContext.projectRoot,
	};
}

function webEnabled(ctx: ToolBuildContext): boolean {
	return ctx.webConfig != null && ctx.webConfig.enable !== false;
}

/**
 * Single source of truth for the agent's leaf tools. The `subagent` tool is intentionally
 * NOT here: it is never available to sub-agents, needs runtime context the registry does
 * not model, and keeping it out avoids a `registry` ↔ `subagents/tool` import cycle (the
 * sub-agent tool set is built by importing `buildToolSet` from this module).
 */
export const TOOL_REGISTRY: ToolRegistration[] = [
	{
		name: "read",
		create: (ctx) => createReadTool(ctx.executor, ctx.fileStore, fileToolOptions(ctx)),
	},
	{
		name: "bash",
		create: (ctx) =>
			createBashTool(ctx.executor, {
				...fileToolOptions(ctx),
				rtkEnabled: ctx.rtkEnabled === true,
				interceptorEnabled: ctx.toolsConfig?.tools.bashInterceptor.enabled === true,
				// Sub-agents get no channel dir (their guard context has none); their spill stays in tmpdir.
				...(ctx.forSubagent ? {} : { channelDir: ctx.channelDir }),
				...(ctx.taskLoop ? { boundTaskId: ctx.taskLoop.taskId } : {}),
				...(ctx.jobManager ? { jobManager: ctx.jobManager } : {}),
				...(ctx.bashDefaultTimeoutSeconds !== undefined
					? { defaultTimeoutSeconds: ctx.bashDefaultTimeoutSeconds }
					: {}),
			}),
	},
	{
		name: "edit",
		create: (ctx) => createEditTool(ctx.fileStore, fileToolOptions(ctx)),
	},
	{
		name: "grep",
		create: (ctx) => createGrepTool(ctx.executor, fileToolOptions(ctx)),
	},
	{
		name: "glob",
		create: (ctx) => createGlobTool(ctx.fileStore, fileToolOptions(ctx)),
	},
	{
		name: "write",
		create: (ctx) => createWriteTool(ctx.fileStore, fileToolOptions(ctx)),
	},
	{
		name: "web_search",
		enabledBy: webEnabled,
		create: (ctx) =>
			createWebSearchTool({
				webConfig: req(ctx.webConfig, "webConfig"),
				securityConfig: ctx.securityConfig,
				workspaceDir: ctx.workspaceDir,
				channelId: ctx.channelId,
			}),
	},
	{
		name: "web_fetch",
		enabledBy: webEnabled,
		create: (ctx) =>
			createWebFetchTool({
				webConfig: req(ctx.webConfig, "webConfig"),
				securityConfig: ctx.securityConfig,
				workspaceDir: ctx.workspaceDir,
				channelId: ctx.channelId,
				channelDir: ctx.channelDir,
			}),
	},
	{
		name: "send_media",
		// Enabled only when the driving transport supplied a media sender (the DingTalk
		// bot, or the terminal). Absent it, the tool is not built or advertised.
		enabledBy: (ctx) => ctx.mediaSender != null,
		create: (ctx) =>
			createSendMediaTool(ctx.fileStore, {
				mediaSender: req(ctx.mediaSender, "mediaSender"),
				channelId: ctx.channelId,
				securityConfig: ctx.securityConfig,
				securityContext: ctx.securityContext,
			}),
	},
	{
		name: "session_search",
		create: (ctx) =>
			createSessionSearchTool({
				channelId: ctx.channelId,
				channelDir: ctx.channelDir,
				getCurrentModel: req(ctx.getCurrentModel, "getCurrentModel"),
				resolveApiKey: req(ctx.resolveApiKey, "resolveApiKey"),
				getSessionSearchSettings: req(ctx.getSessionSearchSettings, "getSessionSearchSettings"),
			}),
	},
	// Spec 047, P4: one tool per payload shape. All three share the same build options.
	{
		name: "memory_save",
		create: (ctx) => createMemorySaveTool(memoryToolOptions(ctx)),
	},
	{
		name: "memory_search",
		create: (ctx) => createMemorySearchTool(memoryToolOptions(ctx)),
	},
	{
		name: "memory_forget",
		create: (ctx) => createMemoryForgetTool(memoryToolOptions(ctx)),
	},
	{
		name: "skill",
		create: (ctx) => createSkillTool({ workspaceDir: ctx.workspaceDir, ...fileToolOptions(ctx) }),
	},
	{
		name: "event_manage",
		create: (ctx) =>
			createEventManageTool({
				workspaceDir: ctx.workspaceDir,
				channelId: ctx.channelId,
				commandGuardConfig: ctx.securityConfig.commandGuard,
			}),
	},
	// tools.tasks is the master switch for the whole autonomous long-running task mechanism;
	// the TaskDriver and per-turn task digest honor the same flag. Five tools, one per payload
	// shape (spec 046, D3.1) — all share it, since none is meaningful without the others.
	{
		name: "task_list",
		enabledBy: (ctx) => ctx.toolsConfig?.tools.tasks.enabled !== false,
		create: (ctx) => createTaskListTool(taskToolOptions(ctx)),
	},
	{
		name: "task_create",
		enabledBy: (ctx) => ctx.toolsConfig?.tools.tasks.enabled !== false,
		create: (ctx) => createTaskCreateTool(taskToolOptions(ctx)),
	},
	{
		name: "task_update",
		enabledBy: (ctx) => ctx.toolsConfig?.tools.tasks.enabled !== false,
		create: (ctx) => createTaskUpdateTool(taskToolOptions(ctx)),
	},
	{
		name: "task_close",
		enabledBy: (ctx) => ctx.toolsConfig?.tools.tasks.enabled !== false,
		create: (ctx) => createTaskCloseTool(taskToolOptions(ctx)),
	},
	{
		name: "task_log",
		enabledBy: (ctx) => ctx.toolsConfig?.tools.tasks.enabled !== false,
		create: (ctx) => createTaskLogTool(taskToolOptions(ctx)),
	},
	{
		name: "task_step_end",
		// Only inside a task session: it is the loop's closing move, not a chat action.
		enabledBy: (ctx) => ctx.toolsConfig?.tools.tasks.enabled !== false && ctx.taskLoop !== undefined,
		create: (ctx) =>
			createTaskStepEndTool({
				...taskToolOptions(ctx),
				taskId: ctx.taskLoop?.taskId,
				cycleId: ctx.taskLoop?.cycleId,
				getToolsUsed: ctx.getToolsUsed,
			}),
	},
	{
		name: "job",
		// Present only when a job manager was supplied (always on the main path,
		// never for sub-agents).
		enabledBy: (ctx) => ctx.jobManager !== undefined,
		create: (ctx) => createJobTool({ jobManager: req(ctx.jobManager, "jobManager") }),
	},
];

/**
 * Every tool name a tool set can contain: the registry plus `subagent`, which is registered
 * outside it. Used to validate authored references to tools (playbook `requires-tools`), so a
 * typo fails loudly instead of silently dropping the playbook from the catalog.
 *
 * This deliberately carries no per-tool prose. Tool name, description and parameter schema
 * already reach the model with every request; spec 026 §3.2 removed the `## Available Tools`
 * prompt section because repeating a hint for each tool cost ~180 prompt units per turn and
 * added no capability. Guidance on *when* to prefer a tool belongs in that tool's own
 * `description` (see `grep`, which tells the model to prefer it over `bash grep -rn`).
 */
export const TOOL_NAMES: ReadonlySet<string> = new Set<string>([
	...TOOL_REGISTRY.map((registration) => registration.name),
	"subagent",
	"subagent_inline",
	"subagent_list",
	"subagent_run",
]);

export interface BuildToolSetOptions {
	/** When true, include only tools in the sub-agent whitelist. */
	forSubagent?: boolean;
}

/**
 * Build a tool set from the registry, honoring sub-agent availability and config gates.
 *
 * Every tool is bound to the `details` contract here rather than in its own factory: the
 * registration name is stamped as `details.kind`, and a `RecoverableToolError` becomes a
 * normal result the model can act on. Doing it at this single seam means a new tool conforms
 * without its author having to remember, and `kind` can never disagree with the name.
 */
export function buildToolSet(ctx: ToolBuildContext, options: BuildToolSetOptions = {}): AgentTool<any>[] {
	const result: AgentTool<any>[] = [];
	for (const registration of TOOL_REGISTRY) {
		if (options.forSubagent && !SUBAGENT_TOOL_NAMES.some((name) => name === registration.name)) {
			continue;
		}
		if (registration.enabledBy && !registration.enabledBy(ctx)) {
			continue;
		}
		result.push(
			withToolDetails(registration.create({ ...ctx, forSubagent: options.forSubagent }), registration.name),
		);
	}
	return result;
}
