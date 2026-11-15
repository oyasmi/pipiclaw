/**
 * Call-time invocation resolution for `subagent` (role-based) and `subagent_inline` (spec 046
 * D2.1), plus delegation task-length validation and available-role formatting. Kept separate from
 * `discovery.ts` so tool-call execution and inline workers do not couple to filesystem role scanning.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import { formatModelReference } from "../models/reference.js";
import {
	inferMutatesFromTools,
	parseEnumField,
	readOptionalTrimmedString,
	resolveModelReference,
	validateSubAgentSystemPrompt,
	validateToolNames,
} from "./discovery.js";
import { getExternalHarness } from "./external/registry.js";
import { ALLOWED_THINKING_LEVELS } from "./run-record.js";
import {
	ALLOWED_MUTATES,
	DEFAULT_BASH_TIMEOUT_SEC,
	DEFAULT_MAX_TOOL_CALLS,
	DEFAULT_MAX_TURNS,
	DEFAULT_MAX_WALL_TIME_SEC,
	DEFAULT_SUB_AGENT_TOOLS,
	DEFAULT_THINKING_LEVEL,
	type ResolvedInternalSubAgentConfig,
	type ResolvedSubAgentConfig,
	type SubAgentConfig,
	type SubAgentContextMode,
	type SubAgentMemoryMode,
} from "./types.js";

const MAX_SUB_AGENT_TASK_CHARS = 12000;

/**
 * Execution budgets as a single named tuple. Frontmatter keeps the four numeric knobs
 * (a human editing a config file has grounds to pick numbers); the invocation surface
 * only offers these presets, because a model choosing `maxToolCalls` per delegation is
 * guessing. `standard` is byte-identical to the DEFAULT_* values, so omitting `effort`
 * leaves behavior unchanged.
 */
const SUB_AGENT_EFFORT_PRESETS = {
	quick: { maxTurns: 8, maxToolCalls: 16, maxWallTimeSec: 120, bashTimeoutSec: 60 },
	standard: {
		maxTurns: DEFAULT_MAX_TURNS,
		maxToolCalls: DEFAULT_MAX_TOOL_CALLS,
		maxWallTimeSec: DEFAULT_MAX_WALL_TIME_SEC,
		bashTimeoutSec: DEFAULT_BASH_TIMEOUT_SEC,
	},
	deep: { maxTurns: 64, maxToolCalls: 160, maxWallTimeSec: 1800, bashTimeoutSec: 300 },
} as const;

type SubAgentEffort = keyof typeof SUB_AGENT_EFFORT_PRESETS;
const ALLOWED_EFFORTS = Object.keys(SUB_AGENT_EFFORT_PRESETS) as SubAgentEffort[];

/**
 * The invocation-side spelling of `contextMode` + `memory`. Those two frontmatter knobs
 * encode only four meaningful states (`isolated` implies `memory: none`), so the calling
 * surface collapses them into one enum.
 */
const ALLOWED_CONTEXT_CHOICES = ["none", "index"] as const;
type SubAgentContextChoice = (typeof ALLOWED_CONTEXT_CHOICES)[number];

/**
 * `subagent` (role-based) invocation surface (spec 046, D2.1). Deliberately has no override
 * fields beyond `purpose`: everything else a configured role could vary lives in the role file.
 */
interface ConfiguredRoleOverrides {
	agent: string;
	/** Drives the thinkingLevel default: "verify" defaults on, everything else stays off. */
	purpose?: string;
}

/**
 * `subagent_inline` invocation surface (spec 046, D2.1) — a one-off executor with no role file,
 * so every field a role file would otherwise supply is a call-time override here instead.
 */
interface InlineAgentOverrides {
	systemPrompt: string;
	tools?: string[];
	model?: string;
	/** Named budget preset; wins over frontmatter numbers as a whole tuple, never field by field. */
	effort?: string;
	/** Collapsed `contextMode` + `memory`. */
	context?: string;
	thinkingLevel?: string;
	/** Drives the thinkingLevel default: "verify" defaults on, everything else stays off. */
	purpose?: string;
	mutates?: string;
}

