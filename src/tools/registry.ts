import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { MemoryCandidateStore } from "../memory/candidates.js";
import type { Executor } from "../sandbox.js";
import type { SecurityConfig, SecurityRuntimeContext } from "../security/types.js";
import type { PipiclawSessionSearchSettings } from "../settings.js";
import { createBashTool } from "./bash.js";
import type { PipiclawToolsConfig, PipiclawWebToolsConfig } from "./config.js";
import { createEditTool } from "./edit.js";
import { createEventManageTool } from "./event-manage.js";
import { createGrepTool } from "./grep.js";
import { createMemoryManageTool } from "./memory-manage.js";
import { createReadTool } from "./read.js";
import { createSessionSearchTool } from "./session-search.js";
import { createSkillListTool } from "./skill-list.js";
import { createSkillManageTool } from "./skill-manage.js";
import { createSkillViewTool } from "./skill-view.js";
import { createTaskManageTool } from "./task-manage.js";
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
	securityConfig: SecurityConfig;
	securityContext: SecurityRuntimeContext;
	channelId: string;
	channelDir: string;
	workspaceDir: string;
	workspacePath: string;
	/** Main set: `toolsConfig.tools.web`; sub-agent set: the sub-agent's own webConfig. */
	webConfig?: PipiclawWebToolsConfig;
	/** Present only on the main path; gates session_search / memory_manage / skills. */
	toolsConfig?: PipiclawToolsConfig;
	/** Sub-agent set passes its per-invocation bash timeout; the main set relies on the built-in default. */
	bashDefaultTimeoutSeconds?: number;
	/** Gates the bash tool's rtk command optimizer (`tools.rtk.enabled`). Threaded to both sets. */
	rtkEnabled?: boolean;
	getCurrentModel?: () => Model<Api>;
	getAvailableModels?: () => Model<Api>[];
	resolveApiKey?: (model: Model<Api>) => Promise<string>;
	getSessionSearchSettings?: () => PipiclawSessionSearchSettings;
	memoryCandidateStore?: MemoryCandidateStore;
}

