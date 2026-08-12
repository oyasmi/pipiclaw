import { existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ExecOptions, ExecResult, Executor } from "../executor.js";
import * as log from "../log.js";
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
import { formatLocalTime } from "../shared/local-time.js";
import { splitH1Sections } from "../shared/markdown-sections.js";
import { clipTextByPromptUnits, countPromptUnits } from "../shared/prompt-units.js";
import { RecoverableToolError } from "../shared/recoverable-error.js";
import { clipText, errorMessage, extractAssistantText, extractLabelFromArgs } from "../shared/text-utils.js";
import { createEmptyUsageTotals, type UsageTotals } from "../shared/types.js";
import { workspaceSubjectHash } from "../tasks/artifact-subject.js";
import { readStoredTask } from "../tasks/store.js";
import { writeVerificationAttestation } from "../tasks/verification.js";
import type { PipiclawWebToolsConfig } from "../tools/config.js";
import { buildToolSet } from "../tools/registry.js";
import {
	externalRoleFingerprint,
	formatSubAgentList,
	type ResolvedSubAgentConfig,
	resolveSubAgentConfig,
	type SubAgentConfig,
	type SubAgentDiscoveryResult,
	validateSubAgentTask,
	withSubAgentsDirWriteDeny,
} from "./discovery.js";
import { type ExternalLaunchResult, launchExternalRun } from "./external/run.js";
import { getSubAgentRunManager, type SettleInput, SYNC_GRACE_MS } from "./runs.js";
import { resolveVerificationOutcome } from "./verification-outcome.js";
import {
	acquireWorkspaceLease,
	findWorkspaceLeaseHolder,
	formatWorkspaceLeaseConflict,
	releaseWorkspaceLease,
} from "./workspace-lease.js";

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
	workingDirectory: Type.Optional(
		Type.String({
			description:
				"Optional existing directory to run the sub-agent in (its shell cwd and relative-path root). Use it to work on another checkout — e.g. a `git worktree add`ed one. Defaults to this runtime's own working directory.",
		}),
	),
	purpose: Type.Optional(
		Type.Union([Type.Literal("work"), Type.Literal("verify")], {
			description: 'Use "verify" for an independent, read-only task acceptance check.',
		}),
	),
	taskId: Type.Optional(Type.String({ description: "Persistent task id, required when purpose=verify." })),
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
				Type.Literal("max"),
			],
			{
				description:
					'Optional reasoning effort for the sub-agent. Defaults to "medium" for purpose=verify, "off" otherwise.',
			},
		),
	),
});

/**
 * Fields the `subagent` tool itself constructs. `kind` is not among them: `withToolDetails`
 * stamps it from the registration name when the tool set is built (see `tools/tool-details.ts`).
 */
export interface SubAgentToolFields {
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
	verificationVerdict?: "pass" | "fail";
	/** Always populated (spec 032 D4): the full output is saved to `${artifactDir}/output.md` regardless of `returns`. */
	artifactDir: string;
	/** Set only when `returns: "artifact"` and the sub-agent emitted a valid ARTIFACT: marker. */
	artifactPath?: string;
	/** True when the reply text was truncated against MAX_SUBAGENT_RESULT_UNITS; the full text is still on disk. */
	resultTruncated: boolean;
	/**
	 * True only for the "still running" placeholder returned once the sync grace window elapses
	 * (spec 040, D2). The run keeps executing; its eventual result arrives as a completion wake,
	 * not as another tool result.
	 */
	dispatched?: boolean;
}

/** The shape consumers read post-wrap, once `withToolDetails` has stamped `kind`. */
export type SubAgentToolDetails = SubAgentToolFields & { kind: "subagent" };