export function validateSubAgentTask(task: string): string | undefined {
	if (task.length <= MAX_SUB_AGENT_TASK_CHARS) {
		return undefined;
	}
	return `Sub-agent task exceeds ${MAX_SUB_AGENT_TASK_CHARS} characters (got ${task.length}).`;
}

function parseContextChoice(raw: unknown): {
	value?: { contextMode: SubAgentContextMode; memory: SubAgentMemoryMode };
	error?: string;
} {
	const normalized = readOptionalTrimmedString(raw);
	if (!normalized) {
		return {};
	}
	if (!ALLOWED_CONTEXT_CHOICES.includes(normalized as SubAgentContextChoice)) {
		return {
			error: `Unknown context "${normalized}". Allowed values: ${ALLOWED_CONTEXT_CHOICES.join(", ")}`,
		};
	}
	if (normalized === "none") {
		return { value: { contextMode: "isolated", memory: "none" } };
	}
	return { value: { contextMode: "contextual", memory: normalized as SubAgentMemoryMode } };
}

/**
 * Resolve a `subagent` (role-based) invocation (spec 046, D2.1).
 */
export function resolveConfiguredRole(
	availableModels: Model<Api>[],
	currentModel: Model<Api>,
	predefinedAgents: SubAgentConfig[],
	overrides: ConfiguredRoleOverrides,
	/** `settings.subagentModel` (spec 032 D5): used only when the role file's frontmatter omits `model`. */
	subagentDefaultModelRef?: string,
): { config?: ResolvedSubAgentConfig; error?: string } {
	const baseConfig = predefinedAgents.find((agent) => agent.name === overrides.agent);
	if (!baseConfig) {
		const available = predefinedAgents.length > 0 ? predefinedAgents.map((agent) => agent.name).join(", ") : "none";
		return { error: `Unknown sub-agent "${overrides.agent}". Available sub-agents: ${available}.` };
	}
	if (baseConfig.unavailable) {
		return { error: `Sub-agent "${baseConfig.name}" is currently unavailable: ${baseConfig.unavailable}` };
	}

	if (baseConfig.runtime === "external") {
		const verifyDefault = getExternalHarness(baseConfig.harness)?.supportsImplicitVerifyThinking
			? DEFAULT_THINKING_LEVEL
			: undefined;
		return {
			config: {
				...baseConfig,
				thinkingLevel: baseConfig.thinkingLevel ?? (overrides.purpose === "verify" ? verifyDefault : undefined),
			},
		};
	}

	let model = baseConfig.model;
	let modelRef = baseConfig.modelRef;
	if (!model && subagentDefaultModelRef) {
		const resolved = resolveModelReference(subagentDefaultModelRef, availableModels);
		if (!resolved.model) {
			return { error: resolved.error };
		}
		model = resolved.model;
		modelRef = formatModelReference(resolved.model);
	}

	const thinkingLevel = baseConfig.thinkingLevel ?? DEFAULT_THINKING_LEVEL;
	const mutates = baseConfig.mutates ?? inferMutatesFromTools(baseConfig.tools);

	return {
		config: {
			...baseConfig,
			model: model ?? currentModel,
			modelRef: modelRef ?? formatModelReference(model ?? currentModel),
			thinkingLevel,
			source: "predefined",
			mutates,
		},
	};
}

/**
 * Resolve a `subagent_inline` invocation (spec 046, D2.1) — a one-off internal executor with no
 * role file.
 */
