import { mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { MemoryCandidateStore } from "../memory/candidates.js";
import {
	getChannelHistoryPath,
	getChannelMemoryPath,
	getChannelSessionPath,
	readChannelSession,
} from "../memory/files.js";
import { recallRelevantMemory } from "../memory/recall.js";
import { formatModelReference } from "../models/utils.js";
import type { ExecOptions, ExecResult, Executor } from "../sandbox.js";
import { DEFAULT_SECURITY_CONFIG } from "../security/config.js";
import type { SecurityConfig } from "../security/types.js";
import type { PipiclawMemoryRecallSettings } from "../settings.js";
import { splitH1Sections } from "../shared/markdown-sections.js";
import { shellEscape } from "../shared/shell-escape.js";
import { clipText, errorMessage, extractAssistantText, extractLabelFromArgs } from "../shared/text-utils.js";
import type { UsageTotals } from "../shared/types.js";
import { workspaceSubjectHash } from "../tasks/artifact-subject.js";
import { applyTaskControlPatch } from "../tasks/control.js";
import { readStoredTask, updateStoredTask } from "../tasks/store.js";
import { parseVerificationVerdict, writeVerificationAttestation } from "../tasks/verification.js";
import type { PipiclawWebToolsConfig } from "../tools/config.js";
import { buildToolSet } from "../tools/registry.js";
import {
	formatSubAgentList,
	type ResolvedSubAgentConfig,
	resolveSubAgentConfig,
	type SubAgentConfig,
	type SubAgentDiscoveryResult,
	validateSubAgentTask,
} from "./discovery.js";

const subagentSchema = Type.Object({
	label: Type.String({ description: "Brief description of what this sub-agent task does (shown to user)" }),
	agent: Type.Optional(Type.String({ description: "Name of a predefined sub-agent from workspaceDir/sub-agents/" })),
	name: Type.Optional(Type.String({ description: "Optional display name for an inline sub-agent" })),
	task: Type.String({ description: "Complete task description for the sub-agent" }),
	systemPrompt: Type.Optional(
		Type.String({
			description: "Optional inline system prompt for a temporary sub-agent. Use when no predefined agent fits.",
		}),
	),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Optional tool whitelist for the sub-agent" })),
	model: Type.Optional(
		Type.String({ description: "Optional exact model reference. Defaults to the parent's current model." }),
	),
	maxTurns: Type.Optional(Type.Number({ description: "Optional maximum assistant turns for this sub-agent" })),
	maxToolCalls: Type.Optional(Type.Number({ description: "Optional maximum tool calls for this sub-agent" })),
	maxWallTimeSec: Type.Optional(
		Type.Number({ description: "Optional wall time budget in seconds for this sub-agent" }),
	),
	bashTimeoutSec: Type.Optional(
		Type.Number({ description: "Optional default timeout in seconds for bash commands inside this sub-agent" }),
	),
	contextMode: Type.Optional(
		Type.Union([Type.Literal("isolated"), Type.Literal("contextual")], {
			description:
				'Optional context mode. "isolated" (default) runs with no injected context; "contextual" injects selected session and memory context.',
		}),
	),
	memory: Type.Optional(
		Type.Union([Type.Literal("none"), Type.Literal("session"), Type.Literal("relevant")], {
			description: 'Optional memory mode for contextual sub-agents: "none", "session", or "relevant".',
		}),
	),
	paths: Type.Optional(
		Type.Array(Type.String(), {
			description: "Optional preferred file or directory paths for the sub-agent to focus on.",
		}),
	),
	purpose: Type.Optional(
		Type.Union([Type.Literal("work"), Type.Literal("verify")], {
			description: 'Use "verify" for an independent, read-only task acceptance check.',
		}),
	),
	taskId: Type.Optional(Type.String({ description: "Persistent task id, required when purpose=verify." })),
	isolation: Type.Optional(
		Type.Union([Type.Literal("shared"), Type.Literal("worktree")], {
			description: '"worktree" runs in a dedicated git worktree (host sandbox only).',
		}),
	),
	worktreePath: Type.Optional(
		Type.String({ description: "Reuse an existing task-owned worktree; must be under channel tasks/worktrees/." }),
	),
});

export interface SubAgentToolDetails {
	kind: "subagent";
	agent: string;
	source: "predefined" | "inline";
	model: string;
	tools: string[];
	turns: number;
	toolCalls: number;
	durationMs: number;
	failed: boolean;
	failureReason?: string;
	usage: UsageTotals;
	runId: string;
	purpose: "work" | "verify";
	taskId?: string;
	isolation: "shared" | "worktree";
	worktreePath?: string;
	worktreeBranch?: string;
	verificationVerdict?: "pass" | "fail";
}

export interface SubAgentToolOptions {
	executor: Executor;
	/** Host checkout used as the shared cwd and worktree source. Defaults to process.cwd(). */
	workingDirectory?: string;
	getCurrentModel: () => Model<Api>;
	getAvailableModels: () => Model<Api>[];
	resolveApiKey: (model: Model<Api>) => Promise<string>;
	workspaceDir: string;
	channelDir: string;
	getSubAgentDiscovery?: () => SubAgentDiscoveryResult;
	getMemoryRecallSettings?: () => PipiclawMemoryRecallSettings;
	memoryCandidateStore?: MemoryCandidateStore;
	securityConfig?: SecurityConfig;
	webConfig?: PipiclawWebToolsConfig;
	rtkEnabled?: boolean;
	runtimeContext: {
		workspacePath: string;
		channelId: string;
		sandbox: string;
	};
	createWorker?: (config: {
		subAgent: ResolvedSubAgentConfig;
		apiKey: string;
		tools: AgentTool<any>[];
	}) => SubAgentWorker;
}

interface SubAgentWorker {
	state: { messages: AgentMessage[] };
	subscribe(listener: (event: AgentEvent) => void): () => void;
	abort(): void;
	prompt(input: string): Promise<void>;
	waitForIdle(): Promise<void>;
}

const DEFAULT_SUBAGENT_MEMORY_RECALL_SETTINGS: PipiclawMemoryRecallSettings = {
	enabled: true,
	maxCandidates: 12,
	maxInjected: 5,
	maxChars: 5000,
	rerankWithModel: true,
};
const SESSION_SECTION_ORDER = ["Current State", "User Intent", "Active Files", "Errors & Corrections", "Next Steps"];
const MAX_SESSION_SECTION_CHARS = 280;
const MAX_SESSION_CONTEXT_CHARS = 1800;
const MAX_RECALL_CONTEXT_CHARS = 2200;
const TASK_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

interface SubAgentRunContext {
	runId: string;
	purpose: "work" | "verify";
	taskId?: string;
	isolation: "shared" | "worktree";
	workingDirectory: string;
	worktreePath?: string;
	worktreeBranch?: string;
}

class DirectoryExecutor implements Executor {
	constructor(
		private readonly base: Executor,
		private readonly directory: string,
	) {}

	exec(command: string, options?: ExecOptions): Promise<ExecResult> {
		return this.base.exec(`cd ${shellEscape(this.directory)} && ${command}`, options);
	}

	getWorkspacePath(hostPath: string): string {
		return this.base.getWorkspacePath(hostPath);
	}
}

function safeRunSegment(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 48) || "run";
}