export interface SubAgentToolOptions {
	executor: Executor;
	/** Host checkout used as the sub-agent's cwd. Defaults to process.cwd(). */
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
	/** Test seam for failures while constructing the scoped tool set after durable registration. */
	buildTools?: typeof buildSubagentTools;
	/** Test-only override for the D6 convergence-turn wall clock; defaults to CONVERGENCE_WALL_CLOCK_MS. */
	convergenceWallClockMs?: number;
	/** Test-only override for the D2 sync grace window; defaults to SYNC_GRACE_MS. */
	syncGraceMs?: number;
	/** Test seam for setup/admission failures. Production uses the process-wide channel manager. */
	getRunManager?: typeof getSubAgentRunManager;
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

/** Exported for `subagent_manage op=follow_up` (spec 042 D7), which constructs one of these for
 *  its own new run rather than a hand-rolled envelope. */
export interface SubAgentRunContext {
	runId: string;
	purpose: "work" | "verify";
	taskId?: string;
	workingDirectory: string;
	artifactDir: string;
}

/**
 * Pins every command a run issues to the run's working directory. It sets the child's real `cwd`
 * rather than prefixing `cd <dir> &&`: the prefix silently produced a *different* command than the
 * guard inspected, and a directory that cannot be entered surfaced as a shell error inside an
 * otherwise successful command line.
 */
class DirectoryExecutor implements Executor {
	constructor(
		private readonly base: Executor,
		private readonly directory: string,
	) {}