export function resolveInlineAgent(
	availableModels: Model<Api>[],
	currentModel: Model<Api>,
	overrides: InlineAgentOverrides,
	/** `settings.subagentModel` (spec 032 D5): used only when this call does not name a model. */
	subagentDefaultModelRef?: string,
): { config?: ResolvedInternalSubAgentConfig; error?: string; warning?: string } {
	const systemPrompt = overrides.systemPrompt.trim();
	if (!systemPrompt) {
		return { error: "Sub-agent system prompt cannot be empty." };
	}
	const promptLengthError = validateSubAgentSystemPrompt(systemPrompt, "Inline sub-agent systemPrompt");
	if (promptLengthError) {
		return { error: promptLengthError };
	}

	const tools = overrides.tools ? validateToolNames(overrides.tools) : { tools: [...DEFAULT_SUB_AGENT_TOOLS] };
	if (tools.error) {
		return { error: tools.error };
	}

	let model: Model<Api> | undefined;
	let modelRef: string | undefined;
	if (overrides.model?.trim()) {
		const resolved = resolveModelReference(overrides.model.trim(), availableModels);
		if (!resolved.model) {
			return { error: resolved.error };
		}
		model = resolved.model;
		modelRef = formatModelReference(resolved.model);
	} else if (subagentDefaultModelRef) {
		const resolved = resolveModelReference(subagentDefaultModelRef, availableModels);
		if (!resolved.model) {
			return { error: resolved.error };
		}
		model = resolved.model;
		modelRef = formatModelReference(resolved.model);
	}

	const effortOverride = parseEnumField(overrides.effort, "effort", ALLOWED_EFFORTS);
	if (effortOverride.error) {
		return { error: effortOverride.error };
	}
	const budget = effortOverride.value
		? SUB_AGENT_EFFORT_PRESETS[effortOverride.value]
		: {
				maxTurns: DEFAULT_MAX_TURNS,
				maxToolCalls: DEFAULT_MAX_TOOL_CALLS,
				maxWallTimeSec: DEFAULT_MAX_WALL_TIME_SEC,
				bashTimeoutSec: DEFAULT_BASH_TIMEOUT_SEC,
			};

	const contextOverride = parseContextChoice(overrides.context);
	if (contextOverride.error) {
		return { error: contextOverride.error };
	}
	const contextMode = contextOverride.value?.contextMode ?? "isolated";
	const memory = contextOverride.value?.memory ?? (contextMode === "contextual" ? "index" : "none");

	const thinkingLevelOverride = overrides.thinkingLevel
		? parseEnumField(overrides.thinkingLevel, "thinkingLevel", ALLOWED_THINKING_LEVELS)
		: undefined;
	if (thinkingLevelOverride?.error) {
		return { error: thinkingLevelOverride.error };
	}
	const thinkingLevel = thinkingLevelOverride?.value ?? DEFAULT_THINKING_LEVEL;

	const mutatesOverride = parseEnumField(overrides.mutates, "mutates", ALLOWED_MUTATES);
	if (mutatesOverride.error) {
		return { error: mutatesOverride.error };
	}
	const mutates = mutatesOverride.value ?? inferMutatesFromTools(tools.tools);
	const bashWithoutMutatesWarning =
		tools.tools.includes("bash") && mutatesOverride.value === undefined
			? 'tools include bash but "mutates" is not declared; if this task writes to the workspace, pass mutates: "write" so it takes the exclusive workspace write lease'
			: undefined;

	return {
		warning: bashWithoutMutatesWarning,
		config: {
			name: "dynamic-subagent",
			description: "Inline sub-agent",
			systemPrompt,
			tools: tools.tools,
			model: model ?? currentModel,
			modelRef: modelRef ?? formatModelReference(model ?? currentModel),
			maxTurns: budget.maxTurns,
			maxToolCalls: budget.maxToolCalls,
			maxWallTimeSec: budget.maxWallTimeSec,
			bashTimeoutSec: budget.bashTimeoutSec,
			contextMode,
			memory,
			paths: [],
			thinkingLevel,
			source: "inline",
			runtime: "internal",
			mutates,
		},
	};
}

export function formatSubAgentList(agents: SubAgentConfig[], maxItems: number = 12): string {
	if (agents.length === 0) {
		return "none";
	}
	const listed = agents.slice(0, maxItems).map((agent) => `- \`${agent.name}\`: ${agent.description}`);
	if (agents.length <= maxItems) {
		return listed.join("\n");
	}
	return `${listed.join("\n")}\n- ... and ${agents.length - maxItems} more`;
}