function safeGitBranchSegment(value: string): string {
	return (
		value
			.replace(/[^A-Za-z0-9_-]/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 48) || "run"
	);
}

async function prepareRunContext(
	runId: string,
	params: { purpose?: "work" | "verify"; taskId?: string; isolation?: "shared" | "worktree"; worktreePath?: string },
	options: SubAgentToolOptions,
): Promise<SubAgentRunContext> {
	const purpose = params.purpose ?? "work";
	const taskId = params.taskId?.trim() || undefined;
	if (purpose === "verify" && !taskId) throw new Error("purpose=verify requires taskId.");
	if (taskId && !TASK_ID_PATTERN.test(taskId)) throw new Error(`Invalid taskId: ${taskId}`);
	const ownedTask = taskId ? await readStoredTask(options.channelDir, taskId) : undefined;
	if (taskId && !ownedTask) {
		throw new Error(`Task ${taskId} does not exist. Create it with task_manage before delegating task-owned work.`);
	}
	const isolation = params.isolation ?? "shared";
	if (isolation === "shared") {
		if (params.worktreePath) throw new Error("worktreePath requires isolation=worktree.");
		const workingDirectory =
			options.runtimeContext.sandbox === "host"
				? resolve(options.workingDirectory ?? process.cwd())
				: options.runtimeContext.workspacePath;
		return { runId, purpose, taskId, isolation, workingDirectory };
	}
	if (options.runtimeContext.sandbox !== "host") {
		throw new Error(
			"Git worktree isolation currently requires the host sandbox. Use isolation=shared, or run this task in host mode.",
		);
	}
	if (!taskId) throw new Error("isolation=worktree requires taskId so the worktree has a durable owner.");
	if (!ownedTask?.fields.control) {
		throw new Error(`Task ${taskId} has no governed control metadata. Normalize it with task_manage set first.`);
	}

	const baseDir = resolve(options.channelDir, "tasks", "worktrees");
	await mkdir(baseDir, { recursive: true });
	if (params.worktreePath) {
		const existing = resolve(params.worktreePath);
		const rel = relative(baseDir, existing);
		if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
			throw new Error(`worktreePath must be inside ${baseDir}.`);
		}
		const check = await options.executor.exec(`git -C ${shellEscape(existing)} rev-parse --is-inside-work-tree`);
		if (check.code !== 0 || check.stdout.trim() !== "true") {
			throw new Error(`worktreePath is not a usable git worktree: ${existing}`);
		}
		const branchResult = await options.executor.exec(`git -C ${shellEscape(existing)} branch --show-current`);
		const context: SubAgentRunContext = {
			runId,
			purpose,
			taskId,
			isolation,
			workingDirectory: existing,
			worktreePath: existing,
			worktreeBranch: branchResult.code === 0 ? branchResult.stdout.trim() || undefined : undefined,
		};
		await recordTaskWorktree(options.channelDir, taskId, context);
		return context;
	}

	const sourceDirectory = resolve(options.workingDirectory ?? process.cwd());
	const rootResult = await options.executor.exec(`git -C ${shellEscape(sourceDirectory)} rev-parse --show-toplevel`);
	if (rootResult.code !== 0 || !rootResult.stdout.trim()) {
		throw new Error(
			"Cannot create an isolated worktree: the current working directory is not inside a git repository.",
		);
	}
	const repoRoot = rootResult.stdout.trim();
	const runSegment = safeRunSegment(runId).slice(-16);
	const taskSegment = safeRunSegment(taskId);
	const path = join(baseDir, taskSegment, runSegment);
	const branch = `pipiclaw-task/${safeGitBranchSegment(taskId)}/${safeGitBranchSegment(runId).slice(-16)}`;
	await mkdir(join(baseDir, taskSegment), { recursive: true });
	const created = await options.executor.exec(
		`git -C ${shellEscape(repoRoot)} worktree add -b ${shellEscape(branch)} ${shellEscape(path)} HEAD`,
		{ timeout: 60 },
	);
	if (created.code !== 0) {
		throw new Error(
			`Could not create git worktree for task ${taskId}: ${created.stderr || created.stdout}. Remove the stale worktree/branch or use isolation=shared.`,
		);
	}
	const context: SubAgentRunContext = {
		runId,
		purpose,
		taskId,
		isolation,
		workingDirectory: path,
		worktreePath: path,
		worktreeBranch: branch,
	};
	try {
		await recordTaskWorktree(options.channelDir, taskId, context);
	} catch (error) {
		await options.executor.exec(`git -C ${shellEscape(repoRoot)} worktree remove --force ${shellEscape(path)}`);
		await options.executor.exec(`git -C ${shellEscape(repoRoot)} branch -D ${shellEscape(branch)}`);
		throw new Error(
			`Created the worktree but could not record its ownership on task ${taskId}; the temporary worktree was removed. ${errorMessage(error)}`,
		);
	}
	return context;
}

