/**
 * The `subagent` and `subagent_inline` tools (spec 046 D2.1): parameter schemas, validation that
 * the model can recover from, and the two tool factories. Resolution of the role or inline spec
 * happens here; dispatch and execution live in `subagents/dispatch.ts`.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { RecoverableToolError } from "../shared/recoverable-error.js";
import {
	formatSubAgentList,
	resolveConfiguredRole,
	resolveInlineAgent,
	validateSubAgentTask,
} from "../subagents/discovery.js";
import { dispatchSubAgentRun } from "../subagents/dispatch.js";
import type { SubAgentToolFields, SubAgentToolOptions } from "../subagents/types.js";

/** Shared by both invocation surfaces (spec 046, D2.1). */
const workingDirectoryField = Type.Optional(
	Type.String({
		description:
			"Optional existing directory to run the sub-agent in (its shell cwd and relative-path root). Use it to work on another checkout — e.g. a `git worktree add`ed one. Defaults to this runtime's own working directory.",
	}),
);
const purposeField = Type.Optional(
	Type.Union([Type.Literal("work"), Type.Literal("verify")], {
		description:
			'Use "verify" for an independent check: the sub-agent is given the checker protocol and ends with VERDICT: PASS|FAIL. The verdict is information for you to weigh, not a gate.',
	}),
);
const taskIdField = Type.Optional(
	Type.String({
		description:
			"Persistent task this work belongs to. Inside a task session it is bound automatically — omit it. In chat, pass it to have the result recorded on that task's board.",
	}),
);
const itemField = Type.Optional(
	Type.String({
		description:
			'The task\'s Work Item this delegation is for, e.g. "W2". Requires a task (bound automatically in a task session).',
	}),
);

/**
 * Role-based delegation (spec 046, D2.1): the common path. No override fields beyond routing
 * ones — tools, model, effort, context, thinkingLevel and mutates all live in the role file, so
 * a call naming an external role cannot pass any of them (there is nowhere for it to put them).
 */
const subagentSchema = Type.Object({
	agent: Type.String({ description: "Name of a configured sub-agent from workspaceDir/sub-agents/" }),
	task: Type.String({ description: "Complete task description for the sub-agent" }),
	workingDirectory: workingDirectoryField,
	purpose: purposeField,
	taskId: taskIdField,
	item: itemField,
});

/**
 * Inline delegation (spec 046, D2.1): a one-off executor for when no configured role fits.
 * Carries every field a role file would otherwise supply.
 */
const subagentInlineSchema = Type.Object({
	task: Type.String({ description: "Complete task description for the sub-agent" }),
	systemPrompt: Type.String({ description: "System prompt defining this one-off sub-agent's identity and task." }),
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
		Type.Union([Type.Literal("none"), Type.Literal("index")], {
			description:
				'What context to inject. "none" (default) runs fully isolated; "index" adds the workspace background, the dot memory index, and today\'s journal tail.',
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
				description: "Optional reasoning effort for the sub-agent.",
			},
		),
	),
	mutates: Type.Optional(
		Type.Union([Type.Literal("read"), Type.Literal("write")], {
			description:
				'Whether this delegation will modify the working directory. Declare "write" whenever the sub-agent may write ' +
				"files (including through bash) so it takes the exclusive workspace write lease.",
		}),
	),
	workingDirectory: workingDirectoryField,
	purpose: purposeField,
	taskId: taskIdField,
	item: itemField,
});

/** The shape consumers read post-wrap, once `withToolDetails` has stamped `kind`. */
export type SubAgentToolDetails = SubAgentToolFields & { kind: "subagent" | "subagent_inline" };

export function createSubAgentTool(options: SubAgentToolOptions): AgentTool<typeof subagentSchema, SubAgentToolFields> {
	return {
		name: "subagent",
		label: "subagent",
		description:
			"Delegate a task to a configured sub-agent (see the Sub-Agents directory in the system prompt). Prefer this over `subagent_inline` whenever a role fits — its tools, model, budget and context policy all come from the role file. Sub-agents never receive the subagent tool, so they cannot create nested agents.",
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
): AgentTool<typeof subagentInlineSchema, SubAgentToolFields> {
	return {
		name: "subagent_inline",
		label: "subagent_inline",
		description:
			"Advanced fallback only, not the default: use `subagent` first whenever any configured role in the workspace `sub-agents/` can do the work. `subagent` is the normal role-based path: pass its `agent` and complete `task`; the role file supplies the tools, model, budget and context policy. Use `subagent_inline` only when no configured role is suitable. It is a raw one-shot meta-executor, not a shorthand for `subagent`: there is no role file to supply those settings. Build a complete valid inline call yourself — `task` and `systemPrompt` are required; choose valid values for any needed `tools`, `model`, `effort`, `context`, `thinkingLevel`, `mutates`, `workingDirectory`, `purpose` and `taskId` fields. Do not send a partial role-style payload or choose this tool just because it is available. Sub-agents never receive the subagent tool, so they cannot create nested agents.",
		parameters: subagentInlineSchema,
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
