import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ExecOptions, ExecResult, Executor } from "../executor.js";
import type { MemoryCandidateStore } from "../memory/candidates.js";
import {
	getChannelHistoryPath,
	getChannelMemoryPath,
	getChannelSessionPath,
	readChannelSession,
} from "../memory/files.js";
import { recallRelevantMemory } from "../memory/recall.js";
import { formatModelReference } from "../models/utils.js";
import { DEFAULT_SECURITY_CONFIG } from "../security/config.js";
import type { SecurityConfig } from "../security/types.js";
import type { PipiclawMemoryRecallSettings } from "../settings.js";
import { splitH1Sections } from "../shared/markdown-sections.js";
import { clipTextByPromptUnits, countPromptUnits } from "../shared/prompt-units.js";
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
	agent: Type.Optional(Type.String({ description: "Name of a configured sub-agent from workspaceDir/sub-agents/" })),
	name: Type.Optional(Type.String({ description: "Optional display name for an inline sub-agent" })),
	task: Type.String({ description: "Complete task description for the sub-agent" }),
	systemPrompt: Type.Optional(
		Type.String({
			description: "Optional inline system prompt for a temporary sub-agent. Use when no configured agent fits.",
		}),
	),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Optional tool whitelist for the sub-agent" })),
	model: Type.Optional(
		Type.String({ description: "Optional exact model reference. Defaults to the parent's current model." }),
	),
	effort: Type.Optional(
		Type.Union([Type.Literal("quick"), Type.Literal("standard"), Type.Literal("deep")], {
			description:
				'Execution budget preset (turns, tool calls, wall time). "standard" is the default; "quick" for narrow lookups, "deep" for long analyses.',
		}),
	),
	context: Type.Optional(
		Type.Union([Type.Literal("none"), Type.Literal("session"), Type.Literal("relevant")], {
			description:
				'What context to inject. "none" (default) runs fully isolated; "session" adds current session state; "relevant" adds session state plus recalled memory.',
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
			description:
				'"worktree" runs in the task\'s own git worktree, reusing the one recorded on the task or creating it on first use. Requires taskId.',
		}),
	),
	returns: Type.Optional(
		Type.Union([Type.Literal("text"), Type.Literal("artifact")], {
			description:
				'"text" (default) returns the response directly; "artifact" makes the sub-agent write its primary output to a file and end with an ARTIFACT: <filename> marker. The full output is saved to disk either way.',
		}),
	),
	thinkingLevel: Type.Optional(
		Type.Union(
			[
				Type.Literal("off"),
				Type.Literal("minimal"),
				Type.Literal("low"),
				Type.Literal("medium"),
				Type.Literal("high"),
				Type.Literal("xhigh"),
			],
			{
				description:
					'Optional reasoning effort for the sub-agent. Defaults to "medium" for purpose=verify, "off" otherwise.',
			},
		),
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
	/** Always populated (spec 032 D4): the full output is saved to `${artifactDir}/output.md` regardless of `returns`. */
	artifactDir: string;
	/** Set only when `returns: "artifact"` and the sub-agent emitted a valid ARTIFACT: marker. */
	artifactPath?: string;
	/** True when the reply text was truncated against MAX_SUBAGENT_RESULT_UNITS; the full text is still on disk. */
	resultTruncated: boolean;
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
	/** `settings.subagentModel` (spec 032 D5); null/undefined means unset. */
	getSubAgentModelReference?: () => string | null;
	memoryCandidateStore?: MemoryCandidateStore;
	securityConfig?: SecurityConfig;
	webConfig?: PipiclawWebToolsConfig;
	rtkEnabled?: boolean;
	runtimeContext: {
		workspaceDir: string;
		channelId: string;
	};
	createWorker?: (config: {
		subAgent: ResolvedSubAgentConfig;
		apiKey: string;
		tools: AgentTool<any>[];
	}) => SubAgentWorker;
	/** Test-only override for the D6 convergence-turn wall clock; defaults to CONVERGENCE_WALL_CLOCK_MS. */
	convergenceWallClockMs?: number;
}