	exec(command: string, options?: ExecOptions): Promise<ExecResult> {
		return this.base.exec(command, { ...options, cwd: this.directory });
	}
}

function safeRunSegment(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 48) || "run";
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

/**
 * Resolve the checkout a run works in (spec 036, D3).
 *
 * Spec 036 removed task-owned worktrees on the premise that a caller needing a separate checkout
 * would `git worktree add` on the host and "pass it in as an ordinary working directory" — but no
 * parameter for that ever existed, so every run was pinned to the daemon's own cwd. This is that
 * parameter. Path guards are unaffected: they judge the *resolved absolute* target, so a cwd
 * outside the allowed roots makes relative paths fail exactly as an absolute one there would.
 */
function resolveRunWorkingDirectory(requested: string | undefined, options: SubAgentToolOptions): string {
	const base = resolve(options.workingDirectory ?? process.cwd());
	const trimmed = requested?.trim();
	if (!trimmed) return base;
	const target = resolve(base, trimmed);
	if (!existsSync(target) || !statSync(target).isDirectory()) {
		throw new RecoverableToolError(`workingDirectory "${requested}" is not an existing directory.`);
	}
	return target;
}

async function prepareRunContext(
	runId: string,
	params: { purpose?: "work" | "verify"; taskId?: string; workingDirectory?: string },
	options: SubAgentToolOptions,
): Promise<SubAgentRunContext> {
	const purpose = params.purpose ?? "work";
	const taskId = params.taskId?.trim() || undefined;
	if (purpose === "verify" && !taskId) throw new RecoverableToolError("purpose=verify requires taskId.");
	if (taskId && !TASK_ID_PATTERN.test(taskId)) throw new RecoverableToolError(`Invalid taskId: ${taskId}`);
	if (taskId && !(await readStoredTask(options.channelDir, taskId))) {
		throw new RecoverableToolError(
			`Task ${taskId} does not exist. Create it with task_manage before delegating task-owned work.`,
		);
	}
	const artifactDir = await prepareArtifactDir(options.channelDir, runId);
	const workingDirectory = resolveRunWorkingDirectory(params.workingDirectory, options);
	return { runId, purpose, taskId, workingDirectory, artifactDir };
}

async function gitWorkspaceState(executor: Executor): Promise<string | undefined> {
	const result = await executor.exec("git status --porcelain=v1 --untracked-files=all", { timeout: 30 });
	return result.code === 0 ? result.stdout : undefined;
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
 *
 * The file itself is written by `SubAgentRunManager.settle()` — the one settlement point both
 * runtimes share (spec 040 D1) — which always runs before this call's reply reaches the parent.
 * This function only needs the path, to point at it.
 */
function finalizeSubAgentOutput(
	runContext: SubAgentRunContext,
	finalText: string,
	returns: "text" | "artifact",
): FinalizedSubAgentOutput {
	const trimmed = finalText.trim();
	const outputPath = join(runContext.artifactDir, "output.md");

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
function withSubagentMemoryWriteDeny(
	securityConfig: SecurityConfig,
	channelDir: string,
	workspaceDir: string,
): SecurityConfig {
	const protectedPaths = [
		getChannelMemoryPath(channelDir),
		getChannelHistoryPath(channelDir),
		getChannelSessionPath(channelDir),
	];
	// The role directory gets the same structural denial (spec 040, D8.1): a sub-agent's write/edit
	// tools are exactly as capable of writing a self-authorizing `runtime: external` role file as
	// the main agent's are.
	return withSubAgentsDirWriteDeny(
		{
			...securityConfig,
			pathGuard: {
				...securityConfig.pathGuard,
				writeDeny: [...securityConfig.pathGuard.writeDeny, ...protectedPaths],
			},
		},
		workspaceDir,
	);
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
		options.workspaceDir,
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

/** Shared by both runtimes' task envelopes and `subagent_manage`'s verify follow-up (spec 040, D9). */
export function buildVerificationProtocol(taskPath: string): string {
	return [
		"Verification protocol:",
		`- Independently inspect ${taskPath} and verify every DoD/Verification item against concrete evidence.`,
		"- You are the checker, not the maker. Do not edit files or fix failures; report them.",
		"- Run deterministic checks when available and distinguish observed evidence from assumptions.",
		"- End the response with exactly one final line: VERDICT: PASS or VERDICT: FAIL.",
	].join("\n");
}

/**
 * D9 verify admission — a role that admits it writes cannot also be the checker, `exec` has no
 * protocol terminal to prove it even ran to completion, and a target with an active write lease
 * is refused up front (cheaper than explaining afterward why the attestation would be worthless).
 * Spec 042 D7: exported so `subagent_manage op=follow_up` runs the exact same checks the initial
 * dispatch does — before this function existed, follow_up on a role that had since been hot-edited
 * to `mutates: write` would silently take the write lease and dispatch instead of refusing.
 */
export function assertVerifyAdmissible(
	config: Pick<ResolvedSubAgentConfig, "name" | "mutates" | "runtime" | "harness">,
	purpose: "work" | "verify",
	workingDirectory: string,
): void {
	if (purpose !== "verify") return;
	if (config.mutates === "write") {
		throw new RecoverableToolError(
			`Sub-agent "${config.name}" declares mutates: write and cannot be used for purpose=verify.`,
		);
	}
	if (config.runtime === "external" && config.harness === "exec") {
		throw new RecoverableToolError(
			`Sub-agent "${config.name}" uses the exec harness, which has no protocol terminal and cannot be used for purpose=verify.`,
		);
	}
	const holder = findWorkspaceLeaseHolder(workingDirectory);
	if (holder) {
		throw new RecoverableToolError(`Cannot verify "${workingDirectory}": ${formatWorkspaceLeaseConflict(holder)}`);
	}
}

/**
 * Exported for `subagent_manage op=follow_up` (spec 042 D7), which builds a follow-up run's task
 * envelope the same way the initial dispatch does rather than a hand-rolled approximation.
 * `config` is deliberately narrowed to `{ name }` — the only field this function reads — so a
 * caller with a raw (unresolved) `SubAgentConfig` from discovery does not need to fabricate a
 * `model`/`modelRef`/`thinkingLevel` just to satisfy a wider type it never touches.
 */
export function buildSubAgentTask(
	task: string,
	config: Pick<SubAgentConfig, "name">,
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
		lines.push("", buildVerificationProtocol(taskPath));
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

/** Exported for `subagent_manage op=follow_up` (spec 042 D7) — same reason as `buildSubAgentTask`. */
/** The slice of `SubAgentToolOptions` `buildContextualBlocks` actually reads — narrowed (spec 042
 *  D7) so `subagent_manage op=follow_up` only needs to wire these six fields, not the full tool
 *  option surface (executor, discovery, web config, etc. that a context-block build never touches). */
export type ContextualBlocksOptions = Pick<
	SubAgentToolOptions,
	| "channelDir"
	| "getMemoryRecallSettings"
	| "runtimeContext"
	| "workspaceDir"
	| "resolveApiKey"
	| "memoryCandidateStore"
>;

export async function buildContextualBlocks(
	task: string,
	config: Pick<SubAgentConfig, "contextMode" | "paths" | "memory" | "description">,
	options: ContextualBlocksOptions,
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
): SubAgentToolFields {
	return {
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
		verificationVerdict,
		artifactDir: runContext.artifactDir,
		artifactPath: extras?.artifactPath,
		resultTruncated: extras?.resultTruncated ?? false,
	};
}

/**
 * A run's lifecycle is deliberately unlinked from the tool call's `AbortSignal` (spec 040, D2):
 * `/stop` ends the current turn but no longer kills an in-flight delegation, matching background
 * jobs. Stopping a run is now an explicit decision (`subagent_manage op=cancel`), not a side
 * effect of stopping something else.
 */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
}

export function createSubAgentTool(options: SubAgentToolOptions): AgentTool<typeof subagentSchema, SubAgentToolFields> {
	return {
		name: "subagent",
		label: "subagent",
		description:
			"Delegate a task to a sub-agent with an isolated context. Default path: pass an inline systemPrompt (plus optional tools/model) to define a temporary sub-agent — no configured agent is required. You may instead name a configured sub-agent via `agent`; workspaceDir/sub-agents/ may be empty on a given install, which does not block inline delegation. Execution budgets come from `effort` presets and context injection from `context`; both have safe defaults, so state the task well and leave them alone unless you have a reason. Sub-agents never receive the subagent tool, so they cannot create nested agents.",
		parameters: subagentSchema,
		execute: async (_toolCallId, params, signal, onUpdate) => {
			if (signal?.aborted) {
				throw new Error("Sub-agent aborted");
			}
			const availableModels = options.getAvailableModels();
			const discovery = options.getSubAgentDiscovery?.() ?? {
				directory: `${options.workspaceDir}/sub-agents`,
				agents: [],
				warnings: [],
			};
			const currentModel = options.getCurrentModel();
			const taskLengthError = validateSubAgentTask(params.task);
			if (taskLengthError) {
				throw new RecoverableToolError(taskLengthError);
			}
			const invocation = resolveSubAgentConfig(
				availableModels,
				currentModel,
				discovery.agents,
				params,
				options.getSubAgentModelReference?.() ?? undefined,
			);
			if (!invocation.config) {
				throw new RecoverableToolError(
					`${invocation.error}\n\nAvailable configured sub-agents:\n${formatSubAgentList(discovery.agents)}`,
				);
			}

			const config = invocation.config;
			const returns = params.returns ?? "text";
			// Spec 042 D3: `returns: "artifact"` has no external equivalent — the marker protocol
			// scopes a produced file to `artifactDir`, but an external agent's real output lives in
			// its working directory. Implementing it would build a same-named, different-meaning
			// protocol; rejecting it is honest about the mismatch. An external run's full output
			// always lands in `output.md` regardless (spec 032 D4), so this loses nothing — a caller
			// that needs a specific artifact location says so in the task text.
			if (config.runtime === "external" && returns === "artifact") {
				throw new RecoverableToolError(
					`Sub-agent "${config.name}" is external; returns: "artifact" has no effect on external roles ` +
						"(their full output always lands in output.md). State the desired output file in the task text instead.",
				);
			}
			const runManager = (options.getRunManager ?? getSubAgentRunManager)(options.runtimeContext.channelId);
			// A short, human-typeable id (spec 041) — never the dispatching tool call's own id, which
			// on some providers is a long `call_<id>|fc_<id>` composite unreadable in a chat UI.
			const runContext = await prepareRunContext(runManager.mintRunId(), params, options);

			// D9: an independent verifier checks against a target that isn't moving under it — shared
			// with `subagent_manage op=follow_up` (spec 042 D7) so a verify run's admission rules
			// cannot drift between the two dispatch paths.
			assertVerifyAdmissible(config, runContext.purpose, runContext.workingDirectory);

			// Admission: a write-mutating run takes an exclusive workspace lease before it is even
			// registered (spec 040, D10.1) — a rejected delegation should never count as "started".
			// Read runs and purpose=verify never take one. Shared by both runtimes.
			let leaseKey: string | undefined;
			if (config.mutates === "write" && runContext.purpose !== "verify") {
				const lease = acquireWorkspaceLease({
					runId: runContext.runId,
					channelId: options.runtimeContext.channelId,
					workingDirectory: runContext.workingDirectory,
				});
				if (!lease.ok) {
					throw new RecoverableToolError(formatWorkspaceLeaseConflict(lease.heldBy));
				}
				leaseKey = lease.leaseKey;
			}

			if (config.runtime === "external") {
				if (!config.harness) {
					releaseWorkspaceLease(leaseKey, runContext.runId);
					throw new Error(`Sub-agent "${config.name}" has runtime: external but no harness configured.`);
				}
				let launchResult: ExternalLaunchResult;
				try {
					// D9/T5: external roles get the same task envelope internal workers do — runtime
					// paths, injected context blocks, and (for purpose=verify) the verification
					// protocol — rather than the raw task text (spec 040 gap closed post-review).
					// Spec 042 D3: `returns: "artifact"` is rejected for external above, so this is
					// always "text" here — passed literally rather than the `returns` variable so the
					// ARTIFACT marker protocol is never injected into an external envelope, which no
					// external result parser has ever read.
					const contextualBlocks = await buildContextualBlocks(params.task, config, options, currentModel);
					const envelopedTask = buildSubAgentTask(
						params.task,
						config,
						options.runtimeContext,
						contextualBlocks,
						runContext,
						"text",
					);
					launchResult = await launchExternalRun({
						runId: runContext.runId,
						channelId: options.runtimeContext.channelId,
						channelDir: options.channelDir,
						label: params.label,
						agent: config.name,
						source: config.source,
						harness: config.harness,
						command: config.command ?? "",
						shell: config.shell,
						env: config.env,
						externalModelRef: config.externalModelRef,
						thinkingLevel: config.thinkingLevel,
						maxWallTimeSec: config.maxWallTimeSec,
						systemPrompt: config.systemPrompt,
						task: envelopedTask,
						workingDirectory: runContext.workingDirectory,
						artifactDir: runContext.artifactDir,
						purpose: runContext.purpose,
						taskId: runContext.taskId,
						leaseKey,
						mutates: config.mutates,
						roleFingerprint: externalRoleFingerprint(config),
						workspaceDir: options.workspaceDir,
						securityConfig: options.securityConfig ?? DEFAULT_SECURITY_CONFIG,
					});
				} catch (error) {
					// Only a pre-register() throw (unknown harness, shell-mode misuse) reaches here —
					// every failure past that point settles the run itself and already released this
					// lease (spec 042 D2/D5), so this catch must not release it a second time.
					releaseWorkspaceLease(leaseKey, runContext.runId);
					throw error;
				}
				// Spec 042 D2: a pre-spawn failure is reported in this same turn instead of a
				// "[Dispatched]" placeholder the model would wait on forever — two of the three
				// failure kinds never used to announce at all. `settle()` already released the lease.
				if (!launchResult.ok) {
					if (launchResult.kind === "missing-binary") {
						throw new Error(
							`Sub-agent "${config.name}" failed to launch: ${launchResult.reason} Install the CLI or fix "command" in its role file; the run was not dispatched.`,
						);
					}
					throw new RecoverableToolError(
						`Sub-agent "${config.name}" failed to launch: ${launchResult.reason} The run was not dispatched.`,
					);
				}
				// D2: external's sync grace window is always 0 — always the dispatched placeholder,
				// never an inline wait. The run keeps going in the background and wakes the channel.
				return {
					content: [
						{
							type: "text",
							text:
								`[Dispatched] runId=${runContext.runId}, agent ${config.name} (external, ${config.harness}), working directory ${runContext.workingDirectory}.\n` +
								"Status: running. This channel will be woken with the result and artifact path once it finishes.\n" +
								"Do not dispatch it again or poll for it now -- end this turn. If it belongs to a task, mark it waiting with task_manage.",
						},
					],
					details: {
						agent: config.name,
						source: config.source,
						model: config.externalModelRef ?? "unknown",
						tools: [],
						turns: 0,
						toolCalls: 0,
						durationMs: 0,
						failed: false,
						usage: createEmptyUsageTotals(),
						runId: runContext.runId,
						purpose: runContext.purpose,
						taskId: runContext.taskId,
						artifactDir: runContext.artifactDir,
						resultTruncated: false,
						dispatched: true,
					},
				};
			}

			const scopedExecutor = new DirectoryExecutor(options.executor, runContext.workingDirectory);
			let apiKey: string;
			try {
				apiKey = await options.resolveApiKey(config.model);
			} catch (error) {
				releaseWorkspaceLease(leaseKey, runContext.runId);
				throw error;
			}
			const startedAt = Date.now();
			const usage = createEmptyUsageTotals();
			let assistantTurns = 0;
			let toolCalls = 0;
			let failureReason: string | undefined;
			/** Set alongside failureReason only for the three self-inflicted budget aborts, distinct from an explicit cancel. */
			let budgetExceeded = false;
			/** Set only by the `subagent_manage op=cancel` handle registered below — a real stop, unlike a budget abort. */
			let externallyCancelled = false;
			/** True once the sync grace window has elapsed and a "still running" placeholder has been returned. */
			let detached = false;
			let lastUpdateText = "";

			try {
				await runManager.register({
					runId: runContext.runId,
					channelId: options.runtimeContext.channelId,
					runtime: "internal",
					agent: config.name,
					label: params.label,
					source: config.source,
					tools: [...config.tools],
					model: formatModelReference(config.model),
					purpose: runContext.purpose,
					taskId: runContext.taskId,
					workingDirectory: runContext.workingDirectory,
					artifactDir: runContext.artifactDir,
					leaseKey,
				});
			} catch (error) {
				// Until the durable running record exists, setup still owns the lease. A channel/host
				// admission rejection or required persist failure must leave no invisible writer lock.
				releaseWorkspaceLease(leaseKey, runContext.runId);
				throw error;
			}

			const emitUpdate = (text: string) => {
				// Once detached, execute() has already returned to the SDK; nothing is listening
				// for further progress on this (from its view, finished) tool call.
				if (detached) return;
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

			let worker: SubAgentWorker | undefined;
			let wallClockTimer: ReturnType<typeof setTimeout> | undefined;
			let unsubscribe: (() => void) | undefined;
			let verifierGitStateBefore: string | undefined;
			let verifierSubjectBefore: string | undefined;
			try {
				const availableTools = (options.buildTools ?? buildSubagentTools)(
					scopedExecutor,
					config.bashTimeoutSec,
					options,
					runContext,
				);
				verifierGitStateBefore =
					runContext.purpose === "verify" ? await gitWorkspaceState(scopedExecutor) : undefined;
				verifierSubjectBefore =
					runContext.purpose === "verify" ? await workspaceSubjectHash(runContext.workingDirectory) : undefined;

				worker =
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
						streamFn: streamSimple,
					});

				runManager.registerCancelHandle(runContext.runId, () => {
					externallyCancelled = true;
					worker?.abort();
				});

				wallClockTimer = setTimeout(() => {
					failureReason = `Wall time budget exceeded (${config.maxWallTimeSec}s)`;
					budgetExceeded = true;
					worker?.abort();
				}, config.maxWallTimeSec * 1000);

				unsubscribe = worker.subscribe((event: AgentEvent) => {
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
							worker?.abort();
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
						worker?.abort();
					}
				});

				emitUpdate(formatStatus(config.name, "started"));
			} catch (error) {
				unsubscribe?.();
				if (wallClockTimer) clearTimeout(wallClockTimer);
				runManager.clearCancelHandle(runContext.runId);
				try {
					worker?.abort();
				} catch {
					// Preserve the setup error; settlement below is the lifecycle authority.
				}
				const setupError = error instanceof Error ? error : new Error(String(error));
				await runManager.settle(
					runContext.runId,
					{
						status: "failed",
						failureReason: setupError.message,
						usage,
						usageKnown: true,
						costKnown: true,
						turns: assistantTurns,
						toolCalls,
						durationMs: Date.now() - startedAt,
						outputText: "",
					},
					{ announce: false },
				);
				throw setupError;
			}
			const activeWorker = worker!;
			const activeUnsubscribe = unsubscribe!;
			const activeWallClockTimer = wallClockTimer!;

			/**
			 * Runs the worker to completion, including the D6 convergence turn, and returns the
			 * tool result plus the data `runs.ts` needs to settle. Rejects only for the single
			 * fatal case (no assistant message at all) — every other outcome, including a budget
			 * abort or explicit cancel, is a normal (if failed) result.
			 */
			async function runToCompletion(): Promise<{
				toolResult: { content: Array<{ type: "text"; text: string }>; details: SubAgentToolFields };
				settleInput: SettleInput;
			}> {
				try {
					const contextualBlocks = await buildContextualBlocks(params.task, config, options, currentModel);
					await activeWorker.prompt(
						buildSubAgentTask(params.task, config, options.runtimeContext, contextualBlocks, runContext, returns),
					);
					await activeWorker.waitForIdle();

					// D6: a self-inflicted budget abort gets one tool-free turn to converge on a
					// conclusion instead of discarding the work outright. An explicit cancel skips
					// this — the model asked this run to stop now, not to wrap up.
					if (budgetExceeded && !externallyCancelled) {
						clearTimeout(activeWallClockTimer);
						emitUpdate(formatStatus(config.name, "converging on budget exhaustion"));
						const preConvergenceMessageCount = activeWorker.state.messages.length;
						activeWorker.state.tools = [];
						let convergenceTimedOut = false;
						const convergenceTimer = setTimeout(() => {
							convergenceTimedOut = true;
							activeWorker.abort();
						}, options.convergenceWallClockMs ?? CONVERGENCE_WALL_CLOCK_MS);
						try {
							await activeWorker.prompt(CONVERGENCE_PROMPT);
							await activeWorker.waitForIdle();
						} catch {
							// Best effort: fall through to whatever worker.state.messages holds.
						} finally {
							clearTimeout(convergenceTimer);
						}
						if (convergenceTimedOut) {
							// Revert to the pre-D6 behavior: drop the (aborted, possibly partial)
							// convergence turn and fall back to whatever came before it.
							activeWorker.state.messages = activeWorker.state.messages.slice(0, preConvergenceMessageCount);
						}
					}
				} finally {
					activeUnsubscribe();
					clearTimeout(activeWallClockTimer);
				}

				const lastAssistantMessage = getLastAssistantMessage(activeWorker.state.messages);
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
				// Spec 042 D1: the pass/fail judgment rule is shared with the external verify path
				// (`resolveVerificationOutcome`) so there is exactly one place deciding what a verify
				// run's own output does and does not prove. Only the attestation write (and its
				// "enforced" strength) stays here, since only the internal path structurally removes
				// write/edit from the verifier's tool set.
				const verification =
					runContext.purpose === "verify"
						? resolveVerificationOutcome({
								subjectBefore: verifierSubjectBefore,
								subjectAfter: verifierSubjectAfter,
								gitStateBefore: verifierGitStateBefore,
								gitStateAfter: verifierGitStateAfter,
								finalText,
								runFailed: Boolean(effectiveFailureReason),
							})
						: undefined;
				const verificationVerdict = verification?.verdict;
				if (runContext.purpose === "verify" && runContext.taskId && verification) {
					await writeVerificationAttestation(options.channelDir, {
						runId: runContext.runId,
						taskId: runContext.taskId,
						verdict: verification.verdict,
						checkedAt: formatLocalTime(),
						evidence: verification.evidence,
						workspaceChanged: verification.workspaceChanged,
						subjectHash: verification.workspaceChanged ? undefined : verifierSubjectAfter,
						subjectDir: runContext.workingDirectory,
						// Internal verify always keeps write/edit structurally removed from the
						// verifier's tool set (buildSubagentTools above) — a real, enforced gate.
						verificationStrength: "enforced",
					});
				}

				// Internal runs always report full usage; cost is "unknown" only for the shape a
				// free/local model produces (tokens spent, nothing billed) — external harnesses
				// override both explicitly once they land (D4/D9).
				const costKnown = usage.cost.total > 0 || usage.total === 0;
				const baseSettleInput = {
					usage,
					usageKnown: true,
					costKnown,
					turns: assistantTurns,
					toolCalls,
					durationMs,
					verificationVerdict,
					verificationStrength: runContext.purpose === "verify" ? ("enforced" as const) : undefined,
				};

				if (effectiveFailureReason) {
					if (!finalText.trim()) {
						emitUpdate(formatStatus(config.name, "failed"));
						throw new Error(buildFailureText(config, effectiveFailureReason, finalText));
					}
					emitUpdate(formatStatus(config.name, "stopped"));
					const finalized = finalizeSubAgentOutput(runContext, finalText, returns);
					return {
						toolResult: {
							content: [
								{ type: "text", text: buildStoppedText(config, effectiveFailureReason, finalized.replyText) },
							],
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
						},
						settleInput: {
							...baseSettleInput,
							// An explicit cancel is not a failure (P1-1) — the model asked this run to
							// stop, and it did.
							status: externallyCancelled ? "cancelled" : "failed",
							failureReason: effectiveFailureReason,
							outputText: finalText,
						},
					};
				}

				const finalized = finalizeSubAgentOutput(runContext, finalText, returns);
				return {
					toolResult: {
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
					},
					settleInput: { ...baseSettleInput, status: "completed", outputText: finalText },
				};
			}

			/** Best-effort settle input for the one fatal path that rejects instead of resolving. */
			function fatalSettleInput(error: Error): SettleInput {
				return {
					status: externallyCancelled ? "cancelled" : "failed",
					failureReason: failureReason || error.message,
					usage,
					usageKnown: true,
					costKnown: usage.cost.total > 0 || usage.total === 0,
					turns: assistantTurns,
					toolCalls,
					durationMs: Date.now() - startedAt,
					outputText: "",
				};
			}

			// D2: the tool call waits at most SYNC_GRACE_MS (never longer than the run's own wall
			// clock budget) before degrading to a "still running" placeholder. The run itself keeps
			// executing either way — only the *return* differs.
			const graceMs = Math.min(config.maxWallTimeSec * 1000, options.syncGraceMs ?? SYNC_GRACE_MS);
			const outcomePromise = runToCompletion().then(
				(value) => ({ ok: true as const, value }),
				(error: unknown) => ({
					ok: false as const,
					error: error instanceof Error ? error : new Error(String(error)),
				}),
			);
			const raceResult = await Promise.race([outcomePromise, sleep(graceMs).then(() => "timed-out" as const)]);

			if (raceResult !== "timed-out") {
				runManager.clearCancelHandle(runContext.runId);
				if (!raceResult.ok) {
					await runManager.settle(runContext.runId, fatalSettleInput(raceResult.error), { announce: false });
					throw raceResult.error;
				}
				await runManager.settle(runContext.runId, raceResult.value.settleInput, { announce: false });
				return raceResult.value.toolResult;
			}

			// Grace window elapsed: hand back a placeholder now and let the run keep going in the
			// background. It settles and, this time, announces itself with a completion wake (D2/D7)
			// — the same "runtime guarantees completion" contract background jobs already keep.
			detached = true;
			void outcomePromise.then(async (outcome) => {
				runManager.clearCancelHandle(runContext.runId);
				const settleInput = outcome.ok ? outcome.value.settleInput : fatalSettleInput(outcome.error);
				await runManager.settle(runContext.runId, settleInput, { announce: true }).catch((error) => {
					log.logWarning(`Failed to settle detached sub-agent run ${runContext.runId}`, errorMessage(error));
				});
			});

			return {
				content: [
					{
						type: "text",
						text:
							`[Dispatched] runId=${runContext.runId}, agent ${config.name} (internal, async), working directory ${runContext.workingDirectory}.\n` +
							"Status: running. This channel will be woken with the result and artifact path once it finishes.\n" +
							"Do not dispatch it again or poll for it now -- end this turn. If it belongs to a task, mark it waiting with task_manage.",
					},
				],
				details: {
					agent: config.name,
					source: config.source,
					model: formatModelReference(config.model),
					tools: [...config.tools],
					turns: assistantTurns,
					toolCalls,
					durationMs: Date.now() - startedAt,
					failed: false,
					usage: { ...usage, cost: { ...usage.cost } },
					runId: runContext.runId,
					purpose: runContext.purpose,
					taskId: runContext.taskId,
					artifactDir: runContext.artifactDir,
					resultTruncated: false,
					dispatched: true,
				},
			};
		},
	};
}
