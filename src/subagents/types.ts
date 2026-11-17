/**
 * Shared vocabulary and shapes for delegation: role configs, the options the composition root
 * hands in, the per-run context, the worker surface, and the details payload every dispatch
 * returns. Leaf module within `subagents/` so `discovery`, `resolve`, `dispatch`, `task-envelope`,
 * `internal`, and `external` can all import it without forming a cycle.
 */
import type { AgentEvent, AgentMessage, AgentState, AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { PipiclawWebToolsConfig } from "../config/tools.js";
import type { Executor } from "../executor.js";
import type { FileStore } from "../file-store.js";
import type { ModelRequests } from "../models/requests.js";
import type { SecurityConfig, SecurityRuntimeContext } from "../security/types.js";
import type { SubAgentToolName } from "../tools/contract/names.js";
import type { UsageTotals } from "../usage/totals.js";
import type { ManagedWorktreeSummary, RunHarness, SubAgentThinkingLevel } from "./run-record.js";
import type { SubAgentRunManager } from "./runs.js";

export const DEFAULT_SUB_AGENT_TOOLS = ["read", "bash"] as const;
export const DEFAULT_MAX_TURNS = 32;
export const DEFAULT_MAX_TOOL_CALLS = 96;
export const DEFAULT_MAX_WALL_TIME_SEC = 600;
export const DEFAULT_BASH_TIMEOUT_SEC = 120;
/** External runs have no turn/tool-call budget (D5); wall time is their only lever. */
export const DEFAULT_EXTERNAL_MAX_WALL_TIME_SEC = 3600;
export const ALLOWED_CONTEXT_MODES = ["isolated", "contextual"] as const;
export const ALLOWED_MEMORY_MODES = ["none", "index"] as const;
export const ALLOWED_RUNTIMES = ["internal", "external"] as const;
export const ALLOWED_WORKLOADS = ["light", "heavy"] as const;
export const ALLOWED_MUTATES = ["read", "write"] as const;

/** Internal work/verify default, aligned with the main agent's DEFAULT_MAIN_THINKING_LEVEL
 *  (channel-runner.ts). External work leaves thinkingLevel unset instead (see `resolve.ts`):
 *  pipiclaw has no standing to pick a reasoning effort for another CLI's own configuration. */
export const DEFAULT_THINKING_LEVEL: SubAgentThinkingLevel = "medium";

export type SubAgentContextMode = (typeof ALLOWED_CONTEXT_MODES)[number];
export type SubAgentMemoryMode = (typeof ALLOWED_MEMORY_MODES)[number];
export type SubAgentRoleRuntime = (typeof ALLOWED_RUNTIMES)[number];
export type SubAgentWorkload = (typeof ALLOWED_WORKLOADS)[number];
export type SubAgentMutates = (typeof ALLOWED_MUTATES)[number];

interface SubAgentConfigFields {
	name: string;
	description: string;
	systemPrompt: string;
	tools: SubAgentToolName[];
	model?: Model<Api>;
	modelRef?: string;
	maxTurns: number;
	maxToolCalls: number;
	maxWallTimeSec: number;
	bashTimeoutSec: number;
	contextMode: SubAgentContextMode;
	memory: SubAgentMemoryMode;
	paths: string[];
	/** Unset means "apply the purpose-based default at resolution time" (spec 032 D3). */
	thinkingLevel?: SubAgentThinkingLevel;
	filePath?: string;
	source: "predefined" | "inline";
	/** Defaults to "internal"; existing role files therefore parse unchanged (spec 040, D5). */
	runtime: SubAgentRoleRuntime;
	/** External only. */
	harness?: RunHarness;
	/** External only: the raw, unvalidated command line. Tokenized by the harness at invocation
	 *  time (D4), never by discovery — discovery only checks that it is non-empty. */
	command?: string;
	/** exec harness only: run `command` through `/bin/sh -lc` instead of argv-direct spawn (D4). */
	shell?: boolean;
	/** External only: env vars appended to (and overriding) the inherited environment (D8.2). */
	env?: Record<string, string>;
	/** Drives system-prompt directory grouping (D11); defaults by runtime when unset. */
	workload?: SubAgentWorkload;
	/** Required for external (an explicit declaration); optional for internal (inferred from `tools`). */
	mutates?: SubAgentMutates;
	/** External only: the harness's own model string, passed through unresolved (D5) — never
	 *  looked up in `models.json`, because pipiclaw cannot validate another CLI's model names. */
	externalModelRef?: string;
	/** Set when the role is otherwise valid but currently cannot be invoked (e.g. missing binary).
	 *  The role is still listed — never silently dropped (D5) — and invocation must explain why. */
	unavailable?: string;
}

export interface InternalSubAgentConfig extends SubAgentConfigFields {
	runtime: "internal";
}

export interface ExternalSubAgentConfig extends SubAgentConfigFields {
	runtime: "external";
	harness: RunHarness;
	command: string;
	mutates: SubAgentMutates;
	model?: never;
	modelRef?: never;
}

export type SubAgentConfig = InternalSubAgentConfig | ExternalSubAgentConfig;

export interface ResolvedInternalSubAgentConfig extends InternalSubAgentConfig {
	model: Model<Api>;
	modelRef: string;
}

export type ResolvedSubAgentConfig = ResolvedInternalSubAgentConfig | ExternalSubAgentConfig;

export interface SubAgentDiscoveryResult {
	directory: string;
	agents: SubAgentConfig[];
	warnings: string[];
}

/**
 * Fields every delegation dispatch returns as its tool-result details. `kind` is not among them: `withToolDetails`
 * stamps it from the registration name when the tool set is built (see `tools/contract/details.ts`; `tools/subagent.ts` exports the stamped `SubAgentToolDetails`).
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
	/** Always populated (spec 032 D4): the full output is saved to `${artifactDir}/output.md`. */
	artifactDir: string;
	/** True when the reply text was truncated against MAX_SUBAGENT_RESULT_UNITS; the full text is still on disk. */
	resultTruncated: boolean;
	/**
	 * True only for the "still running" placeholder returned once the sync grace window elapses
	 * (spec 040, D2). The run keeps executing; its eventual result arrives as a completion wake,
	 * not as another tool result.
	 */
	dispatched?: boolean;
	/** Structured worktree details when `worktree: true` was requested. */
	worktree?: ManagedWorktreeSummary;
}