async function recordTaskWorktree(channelDir: string, taskId: string, context: SubAgentRunContext): Promise<void> {
	await updateStoredTask(channelDir, taskId, (task) => {
		if (!task.fields.control || !context.worktreePath) return;
		task.fields.control = applyTaskControlPatch(task.fields.control, {
			isolation: "worktree",
			worktreePath: context.worktreePath,
			worktreeBranch: context.worktreeBranch,
		});
	});
}

async function gitWorkspaceState(executor: Executor): Promise<string | undefined> {
	const result = await executor.exec("git status --porcelain=v1 --untracked-files=all", { timeout: 30 });
	return result.code === 0 ? result.stdout : undefined;
}

function createEmptyUsageTotals(): UsageTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return typeof message === "object" && message !== null && "role" in message && message.role === "assistant";
}

function getLastAssistantMessage(messages: AgentMessage[]): AssistantMessage | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (isAssistantMessage(message)) {
			return message;
		}
	}
	return null;
}

function formatStatus(agentName: string, text: string): string {
	return `Subagent ${agentName}: ${text}`;
}

function buildFailureText(config: SubAgentConfig, reason: string, lastAssistantText: string): string {
	const trimmedLastText = lastAssistantText.trim();
	if (!trimmedLastText) {
		return `Sub-agent ${config.name} failed: ${reason}`;
	}
	return `Sub-agent ${config.name} failed: ${reason}\n\nLast output:\n${trimmedLastText}`;
}

