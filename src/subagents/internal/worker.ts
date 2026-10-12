/**
 * The worker of an internal run: its directory-pinned executor, its scoped tool set, creation of the
 * SDK agent, and the event subscription that counts turns and tool calls and enforces the budgets.
 */
import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { clampThinkingLevel, streamSimple } from "@earendil-works/pi-ai/compat";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { ExecOptions, ExecResult, Executor } from "../../executor.js";
import { getJournalDir } from "../../memory/journal.js";
import { getChannelMemoryDir, getChannelMemoryIndexPath } from "../../memory/store.js";
import { DEFAULT_SECURITY_CONFIG } from "../../security/config.js";
import type { SecurityConfig } from "../../security/types.js";
import { describeToolCall } from "../../tools/contract/presentation.js";
import { addUsage } from "../../usage/totals.js";
import {
	DEFAULT_THINKING_LEVEL,
	type ResolvedInternalSubAgentConfig,
	withSubAgentsDirWriteDeny,
} from "../discovery.js";
import { formatStatus } from "../result.js";
import type { SubAgentRunManager } from "../runs.js";
import type { SubAgentRunContext, SubAgentToolOptions, SubAgentWorker } from "../types.js";
import type { InternalRunState } from "./state.js";

/**
 * Pins every command a run issues to the run's working directory. It sets the child's real `cwd`
 * rather than prefixing `cd <dir> &&`: the prefix silently produced a *different* command than the
 * guard inspected, and a directory that cannot be entered surfaced as a shell error inside an
 * otherwise successful command line.
 */
export class DirectoryExecutor implements Executor {
	constructor(
		private readonly base: Executor,
		private readonly directory: string,
	) {}

	exec(command: string, options?: ExecOptions): Promise<ExecResult> {
		return this.base.exec(command, { ...options, cwd: this.directory });
	}
}

export function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return typeof message === "object" && message !== null && "role" in message && message.role === "assistant";
}

export function getLastAssistantMessage(messages: AgentMessage[]): AssistantMessage | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (isAssistantMessage(message)) {
			return message;
		}
	}
	return null;
}

/**
 * Sub-agents share the main agent's `write`/`edit` tools but only receive the runtime
 * context (task text), never the "the MEMORY.md index is generated, write memory only through
 * memory_save" rule the main agent gets in its system prompt (the memory tools themselves are
 * withheld from sub-agents). Denying these paths at the path-guard level closes that gap
 * structurally instead of relying on a sub-agent to infer an instruction it never received — a
 * stray write/edit here would race the shared memory serial queue (channel-maintenance-queue)
 * and silently corrupt durable memory.
 */