interface SubAgentWorker {
	state: { messages: AgentMessage[]; tools: AgentTool<any>[] };
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
/**
 * Reply budget for what a sub-agent hands back to its parent (spec 032 D4), measured in the
 * same prompt-unit currency as the system prompt budget (shared/prompt-units.ts). The full
 * output always lands on disk under the artifact directory regardless of this budget — this
 * only caps what gets echoed into the parent's context.
 */
export const MAX_SUBAGENT_RESULT_UNITS = 1_200;
const ARTIFACT_TRUNCATION_HEAD_RATIO = 1;
/**
 * Spec 032 D6: when a turn/tool/wall-time budget is hit, the sub-agent gets one more,
 * tool-free turn to summarize what it already found instead of having its work discarded.
 * This is a hard stop on that convergence turn itself, independent of maxWallTimeSec.
 */
const CONVERGENCE_WALL_CLOCK_MS = 60_000;
const CONVERGENCE_PROMPT =
	"Your turn/tool-call/wall-time budget for this task is exhausted. Based only on the work you have already completed, respond now with your conclusions: confirmed facts, what remains unfinished, and suggested next steps. Do not call any more tools.";

interface SubAgentRunContext {
	runId: string;
	purpose: "work" | "verify";
	taskId?: string;
	isolation: "shared" | "worktree";
	workingDirectory: string;
	worktreePath?: string;
	worktreeBranch?: string;
	artifactDir: string;
}

class DirectoryExecutor implements Executor {
	constructor(
		private readonly base: Executor,
		private readonly directory: string,
	) {}

