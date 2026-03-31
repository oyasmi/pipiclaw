import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@mariozechner/pi-agent-core";
import type { Api, AssistantMessage, Model, TextContent } from "@mariozechner/pi-ai";
import { convertToLlm } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { formatModelReference } from "../model-utils.js";
import type { Executor } from "../sandbox.js";
import {
	formatSubAgentList,
	type ResolvedSubAgentConfig,
	resolveSubAgentConfig,
	type SubAgentConfig,
	type SubAgentDiscoveryResult,
	validateSubAgentTask,
} from "../sub-agents.js";
import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";

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
});

interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

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
}

export interface SubAgentToolOptions {
	executor: Executor;
	getCurrentModel: () => Model<Api>;
	getAvailableModels: () => Model<Api>[];
	resolveApiKey: (model: Model<Api>) => Promise<string>;
	workspaceDir: string;
	getSubAgentDiscovery?: () => SubAgentDiscoveryResult;
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

function extractAssistantText(message: AssistantMessage): string {
	return message.content
		.filter((part): part is Extract<AssistantMessage["content"][number], TextContent> => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
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

function extractLabelFromArgs(args: unknown): string | null {
	if (!args || typeof args !== "object" || !("label" in args)) {
		return null;
	}
	const label = (args as { label?: unknown }).label;
	return typeof label === "string" && label.trim() ? label.trim() : null;
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

function createToolSet(executor: Executor, bashTimeoutSec: number): AgentTool<any>[] {
	return [
		createReadTool(executor),
		createBashTool(executor, { defaultTimeoutSeconds: bashTimeoutSec }),
		createEditTool(executor),
		createWriteTool(executor),
	];
}

function buildSubAgentTask(
	task: string,
	config: ResolvedSubAgentConfig,
	runtimeContext: SubAgentToolOptions["runtimeContext"],
): string {
	const taskText = task.trim();
	return `Runtime context:
- Workspace root: ${runtimeContext.workspacePath}
- Channel id: ${runtimeContext.channelId}
- Channel directory: ${runtimeContext.workspacePath}/${runtimeContext.channelId}
- Sandbox: ${runtimeContext.sandbox}
- Filesystem isolation: none (files written here are visible to the parent agent)
- Your configured role: ${config.name}

Task:
${taskText}`;
}

function filterToolsByName(allTools: AgentTool<any>[], names: string[]): AgentTool<any>[] {
	const allowed = new Set(names);
	return allTools.filter((tool) => allowed.has(tool.name));
}

function createDetails(
	config: ResolvedSubAgentConfig,
	usage: UsageTotals,
	turns: number,
	toolCalls: number,
	durationMs: number,
	failed: boolean,
	failureReason?: string,
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
						usage,
						assistantTurns,
						toolCalls,
						Date.now() - startedAt,
						Boolean(failureReason),
						failureReason,
					),
				});
			};

			const worker =
				options.createWorker?.({
					subAgent: config,
					apiKey,
					tools: filterToolsByName(createToolSet(options.executor, config.bashTimeoutSec), config.tools),
				}) ??
				new Agent({
					initialState: {
						systemPrompt: config.systemPrompt,
						model: config.model,
						thinkingLevel: "off",
						tools: filterToolsByName(createToolSet(options.executor, config.bashTimeoutSec), config.tools),
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
					await worker.prompt(buildSubAgentTask(params.task, config, options.runtimeContext));
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
						usage,
						assistantTurns,
						toolCalls,
						durationMs,
						true,
						effectiveFailureReason,
					),
				};
			}

			return {
				content: [{ type: "text", text: finalText || `(Sub-agent ${config.name} completed with no text output)` }],
				details: createDetails(config, usage, assistantTurns, toolCalls, durationMs, false),
			};
		},
	};
}