function buildStoppedText(config: SubAgentConfig, reason: string, finalText: string): string {
	const trimmedFinalText = finalText.trim();
	if (!trimmedFinalText) {
		return `Sub-agent ${config.name} stopped: ${reason}`;
	}
	return `[Sub-agent ${config.name} stopped: ${reason}]\n\n${trimmedFinalText}`;
}

/**
 * Sub-agents share the main agent's `write`/`edit` tools but only receive the runtime
 * context (task text), never the "don't touch MEMORY.md/HISTORY.md/SESSION.md, use
 * memory_manage instead" rule the main agent gets in its system prompt (memory_manage
 * itself is withheld from sub-agents). Denying these paths at the path-guard level closes
 * that gap structurally instead of relying on a sub-agent to infer an instruction it never
 * received — a stray write/edit here would race the shared memory serial queue
 * (channel-maintenance-queue) and silently corrupt durable memory.
 */
function withSubagentMemoryWriteDeny(securityConfig: SecurityConfig, channelDir: string): SecurityConfig {
	const protectedPaths = [
		getChannelMemoryPath(channelDir),
		getChannelHistoryPath(channelDir),
		getChannelSessionPath(channelDir),
	];
	return {
		...securityConfig,
		pathGuard: {
			...securityConfig.pathGuard,
			writeDeny: [...securityConfig.pathGuard.writeDeny, ...protectedPaths],
		},
	};
}

/**
 * Build a sub-agent's tool set from the shared tool registry, filtered to tools flagged
 * available to sub-agents (files + web). Sub-agents run with their own security context
 * (rooted at the sub-agent workspace) and their own per-invocation bash timeout.
 */
function buildSubagentTools(
	executor: Executor,
	bashTimeoutSec: number,
	options: SubAgentToolOptions,
	runContext: SubAgentRunContext,
): AgentTool<any>[] {
	const securityConfig = withSubagentMemoryWriteDeny(
		options.securityConfig ?? DEFAULT_SECURITY_CONFIG,
		options.channelDir,
	);
	return buildToolSet(
		{
			executor,
			securityConfig,
			securityContext: {
				workspaceDir: options.workspaceDir,
				workspacePath: options.runtimeContext.workspacePath,
				cwd: runContext.workingDirectory,
			},
			channelId: options.runtimeContext.channelId,
			channelDir: options.channelDir,
			workspaceDir: options.workspaceDir,
			workspacePath: options.runtimeContext.workspacePath,
			webConfig: options.webConfig,
			rtkEnabled: options.rtkEnabled,
			bashDefaultTimeoutSeconds: bashTimeoutSec,
		},
		{ forSubagent: true },
	).filter((tool) => runContext.purpose !== "verify" || (tool.name !== "write" && tool.name !== "edit"));
}

