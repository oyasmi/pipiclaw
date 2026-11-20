/**
 * The `subagent` and `subagent_inline` tools (spec 046 D2.1): parameter schemas, validation that
 * the model can recover from, and the two tool factories. Resolution of the role or inline spec
 * happens here; dispatch and execution live in `subagents/dispatch.ts`.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { RecoverableToolError } from "../shared/recoverable-error.js";
import { dispatchSubAgentRun } from "../subagents/dispatch.js";
import {
	formatSubAgentList,
	resolveConfiguredRole,
	resolveInlineAgent,
	validateSubAgentTask,
} from "../subagents/resolve.js";
import type { SubAgentToolFields, SubAgentToolOptions } from "../subagents/types.js";

/** Shared by both invocation surfaces (spec 046, D2.1). */
const workingDirectoryField = Type.Optional(
	Type.String({
		description: "Existing absolute cwd; defaults to parent cwd. Does not isolate writes.",
	}),
);
const worktreeField = Type.Optional(
	Type.Boolean({
		description:
			"For write/work in Git: use an isolated runtime-managed worktree; result includes branch, headSha, changedFiles.",
	}),
);
const purposeField = Type.Optional(
	Type.Union([Type.Literal("work"), Type.Literal("verify")], {
		description: "verify: independent check, returns advisory VERDICT: PASS|FAIL; default work.",
	}),
);
const itemField = Type.Optional(
	Type.String({
		description: "Task step only: bind to this work item, e.g. W2.",
	}),
);

/**
 * Role-based delegation (spec 046, D2.1): the common path. No override fields beyond routing
 * ones — tools, model, effort, context, thinkingLevel and mutates all live in the role file, so
 * a call naming an external role cannot pass any of them (there is nowhere for it to put them).
 */
const subagentSchema = Type.Object({
	agent: Type.String({ description: "Name of a configured sub-agent from workspaceDir/sub-agents/" }),
	task: Type.String({ description: "Outcome, verified facts, constraints, paths and acceptance criteria." }),
	workingDirectory: workingDirectoryField,
	worktree: worktreeField,
	purpose: purposeField,
	item: itemField,
});

/**
 * Inline delegation (spec 046, D2.1): a one-off executor for when no configured role fits.
 * Carries every field a role file would otherwise supply.
 */
const subagentInlineSchema = Type.Object({
	task: Type.String({ description: "Self-contained goal, inputs, constraints and acceptance criteria." }),
	systemPrompt: Type.String({ description: "Instructions for this one-off worker." }),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Tool whitelist." })),
	model: Type.Optional(Type.String({ description: "Exact model reference; defaults to parent model." })),
	effort: Type.Optional(
		Type.Union([Type.Literal("quick"), Type.Literal("standard"), Type.Literal("deep")], {
			description: "Budget preset for turns, tool calls and wall time; default standard.",
		}),
	),
	context: Type.Optional(
		Type.Union([Type.Literal("none"), Type.Literal("index")], {
			description: "none (default): isolated; index: workspace background, desk memory index and journal tail.",
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
				description: "Reasoning effort.",
			},
		),
	),
	mutates: Type.Optional(
		Type.Union([Type.Literal("read"), Type.Literal("write")], {
			description: "Use write if any writes are possible, including through bash; controls workspace lease.",
		}),
	),
	workingDirectory: workingDirectoryField,
	worktree: worktreeField,
	purpose: purposeField,
	item: itemField,
});

const subagentChatSchema = Type.Omit(subagentSchema, ["item"]);
const subagentInlineChatSchema = Type.Omit(subagentInlineSchema, ["item"]);

/** The shape consumers read post-wrap, once `withToolDetails` has stamped `kind`. */
export type SubAgentToolDetails = SubAgentToolFields & { kind: "subagent" | "subagent_inline" };

export function createSubAgentTool(
	options: SubAgentToolOptions,
): AgentTool<typeof subagentSchema | typeof subagentChatSchema, SubAgentToolFields> {
	return {
		name: "subagent",
		label: "subagent",
		description:
			"Dispatch a matching configured role directly for a clear task in one directory, e.g. give a read-only scout one file and a question. Read agent-delegation.md for parallel writes, worktrees, purpose=verify, uncertain image support or multi-agent coordination.",
		parameters: options.boundTaskId ? subagentSchema : subagentChatSchema,
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
			const invocation = resolveConfiguredRole(
				availableModels,
				currentModel,
				discovery.agents,
				{ agent: params.agent, purpose: params.purpose },
				options.getSubAgentModelReference?.() ?? undefined,
			);
			if (!invocation.config) {
				throw new RecoverableToolError(
					`${invocation.error}\n\nAvailable configured sub-agents:\n${formatSubAgentList(discovery.agents)}`,
				);
			}
			return dispatchSubAgentRun(options, currentModel, invocation.config, undefined, params, signal, onUpdate);
		},
	};
}

export function createSubAgentInlineTool(
	options: SubAgentToolOptions,
): AgentTool<typeof subagentInlineSchema | typeof subagentInlineChatSchema, SubAgentToolFields> {
	return {
		name: "subagent_inline",
		label: "subagent_inline",
		description:
			"Fallback only when no configured role fits; otherwise use subagent. Supply task and systemPrompt. Before inline setup, read delegation-inline.md under the Runtime Guides directory.",
		parameters: options.boundTaskId ? subagentInlineSchema : subagentInlineChatSchema,
		execute: async (_toolCallId, params, signal, onUpdate) => {
			if (signal?.aborted) {
				throw new Error("Sub-agent aborted");
			}
			const availableModels = options.getAvailableModels();
			const currentModel = options.getCurrentModel();
			const taskLengthError = validateSubAgentTask(params.task);
			if (taskLengthError) {
				throw new RecoverableToolError(taskLengthError);
			}
			const invocation = resolveInlineAgent(
				availableModels,
				currentModel,
				{
					systemPrompt: params.systemPrompt,
					tools: params.tools,
					model: params.model,
					effort: params.effort,
					context: params.context,
					thinkingLevel: params.thinkingLevel,
					mutates: params.mutates,
					purpose: params.purpose,
				},
				options.getSubAgentModelReference?.() ?? undefined,
			);
			if (!invocation.config) {
				throw new RecoverableToolError(invocation.error ?? "Unable to resolve inline sub-agent.");
			}
			return dispatchSubAgentRun(
				options,
				currentModel,
				invocation.config,
				invocation.warning,
				params,
				signal,
				onUpdate,
			);
		},
	};
}
