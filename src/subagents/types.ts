/**
 * Shared shapes for delegation dispatch: the options the composition root hands in, the per-run
 * context, the worker surface, and the details payload every dispatch returns. Types only, so the
 * dispatch, envelope, internal and external modules can all import them without forming a cycle.
 */
import type { AgentEvent, AgentMessage, AgentState, AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { PipiclawWebToolsConfig } from "../config/tools.js";
import type { Executor } from "../executor.js";
import type { FileStore } from "../file-store.js";
import type { SecurityConfig, SecurityRuntimeContext } from "../security/types.js";
import type { UsageTotals } from "../usage/totals.js";
import type { ResolvedInternalSubAgentConfig, SubAgentDiscoveryResult } from "./discovery.js";
import type { SubAgentRunManager } from "./runs.js";

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
}

/** The delegation parameters both invocation surfaces share (`task` plus routing). */
export interface DelegationParams {
	task: string;
	workingDirectory?: string;
	purpose?: "work" | "verify";
	taskId?: string;
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
	resolveApiKey: (model: Model<Api>) => Promise<string>;
	workspaceDir: string;
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
	createWorker?: (config: {
		subAgent: ResolvedInternalSubAgentConfig;
		apiKey: string;
		tools: AgentTool<any>[];
	}) => SubAgentWorker;
	/** Test seam for failures while constructing the scoped tool set after durable registration. */
	buildTools?: BuildSubagentTools;
	/** Test-only override for the D6 convergence-turn wall clock; defaults to CONVERGENCE_WALL_CLOCK_MS. */
	convergenceWallClockMs?: number;
	/** Test-only override for the D2 sync grace window; defaults to SYNC_GRACE_MS. */
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