function buildSubAgentTask(
	task: string,
	config: ResolvedSubAgentConfig,
	runtimeContext: SubAgentToolOptions["runtimeContext"],
	contextBlocks: string[],
	runContext: SubAgentRunContext,
): string {
	const taskText = task.trim();
	const lines = [
		`Runtime context:`,
		`- Workspace root: ${runtimeContext.workspacePath}`,
		`- Channel id: ${runtimeContext.channelId}`,
		`- Channel directory: ${runtimeContext.workspacePath}/${runtimeContext.channelId}`,
		`- Sandbox: ${runtimeContext.sandbox}`,
		`- Working directory: ${runContext.workingDirectory}`,
		`- Filesystem isolation: ${runContext.isolation === "worktree" ? "dedicated git worktree" : "shared with parent"}`,
		`- Your configured role: ${config.name}`,
	];

	for (const block of contextBlocks) {
		if (!block.trim()) {
			continue;
		}
		lines.push("", block.trim());
	}

	lines.push("", `Task:`, taskText);
	if (runContext.purpose === "verify") {
		const taskPath = join(runtimeContext.workspacePath, runtimeContext.channelId, "tasks", `${runContext.taskId}.md`);
		lines.push(
			"",
			"Verification protocol:",
			`- Independently inspect ${taskPath} and verify every DoD/Verification item against concrete evidence.`,
			"- You are the checker, not the maker. Do not edit files or fix failures; report them.",
			"- Run deterministic checks when available and distinguish observed evidence from assumptions.",
			"- End the response with exactly one final line: VERDICT: PASS or VERDICT: FAIL.",
		);
	}
	return lines.join("\n");
}

function buildSessionContextBlock(sessionMarkdown: string): string {
	const sections = splitH1Sections(sessionMarkdown);
	if (sections.length === 0) {
		return "";
	}

	const selectedSections = SESSION_SECTION_ORDER.flatMap((heading) =>
		sections.filter((section) => section.heading.toLowerCase() === heading.toLowerCase()),
	);

	if (selectedSections.length === 0) {
		return "";
	}

	const lines = ["Relevant session state:"];
	let usedChars = lines[0].length;
	for (const section of selectedSections) {
		const clipped = clipText(section.content, MAX_SESSION_SECTION_CHARS, { headRatio: 1, omitHint: "..." });
		const block = `- ${section.heading}: ${clipped}`;
		if (usedChars + block.length > MAX_SESSION_CONTEXT_CHARS) {
			break;
		}
		lines.push(block);
		usedChars += block.length + 1;
	}
	return lines.length > 1 ? lines.join("\n") : "";
}

function stripRuntimeContextWrapper(renderedText: string): string {
	return renderedText
		.replace(/^<runtime_context>\s*/i, "")
		.replace(/\s*<\/runtime_context>$/i, "")
		.trim();
}