function withSubagentMemoryWriteDeny(
	securityConfig: SecurityConfig,
	channelDir: string,
	workspaceDir: string,
): SecurityConfig {
	const protectedPaths = [
		getChannelMemoryDir(channelDir),
		getJournalDir(channelDir),
		getChannelMemoryIndexPath(channelDir),
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
 * Build a sub-agent's tool set through the injected `buildWorkerTools` (the registry's sub-agent
 * whitelist: files + web), with its own security context and per-invocation bash timeout.
 */
export function buildSubagentTools(
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
	return options
		.buildWorkerTools({
			executor,
			fileStore: options.fileStore,
			securityConfig,
			securityContext: {
				// No `channelDir`: a sub-agent receives channel state through its injected context
				// blocks, not by reading the channel's own files, so it does not inherit the parent's
				// channel-directory exception (see security/types.ts).
				agentWorkspaceDir: options.workspaceDir,
				projectRoot: runContext.workingDirectory,
				boundary: options.projectBoundary,
			},
			channelId: options.runtimeContext.channelId,
			channelDir: options.channelDir,
			workspaceDir: options.workspaceDir,
			webConfig: options.webConfig,
			rtkEnabled: options.rtkEnabled,
			bashDefaultTimeoutSeconds: bashTimeoutSec,
		})
		.filter((tool) => runContext.purpose !== "verify" || (tool.name !== "write" && tool.name !== "edit"));
}

function filterToolsByName(allTools: AgentTool<any>[], names: string[]): AgentTool<any>[] {
	const allowed = new Set(names);
	return allTools.filter((tool) => allowed.has(tool.name));
}

/** What `startWorker` fills in as it goes, so a failure part-way still leaves the cleanup its handles. */
export interface WorkerHandle {
	worker?: SubAgentWorker;
	unsubscribe?: () => void;
	wallClockTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Build the scoped tool set, create the worker, arm the wall-clock budget and subscribe to its
 * events. Everything is recorded on `handle` immediately, before the next step can throw.
 */
export function startWorker(input: {
	handle: WorkerHandle;
	options: SubAgentToolOptions;
	config: ResolvedInternalSubAgentConfig;
	runContext: SubAgentRunContext;
	scopedExecutor: Executor;
	state: InternalRunState;
	retryBackoff: AbortController;
	runManager: SubAgentRunManager;
	emitUpdate: (text: string) => void;
}): void {
	const { handle, options, config, runContext, scopedExecutor, state, retryBackoff, runManager, emitUpdate } = input;
	const availableTools = (options.buildTools ?? buildSubagentTools)(
		scopedExecutor,
		config.bashTimeoutSec,
		options,
		runContext,
	);

	handle.worker =
		options.createWorker?.({
			subAgent: config,
			apiKey: state.apiKey,
			tools: filterToolsByName(availableTools, config.tools),
		}) ??
		new Agent({
			initialState: {
				systemPrompt: config.systemPrompt,
				model: config.model,
				// Same clamp the main agent applies (channel-runner.ts) before setting a model's
				// thinkingLevel: a model with `reasoning: false` gets "off", an unsupported tier
				// snaps to the nearest one, instead of a raw unsupported value reaching the provider.
				// The internal path's resolved config always fills thinkingLevel; the fallback
				// here only closes the type.
				thinkingLevel: clampThinkingLevel(config.model, config.thinkingLevel ?? DEFAULT_THINKING_LEVEL),
				tools: filterToolsByName(availableTools, config.tools),
			},
			convertToLlm,
			// Read on every request, so a backup-model switch only has to replace the key.
			getApiKey: async () => state.apiKey,
			streamFn: streamSimple,
		});

	handle.wallClockTimer = setTimeout(() => {
		state.failureReason = `Wall time budget exceeded (${config.maxWallTimeSec}s)`;
		state.budgetExceeded = true;
		retryBackoff.abort();
		handle.worker?.abort();
	}, config.maxWallTimeSec * 1000);

	handle.unsubscribe = handle.worker.subscribe((event: AgentEvent) => {
		if (event.type === "message_end" && isAssistantMessage(event.message)) {
			state.assistantTurns++;
			addUsage(state.usage, event.message.usage);
		}

		if (event.type === "tool_execution_start") {
			state.toolCalls++;
			const label = describeToolCall(event.toolName, event.args);
			emitUpdate(formatStatus(config.name, label));
			// After detaching, the step goes out as a paced run notice instead, like an external
			// run's progress tail — otherwise an async internal run is silent until it settles.
			if (state.detached) runManager.noteProgress(runContext.runId, label);
			if (state.toolCalls > config.maxToolCalls) {
				state.failureReason = `Tool call budget exceeded (${config.maxToolCalls})`;
				state.budgetExceeded = true;
				emitUpdate(formatStatus(config.name, "tool budget reached"));
				handle.worker?.abort();
			}
		}

		if (
			event.type === "turn_end" &&
			isAssistantMessage(event.message) &&
			event.toolResults.length > 0 &&
			state.assistantTurns >= config.maxTurns
		) {
			state.failureReason = `Turn budget exceeded (${config.maxTurns})`;
			state.budgetExceeded = true;
			emitUpdate(formatStatus(config.name, "turn budget reached"));
			handle.worker?.abort();
		}
	});

	emitUpdate(formatStatus(config.name, "started"));
}