	exec(command: string, options?: ExecOptions): Promise<ExecResult> {
		return this.base.exec(`cd ${shellEscape(this.directory)} && ${command}`, options);
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

function getSubAgentArtifactsRoot(channelDir: string): string {
	return join(channelDir, "subagent-artifacts");
}

/** Every run gets its own artifact directory (spec 032 D4), independent of `returns` mode. */
async function prepareArtifactDir(channelDir: string, runId: string): Promise<string> {
	const artifactDir = join(getSubAgentArtifactsRoot(channelDir), safeRunSegment(runId));
	await mkdir(artifactDir, { recursive: true });
	return artifactDir;
}

async function prepareRunContext(
	runId: string,
	params: { purpose?: "work" | "verify"; taskId?: string; isolation?: "shared" | "worktree" },
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
	const artifactDir = await prepareArtifactDir(options.channelDir, runId);
	const isolation = params.isolation ?? "shared";
	if (isolation === "shared") {
		const workingDirectory = resolve(options.workingDirectory ?? process.cwd());
		return { runId, purpose, taskId, isolation, workingDirectory, artifactDir };
	}
	if (!taskId) throw new Error("isolation=worktree requires taskId so the worktree has a durable owner.");
	if (!ownedTask?.fields.control) {
		throw new Error(`Task ${taskId} has no governed control metadata. Normalize it with task_manage set first.`);
	}

	const baseDir = resolve(options.channelDir, "tasks", "worktrees");
	await mkdir(baseDir, { recursive: true });
	// The task ledger — not the caller — owns the worktree identity. Reusing what
	// `control.worktree` already records is what keeps a second delegation on the same task
	// from creating a rival worktree and orphaning the first one.
	const recordedPath = ownedTask.fields.control.worktree?.path;
	if (recordedPath && existsSync(recordedPath)) {
		const existing = resolve(recordedPath);
		const rel = relative(baseDir, existing);
		if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
			throw new Error(
				`Task ${taskId} records a worktree outside ${baseDir}: ${existing}. Clear it with task_manage before delegating.`,
			);
		}
		const check = await options.executor.exec(`git -C ${shellEscape(existing)} rev-parse --is-inside-work-tree`);
		if (check.code !== 0 || check.stdout.trim() !== "true") {
			throw new Error(
				`Task ${taskId} records a path that is not a usable git worktree: ${existing}. Clear it with task_manage before delegating.`,
			);
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
			artifactDir,
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
		artifactDir,
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
		// The recorded worktree *is* the isolation fact; there is no separate flag to keep in sync.
		task.fields.control = applyTaskControlPatch(task.fields.control, {
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

const ARTIFACT_MARKER_PATTERN = /(?:^|\n)ARTIFACT:\s*(\S+)\s*$/i;

function parseArtifactMarker(output: string): string | undefined {
	return ARTIFACT_MARKER_PATTERN.exec(output.trim())?.[1];
}

interface FinalizedSubAgentOutput {
	artifactPath?: string;
	replyText: string;
	truncated: boolean;
}

/**
 * Spec 032 D4: the full text always lands on disk, independent of `returns` mode and of
 * whether it fits the reply budget. What comes back to the parent is capped at
 * MAX_SUBAGENT_RESULT_UNITS; a reply over budget is truncated with a pointer to the file
 * a chatty sub-agent can no longer blow out the parent's context.
 */
async function finalizeSubAgentOutput(
	runContext: SubAgentRunContext,
	finalText: string,
	returns: "text" | "artifact",
): Promise<FinalizedSubAgentOutput> {
	const trimmed = finalText.trim();
	const outputPath = join(runContext.artifactDir, "output.md");
	if (trimmed) {
		await writeFile(outputPath, finalText, "utf-8");
	}

	let artifactPath: string | undefined;
	if (returns === "artifact" && trimmed) {
		const filename = parseArtifactMarker(trimmed);
		if (filename) {
			const candidate = resolve(runContext.artifactDir, filename);
			const rel = relative(runContext.artifactDir, candidate);
			if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
				artifactPath = candidate;
			}
		}
	}

	if (countPromptUnits(finalText) <= MAX_SUBAGENT_RESULT_UNITS) {
		return { artifactPath, replyText: finalText, truncated: false };
	}

	const clipped = clipTextByPromptUnits(finalText, MAX_SUBAGENT_RESULT_UNITS, {
		headRatio: ARTIFACT_TRUNCATION_HEAD_RATIO,
		marker: `\n\n[... truncated; full output saved at ${outputPath} ...]\n\n`,
	});
	return { artifactPath, replyText: clipped.text, truncated: true };
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
				cwd: runContext.workingDirectory,
			},
			channelId: options.runtimeContext.channelId,
			channelDir: options.channelDir,
			workspaceDir: options.workspaceDir,
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
	returns: "text" | "artifact",
): string {
	const taskText = task.trim();
	const lines = [
		`Runtime context:`,
		`- Workspace root: ${runtimeContext.workspaceDir}`,
		`- Channel id: ${runtimeContext.channelId}`,
		`- Channel directory: ${runtimeContext.workspaceDir}/${runtimeContext.channelId}`,
		`- Working directory: ${runContext.workingDirectory}`,
		`- Filesystem isolation: ${runContext.isolation === "worktree" ? "dedicated git worktree" : "shared with parent"}`,
		`- Artifact directory: ${runContext.artifactDir}`,
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
		const taskPath = join(runtimeContext.workspaceDir, runtimeContext.channelId, "tasks", `${runContext.taskId}.md`);
		lines.push(
			"",
			"Verification protocol:",
			`- Independently inspect ${taskPath} and verify every DoD/Verification item against concrete evidence.`,
			"- You are the checker, not the maker. Do not edit files or fix failures; report them.",
			"- Run deterministic checks when available and distinguish observed evidence from assumptions.",
			"- End the response with exactly one final line: VERDICT: PASS or VERDICT: FAIL.",
		);
	} else if (returns === "artifact") {
		lines.push(
			"",
			"Output protocol:",
			`- Write your primary output as a file under the artifact directory above.`,
			"- End the response with exactly one final line: ARTIFACT: <filename>",
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
	extras?: { artifactPath?: string; resultTruncated?: boolean },
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
		artifactDir: runContext.artifactDir,
		artifactPath: extras?.artifactPath,
		resultTruncated: extras?.resultTruncated ?? false,
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
			"Delegate a task to a sub-agent with an isolated context. Default path: pass an inline systemPrompt (plus optional tools/model) to define a temporary sub-agent — no configured agent is required. You may instead name a configured sub-agent via `agent`; workspaceDir/sub-agents/ may be empty on a given install, which does not block inline delegation. Execution budgets come from `effort` presets and context injection from `context`; both have safe defaults, so state the task well and leave them alone unless you have a reason. Sub-agents never receive the subagent tool, so they cannot create nested agents.",
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
			const invocation = resolveSubAgentConfig(
				availableModels,
				currentModel,
				discovery.agents,
				params,
				options.getSubAgentModelReference?.() ?? undefined,
			);
			if (!invocation.config) {
				throw new Error(
					`${invocation.error}\n\nAvailable configured sub-agents:\n${formatSubAgentList(discovery.agents)}`,
				);
			}

			const config = invocation.config;
			const returns = params.returns ?? "text";
			const runContext = await prepareRunContext(_toolCallId, params, options);
			const scopedExecutor = new DirectoryExecutor(options.executor, runContext.workingDirectory);
			const apiKey = await options.resolveApiKey(config.model);
			const startedAt = Date.now();
			const usage = createEmptyUsageTotals();
			let assistantTurns = 0;
			let toolCalls = 0;
			let failureReason: string | undefined;
			/** Set alongside failureReason only for the three self-inflicted budget aborts, never for a parent-driven stop. */
			let budgetExceeded = false;
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
				runContext.purpose === "verify" ? await workspaceSubjectHash(runContext.workingDirectory) : undefined;

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
						thinkingLevel: config.thinkingLevel,
						tools: filterToolsByName(availableTools, config.tools),
					},
					convertToLlm,
					getApiKey: async () => apiKey,
				});

			const childController = new AbortController();
			const unlinkAbortSignals = linkAbortSignals(signal, childController);
			const wallClockTimer = setTimeout(() => {
				failureReason = `Wall time budget exceeded (${config.maxWallTimeSec}s)`;
				budgetExceeded = true;
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
						budgetExceeded = true;
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
					budgetExceeded = true;
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
						buildSubAgentTask(params.task, config, options.runtimeContext, contextualBlocks, runContext, returns),
					);
					await worker.waitForIdle();
				} finally {
					childController.signal.removeEventListener("abort", abortWorker);
				}

				// D6: a self-inflicted budget abort gets one tool-free turn to converge on a
				// conclusion instead of discarding the work outright. A parent-driven /stop
				// (childController already aborted) skips this — the user asked to stop now.
				if (budgetExceeded && !childController.signal.aborted) {
					clearTimeout(wallClockTimer);
					emitUpdate(formatStatus(config.name, "converging on budget exhaustion"));
					const preConvergenceMessageCount = worker.state.messages.length;
					worker.state.tools = [];
					let convergenceTimedOut = false;
					const convergenceTimer = setTimeout(() => {
						convergenceTimedOut = true;
						worker.abort();
					}, options.convergenceWallClockMs ?? CONVERGENCE_WALL_CLOCK_MS);
					childController.signal.addEventListener("abort", abortWorker, { once: true });
					try {
						await worker.prompt(CONVERGENCE_PROMPT);
						await worker.waitForIdle();
					} catch {
						// Best effort: fall through to whatever worker.state.messages holds.
					} finally {
						childController.signal.removeEventListener("abort", abortWorker);
						clearTimeout(convergenceTimer);
					}
					if (convergenceTimedOut) {
						// Revert to the pre-D6 behavior: drop the (aborted, possibly partial)
						// convergence turn and fall back to whatever came before it.
						worker.state.messages = worker.state.messages.slice(0, preConvergenceMessageCount);
					}
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
				runContext.purpose === "verify" ? await workspaceSubjectHash(runContext.workingDirectory) : undefined;
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
				const finalized = await finalizeSubAgentOutput(runContext, finalText, returns);
				return {
					content: [{ type: "text", text: buildStoppedText(config, effectiveFailureReason, finalized.replyText) }],
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
						{ artifactPath: finalized.artifactPath, resultTruncated: finalized.truncated },
					),
				};
			}

			const finalized = await finalizeSubAgentOutput(runContext, finalText, returns);
			return {
				content: [
					{
						type: "text",
						text: finalized.replyText || `(Sub-agent ${config.name} completed with no text output)`,
					},
				],
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
					{ artifactPath: finalized.artifactPath, resultTruncated: finalized.truncated },
				),
			};
		},
	};
}