async function buildContextualBlocks(
	task: string,
	config: ResolvedSubAgentConfig,
	options: SubAgentToolOptions,
	currentModel: Model<Api>,
): Promise<string[]> {
	if (config.contextMode !== "contextual") {
		return [];
	}

	const blocks: string[] = [];
	if (config.paths.length > 0) {
		blocks.push(`Preferred focus paths:\n${config.paths.map((path) => `- ${path}`).join("\n")}`);
	}

	if (config.memory === "none") {
		return blocks;
	}

	const sessionMarkdown = await readChannelSession(options.channelDir);
	const sessionBlock = buildSessionContextBlock(sessionMarkdown);
	if (sessionBlock) {
		blocks.push(sessionBlock);
	}

	if (config.memory !== "relevant") {
		return blocks;
	}

	const recallSettings = {
		...DEFAULT_SUBAGENT_MEMORY_RECALL_SETTINGS,
		...options.getMemoryRecallSettings?.(),
	};
	if (!recallSettings.enabled) {
		return blocks;
	}

	const recallQuery = [task.trim(), config.description.trim(), ...config.paths].filter(Boolean).join("\n");
	const recalled = await recallRelevantMemory({
		query: recallQuery,
		channelId: options.runtimeContext.channelId,
		workspaceDir: options.workspaceDir,
		channelDir: options.channelDir,
		maxCandidates: recallSettings.maxCandidates,
		maxInjected: recallSettings.maxInjected,
		maxChars: Math.min(recallSettings.maxChars, MAX_RECALL_CONTEXT_CHARS),
		rerankWithModel: recallSettings.rerankWithModel,
		model: currentModel,
		resolveApiKey: options.resolveApiKey,
		allowedSources: ["workspace-memory", "channel-memory", "channel-history"],
		candidateStore: options.memoryCandidateStore,
	});
	const recalledText = stripRuntimeContextWrapper(recalled.renderedText);
	if (recalledText) {
		blocks.push(recalledText);
	}

	return blocks;
}

function filterToolsByName(allTools: AgentTool<any>[], names: string[]): AgentTool<any>[] {
	const allowed = new Set(names);
	return allTools.filter((tool) => allowed.has(tool.name));
}

function createDetails(
	config: ResolvedSubAgentConfig,
	runContext: SubAgentRunContext,
	usage: UsageTotals,
	turns: number,
	toolCalls: number,
	durationMs: number,
	failed: boolean,
	failureReason?: string,
	verificationVerdict?: "pass" | "fail",
): SubAgentToolDetails {
	return {
		kind: "subagent",
		agent: config.name,
		source: config.source,
		model: formatModelReference(config.model),
		tools: [...config.tools],
		turns,
		toolCalls,
		durationMs,
		failed,
		failureReason,
		usage: {
			...usage,
			cost: { ...usage.cost },
		},
		runId: runContext.runId,
		purpose: runContext.purpose,
		taskId: runContext.taskId,
		isolation: runContext.isolation,
		worktreePath: runContext.worktreePath,
		worktreeBranch: runContext.worktreeBranch,
		verificationVerdict,
	};
}

function linkAbortSignals(parentSignal: AbortSignal | undefined, childController: AbortController): () => void {
	if (!parentSignal) {
		return () => {};
	}

	const abortChild = () => childController.abort(parentSignal.reason);
	if (parentSignal.aborted) {
		abortChild();
		return () => {};
	}

	parentSignal.addEventListener("abort", abortChild, { once: true });
	return () => parentSignal.removeEventListener("abort", abortChild);
}