export interface ToolRegistration {
	name: string;
	/** One-line hint rendered in the system prompt's `## Tools` section. */
	promptHint: string;
	/** Whether this tool is included in a sub-agent's tool set. */
	availableToSubagents: boolean;
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
		promptHint: "Read files",
		availableToSubagents: true,
		create: (ctx) => createReadTool(ctx.executor, fileToolOptions(ctx)),
	},
	{
		name: "bash",
		promptHint: "Run shell commands and external programs",
		availableToSubagents: true,
		create: (ctx) =>
			createBashTool(ctx.executor, {
				...fileToolOptions(ctx),
				rtkEnabled: ctx.rtkEnabled === true,
				...(ctx.bashDefaultTimeoutSeconds !== undefined
					? { defaultTimeoutSeconds: ctx.bashDefaultTimeoutSeconds }
					: {}),
			}),
	},
	{
		name: "edit",
		promptHint: "Surgical file edits",
		availableToSubagents: true,
		create: (ctx) => createEditTool(ctx.executor, fileToolOptions(ctx)),
	},
	{
		name: "grep",
		promptHint: "Search file contents with a regex; grouped, paginated, token-bounded — prefer over bash grep",
		availableToSubagents: true,
		enabledBy: (ctx) => ctx.toolsConfig?.tools.grep.enabled !== false,
		create: (ctx) => createGrepTool(ctx.executor, fileToolOptions(ctx)),
	},
	{
		name: "write",
		promptHint: "Create or overwrite files when needed",
		availableToSubagents: true,
		create: (ctx) => createWriteTool(ctx.executor, fileToolOptions(ctx)),
	},
	{
		name: "web_search",
		promptHint: "Search the public web and return titles, URLs, and snippets",
		availableToSubagents: true,
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
		promptHint: "Fetch a public URL and extract readable content",
		availableToSubagents: true,
		enabledBy: webEnabled,
		create: (ctx) =>
			createWebFetchTool({
				webConfig: req(ctx.webConfig, "webConfig"),
				securityConfig: ctx.securityConfig,
				workspaceDir: ctx.workspaceDir,
				channelId: ctx.channelId,
			}),
	},
	{
		name: "session_search",
		promptHint: "Search current-channel cold transcript storage for older conversation details",
		availableToSubagents: false,
		enabledBy: (ctx) => ctx.toolsConfig?.tools.memory.sessionSearch.enabled !== false,
		create: (ctx) =>
			createSessionSearchTool({
				channelId: ctx.channelId,
				channelDir: ctx.channelDir,
				getCurrentModel: req(ctx.getCurrentModel, "getCurrentModel"),
				resolveApiKey: req(ctx.resolveApiKey, "resolveApiKey"),
				getSessionSearchSettings: req(ctx.getSessionSearchSettings, "getSessionSearchSettings"),
			}),
	},
	{
		name: "memory_manage",
		promptHint: "Save a durable fact, search stored memory on demand, or forget an entry — when the user asks",
		availableToSubagents: false,
		enabledBy: (ctx) => ctx.toolsConfig?.tools.memory.save.enabled !== false,
		create: (ctx) =>
			createMemoryManageTool({
				channelId: ctx.channelId,
				channelDir: ctx.channelDir,
				workspaceDir: ctx.workspaceDir,
				memoryCandidateStore: req(ctx.memoryCandidateStore, "memoryCandidateStore"),
				getCurrentModel: req(ctx.getCurrentModel, "getCurrentModel"),
				resolveApiKey: req(ctx.resolveApiKey, "resolveApiKey"),
			}),
	},
	{
		name: "skill_list",
		promptHint: "List workspace-level procedural memory in skills/",
		availableToSubagents: false,
		enabledBy: (ctx) => ctx.toolsConfig?.tools.skills.manage.enabled !== false,
		create: (ctx) => createSkillListTool({ workspaceDir: ctx.workspaceDir, workspacePath: ctx.workspacePath }),
	},
	{
		name: "skill_view",
		promptHint: "Inspect a workspace-level skill's contents",
		availableToSubagents: false,
		enabledBy: (ctx) => ctx.toolsConfig?.tools.skills.manage.enabled !== false,
		create: (ctx) => createSkillViewTool({ workspaceDir: ctx.workspaceDir, workspacePath: ctx.workspacePath }),
	},
	{
		name: "skill_manage",
		promptHint: "Create or maintain workspace-level procedural memory in skills/",
		availableToSubagents: false,
		enabledBy: (ctx) => ctx.toolsConfig?.tools.skills.manage.enabled !== false,
		create: (ctx) => createSkillManageTool({ workspaceDir: ctx.workspaceDir, workspacePath: ctx.workspacePath }),
	},
	{
		name: "event_manage",
		promptHint:
			"Schedule your own follow-ups: create/update/delete one-shot check-ins and periodic cadences for this channel. " +
			"Name task-owned events `task.<channelId>.<taskId>.<use>` (e.g. .checkin, .schedule) so they clean up together. " +
			"Keep a task's `wake` and its .checkin one-shot in sync — move both, clear both. " +
			"No immediate events; periodic no more often than every 30 min (or 5 min when it carries a preAction gate).",
		availableToSubagents: false,
		enabledBy: (ctx) => ctx.toolsConfig?.tools.events.enabled !== false,
		create: (ctx) =>
			createEventManageTool({
				workspaceDir: ctx.workspaceDir,
				workspacePath: ctx.workspacePath,
				channelId: ctx.channelId,
				commandGuardConfig: ctx.securityConfig.commandGuard,
			}),
	},
	{
		name: "task_manage",
		promptHint:
			"Update the task ledger: set a task's status/wake/recurrence, close a task out (archives one-shot tasks and " +
			"cleans up its residual events), or list active tasks. Write the task body with write/edit; this owns the frontmatter.",
		availableToSubagents: false,
		enabledBy: (ctx) => ctx.toolsConfig?.tools.tasks.enabled !== false,
		create: (ctx) =>
			createTaskManageTool({
				workspaceDir: ctx.workspaceDir,
				workspacePath: ctx.workspacePath,
				channelDir: ctx.channelDir,
				channelId: ctx.channelId,
			}),
	},
];

/** Prompt hint for the `subagent` tool, which is registered outside TOOL_REGISTRY. */
export const SUBAGENT_TOOL_HINT = "Delegate a focused task to a sub-agent with its own isolated context";

/** Single source of truth for prompt hints, keyed by tool name (leaf tools + subagent). */
export const TOOL_PROMPT_HINTS: Record<string, string> = {
	...Object.fromEntries(TOOL_REGISTRY.map((registration) => [registration.name, registration.promptHint])),
	subagent: SUBAGENT_TOOL_HINT,
};

export interface BuildToolSetOptions {
	/** When true, include only tools flagged `availableToSubagents`. */
	forSubagent?: boolean;
}

/** Build a tool set from the registry, honoring sub-agent availability and config gates. */
export function buildToolSet(ctx: ToolBuildContext, options: BuildToolSetOptions = {}): AgentTool<any>[] {
	const result: AgentTool<any>[] = [];
	for (const registration of TOOL_REGISTRY) {
		if (options.forSubagent && !registration.availableToSubagents) {
			continue;
		}
		if (registration.enabledBy && !registration.enabledBy(ctx)) {
			continue;
		}
		result.push(registration.create(ctx));
	}
	return result;
}