/** Exported for `subagent_run op=follow_up` (spec 042 D7), which constructs one of these for
 *  its own new run rather than a hand-rolled envelope. */
export interface SubAgentRunContext {
	runId: string;
	purpose: "work" | "verify";
	taskId?: string;
	item?: string;
	workingDirectory: string;
	artifactDir: string;
	managedWorktree?: {
		path: string;
		baseDir: string;
		branch: string | null;
		baseHead: string;
	};
}

/** The delegation parameters both invocation surfaces share (`task` plus routing). */
export interface DelegationParams {
	task: string;
	workingDirectory?: string;
	worktree?: boolean;
	purpose?: "work" | "verify";
	item?: string;
}

export interface SubAgentWorker {
	state: {
		messages: AgentMessage[];
		tools: AgentTool<any>[];
		model?: Model<Api>;
		thinkingLevel?: AgentState["thinkingLevel"];
	};
	subscribe(listener: (event: AgentEvent) => void): () => void;
	abort(): void;
	prompt(input: string): Promise<void>;
	/** Resume from the current transcript (last message a user or tool result). Without it a
	 *  provider error cannot be retried in place, so the run fails as before. */
	continue?(): Promise<void>;
	waitForIdle(): Promise<void>;
}

/**
 * Everything the tool registry needs to build one sub-agent's tool set. Declared here, not
 * imported, so `subagents/` never depends on `tools/`: the composition root injects
 * `buildWorkerTools` (spec 054 D9). Structurally a subset of `ToolBuildContext`.
 */
export interface WorkerToolRequest {
	executor: Executor;
	fileStore: FileStore;
	securityConfig: SecurityConfig;
	securityContext: SecurityRuntimeContext;
	channelId: string;
	deskDir: string;
	workspaceDir: string;
	webConfig?: PipiclawWebToolsConfig;
	rtkEnabled?: boolean;
	bashDefaultTimeoutSeconds: number;
	leaseOwnerRunId?: string;
}

/** Builds a sub-agent's scoped tool set from the shared registry; injected by `tools/index.ts`. */
export type BuildWorkerTools = (request: WorkerToolRequest) => AgentTool<any>[];

export interface SubAgentToolOptions {
	/** Builds a sub-agent's scoped tool set from the shared registry; injected by `tools/index.ts`. */
	buildWorkerTools: BuildWorkerTools;
	executor: Executor;
	fileStore: FileStore;
	/** Default working directory for a run: the parent's cwd. Defaults to process.cwd(). */
	workingDirectory?: string;
	getCurrentModel: () => Model<Api>;
	getAvailableModels: () => Model<Api>[];
	modelRequests: ModelRequests;
	workspaceDir: string;
	appHomeDir?: string;
	deskDir: string;
	getSubAgentDiscovery?: () => SubAgentDiscoveryResult;
	/** `settings.subagentModel` (spec 032 D5); null/undefined means unset. */
	getSubAgentModelReference?: () => string | null;
	securityConfig?: SecurityConfig;
	webConfig?: PipiclawWebToolsConfig;
	rtkEnabled?: boolean;
	runtimeContext: {
		workspaceDir: string;
		/** The desk the delegating turn belongs to, and its directory (tasks, memory). */
		desk: string;
		deskDir: string;
		channelId: string;
	};
	createWorker?: (config: { subAgent: ResolvedInternalSubAgentConfig; tools: AgentTool<any>[] }) => SubAgentWorker;
	/** Test seam for failures while constructing the scoped tool set after durable registration. */
	buildTools?: BuildSubagentTools;
	/** Test-only override for the D6 convergence-turn wall clock; defaults to CONVERGENCE_WALL_CLOCK_MS. */
	convergenceWallClockMs?: number;
	/** Test-only override for the D2 sync grace window; defaults to CHAT_SYNC_GRACE_MS for chat; task dispatch never waits for the worker. */
	syncGraceMs?: number;
	/** Test-only override for the transient-error retry backoff base; defaults to RETRY_BASE_DELAY_MS. */
	retryBaseDelayMs?: number;
	/**
	 * `settings.fallbackModel`, resolved the way the main agent resolves it (spec 017): `null` when
	 * unset, unresolvable or missing a key. An internal run that still fails after its transient
	 * retries switches to it once, like the main turn does.
	 */
	resolveFallbackModel?: () => Promise<Model<Api> | null>;
	/** Channel manager owned by the application; also a seam for admission failures. */
	getRunManager: (channelId: string) => SubAgentRunManager;
	/** Present only inside a task session: every delegation is bound to this task automatically (spec 052, D4). */
	boundTaskId?: string;
}

/** What a dispatch hands back to the tool wrapper: the text for the model plus the structured details. */
export interface DelegationResult {
	content: Array<{ type: "text"; text: string }>;
	details: SubAgentToolFields;
}

/** Builds the tool set one internal run's worker gets (default: `internal/worker.ts`'s `buildSubagentTools`). */
export type BuildSubagentTools = (
	executor: Executor,
	bashTimeoutSec: number,
	options: SubAgentToolOptions,
	runContext: SubAgentRunContext,
) => AgentTool<any>[];