export function createSubAgentTool(
	options: SubAgentToolOptions,
): AgentTool<typeof subagentSchema, SubAgentToolDetails> {
	return {
		name: "subagent",
		label: "subagent",
		description:
			"Delegate a task to a sub-agent with an isolated context. You may use a predefined sub-agent from workspaceDir/sub-agents/ or define a temporary inline sub-agent by providing systemPrompt/tools/model parameters. Sub-agents never receive the subagent tool, so they cannot create nested agents.",
		parameters: subagentSchema,
		execute: async (_toolCallId, params, signal, onUpdate) => {
			const availableModels = options.getAvailableModels();
			const discovery = options.getSubAgentDiscovery?.() ?? {
				directory: `${options.workspaceDir}/sub-agents`,
				agents: [],
				warnings: [],
			};
			const currentModel = options.getCurrentModel();
			const taskLengthError = validateSubAgentTask(params.task);
			if (taskLengthError) {
				throw new Error(taskLengthError);
			}
			const invocation = resolveSubAgentConfig(availableModels, currentModel, discovery.agents, params);
			if (!invocation.config) {
				throw new Error(
					`${invocation.error}\n\nAvailable predefined sub-agents:\n${formatSubAgentList(discovery.agents)}`,
				);
			}

			const config = invocation.config;
			const runContext = await prepareRunContext(_toolCallId, params, options);
			const scopedExecutor = new DirectoryExecutor(options.executor, runContext.workingDirectory);
			const apiKey = await options.resolveApiKey(config.model);
			const startedAt = Date.now();
			const usage = createEmptyUsageTotals();
			let assistantTurns = 0;
			let toolCalls = 0;
			let failureReason: string | undefined;
			let lastUpdateText = "";

			const emitUpdate = (text: string) => {
				const nextText = text.trim();
				if (!nextText || nextText === lastUpdateText) {
					return;
				}
				lastUpdateText = nextText;
				onUpdate?.({
					content: [{ type: "text", text: nextText }],
					details: createDetails(
						config,
						runContext,
						usage,
						assistantTurns,
						toolCalls,
						Date.now() - startedAt,
						Boolean(failureReason),
						failureReason,
					),
				});
			};

			const availableTools = buildSubagentTools(scopedExecutor, config.bashTimeoutSec, options, runContext);
			const verifierGitStateBefore =
				runContext.purpose === "verify" ? await gitWorkspaceState(scopedExecutor) : undefined;
			const verifierSubjectBefore =
				runContext.purpose === "verify" && options.runtimeContext.sandbox === "host"
					? await workspaceSubjectHash(runContext.workingDirectory)
					: undefined;

			const worker =
				options.createWorker?.({
					subAgent: config,
					apiKey,
					tools: filterToolsByName(availableTools, config.tools),
				}) ??
				new Agent({
					initialState: {
						systemPrompt: config.systemPrompt,
						model: config.model,
						thinkingLevel: "off",
						tools: filterToolsByName(availableTools, config.tools),
					},
					convertToLlm,
					getApiKey: async () => apiKey,
				});

			const childController = new AbortController();
			const unlinkAbortSignals = linkAbortSignals(signal, childController);
			const wallClockTimer = setTimeout(() => {
				failureReason = `Wall time budget exceeded (${config.maxWallTimeSec}s)`;
				worker.abort();
			}, config.maxWallTimeSec * 1000);

			const unsubscribe = worker.subscribe((event: AgentEvent) => {
				if (event.type === "message_end" && isAssistantMessage(event.message)) {
					assistantTurns++;
					const messageUsage = event.message.usage;
					usage.input += messageUsage.input;
					usage.output += messageUsage.output;
					usage.cacheRead += messageUsage.cacheRead;
					usage.cacheWrite += messageUsage.cacheWrite;
					usage.total += messageUsage.totalTokens;
					usage.cost.input += messageUsage.cost.input;
					usage.cost.output += messageUsage.cost.output;
					usage.cost.cacheRead += messageUsage.cost.cacheRead;
					usage.cost.cacheWrite += messageUsage.cost.cacheWrite;
					usage.cost.total += messageUsage.cost.total;
				}

				if (event.type === "tool_execution_start") {
					toolCalls++;
					const label = extractLabelFromArgs(event.args) || event.toolName;
					emitUpdate(formatStatus(config.name, label));
					if (toolCalls > config.maxToolCalls) {
						failureReason = `Tool call budget exceeded (${config.maxToolCalls})`;
						emitUpdate(formatStatus(config.name, "tool budget reached"));
						worker.abort();
					}
				}

				if (
					event.type === "turn_end" &&
					isAssistantMessage(event.message) &&
					event.toolResults.length > 0 &&
					assistantTurns >= config.maxTurns
				) {
					failureReason = `Turn budget exceeded (${config.maxTurns})`;
					emitUpdate(formatStatus(config.name, "turn budget reached"));
					worker.abort();
				}
			});

			emitUpdate(formatStatus(config.name, "started"));

			try {
				if (childController.signal.aborted) {
					throw new Error("Sub-agent aborted");
				}

				const abortWorker = () => worker.abort();
				childController.signal.addEventListener("abort", abortWorker, { once: true });
				try {
					const contextualBlocks = await buildContextualBlocks(params.task, config, options, currentModel);
					await worker.prompt(
						buildSubAgentTask(params.task, config, options.runtimeContext, contextualBlocks, runContext),
					);
					await worker.waitForIdle();
				} finally {
					childController.signal.removeEventListener("abort", abortWorker);
				}
			} finally {
				unsubscribe();
				unlinkAbortSignals();
				clearTimeout(wallClockTimer);
			}

			if (signal?.aborted) {
				throw new Error("Sub-agent aborted");
			}

			const lastAssistantMessage = getLastAssistantMessage(worker.state.messages);
			const durationMs = Date.now() - startedAt;
			if (!lastAssistantMessage) {
				failureReason = failureReason || "Sub-agent returned no assistant message";
				emitUpdate(formatStatus(config.name, "failed"));
				throw new Error(`Sub-agent ${config.name} failed: ${failureReason}`);
			}

			const finalText = extractAssistantText(lastAssistantMessage);
			const effectiveFailureReason =
				failureReason ||
				(lastAssistantMessage.stopReason === "error" || lastAssistantMessage.stopReason === "aborted"
					? lastAssistantMessage.errorMessage || `Sub-agent stopped with ${lastAssistantMessage.stopReason}`
					: undefined);
			const verifierGitStateAfter =
				runContext.purpose === "verify" ? await gitWorkspaceState(scopedExecutor) : undefined;
			const verifierSubjectAfter =
				runContext.purpose === "verify" && options.runtimeContext.sandbox === "host"
					? await workspaceSubjectHash(runContext.workingDirectory)
					: undefined;
			const workspaceChanged =
				runContext.purpose === "verify" &&
				(verifierSubjectBefore !== undefined && verifierSubjectAfter !== undefined
					? verifierSubjectBefore !== verifierSubjectAfter
					: verifierGitStateBefore !== undefined &&
						verifierGitStateAfter !== undefined &&
						verifierGitStateBefore !== verifierGitStateAfter);
			const declaredVerdict = runContext.purpose === "verify" ? parseVerificationVerdict(finalText) : undefined;
			const verificationVerdict =
				runContext.purpose === "verify"
					? declaredVerdict === "pass" && !effectiveFailureReason && !workspaceChanged
						? "pass"
						: "fail"
					: undefined;
			if (runContext.purpose === "verify" && runContext.taskId && verificationVerdict) {
				const evidence = workspaceChanged
					? "Verifier changed tracked workspace files; the attestation is invalid."
					: !declaredVerdict
						? "Verifier did not emit the required final VERDICT marker."
						: finalText.trim().slice(0, 8_000);
				await writeVerificationAttestation(options.channelDir, {
					runId: runContext.runId,
					taskId: runContext.taskId,
					verdict: verificationVerdict,
					agent: config.name,
					model: formatModelReference(config.model),
					checkedAt: new Date().toISOString(),
					evidence,
					workspaceChanged: Boolean(workspaceChanged),
					subjectHash: workspaceChanged ? undefined : verifierSubjectAfter,
					output: finalText,
				});
			}

			if (effectiveFailureReason) {
				if (!finalText.trim()) {
					emitUpdate(formatStatus(config.name, "failed"));
					throw new Error(buildFailureText(config, effectiveFailureReason, finalText));
				}
				emitUpdate(formatStatus(config.name, "stopped"));
				return {
					content: [{ type: "text", text: buildStoppedText(config, effectiveFailureReason, finalText) }],
					details: createDetails(
						config,
						runContext,
						usage,
						assistantTurns,
						toolCalls,
						durationMs,
						true,
						effectiveFailureReason,
						verificationVerdict,
					),
				};
			}

			return {
				content: [{ type: "text", text: finalText || `(Sub-agent ${config.name} completed with no text output)` }],
				details: createDetails(
					config,
					runContext,
					usage,
					assistantTurns,
					toolCalls,
					durationMs,
					false,
					undefined,
					verificationVerdict,
				),
			};
		},
	};
}
