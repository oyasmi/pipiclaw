import type { Api, Model } from "@mariozechner/pi-ai";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import type { Dirent } from "fs";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { findExactModelReferenceMatch, formatModelReference } from "./model-utils.js";
import { SUB_AGENTS_DIR_NAME } from "./paths.js";

const ALLOWED_SUB_AGENT_TOOLS = ["read", "bash", "edit", "write"] as const;
const DEFAULT_SUB_AGENT_TOOLS = ["read", "bash"] as const;
const DEFAULT_MAX_TURNS = 24;
const DEFAULT_MAX_TOOL_CALLS = 48;
const DEFAULT_MAX_WALL_TIME_SEC = 300;
const DEFAULT_BASH_TIMEOUT_SEC = 120;
const MAX_SUB_AGENT_TASK_CHARS = 12000;
const MAX_SUB_AGENT_SYSTEM_PROMPT_CHARS = 16000;
const ALLOWED_CONTEXT_MODES = ["isolated", "contextual"] as const;
const ALLOWED_MEMORY_MODES = ["none", "session", "relevant"] as const;

export type SubAgentToolName = (typeof ALLOWED_SUB_AGENT_TOOLS)[number];
export type SubAgentContextMode = (typeof ALLOWED_CONTEXT_MODES)[number];
export type SubAgentMemoryMode = (typeof ALLOWED_MEMORY_MODES)[number];

export interface SubAgentConfig {
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
	filePath?: string;
	source: "predefined" | "inline";
}

export interface ResolvedSubAgentConfig extends Omit<SubAgentConfig, "model" | "modelRef"> {
	model: Model<Api>;
	modelRef: string;
}

export interface SubAgentDiscoveryResult {
	directory: string;
	agents: SubAgentConfig[];
	warnings: string[];
}

export interface SubAgentInvocationOverrides {
	agent?: string;
	name?: string;
	systemPrompt?: string;
	tools?: string[];
	model?: string;
	maxTurns?: number;
	maxToolCalls?: number;
	maxWallTimeSec?: number;
	bashTimeoutSec?: number;
	contextMode?: string;
	memory?: string;
	paths?: string[];
}

function validateTextLength(value: string, maxChars: number, label: string): string | undefined {
	if (value.length <= maxChars) {
		return undefined;
	}
	return `${label} exceeds ${maxChars} characters (got ${value.length}).`;
}

export function validateSubAgentTask(task: string): string | undefined {
	return validateTextLength(task, MAX_SUB_AGENT_TASK_CHARS, "Sub-agent task");
}

function validateSubAgentSystemPrompt(systemPrompt: string, label: string): string | undefined {
	return validateTextLength(systemPrompt, MAX_SUB_AGENT_SYSTEM_PROMPT_CHARS, label);
}

export function getSubAgentsDir(workspaceDir: string): string {
	return join(workspaceDir, SUB_AGENTS_DIR_NAME);
}

function readOptionalTrimmedString(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}

	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

function parseToolNames(raw: unknown): { tools: SubAgentToolName[]; error?: string } {
	if (raw === undefined || raw === null) {
		return { tools: [...DEFAULT_SUB_AGENT_TOOLS] };
	}

	if (typeof raw === "string") {
		if (!raw.trim()) {
			return { tools: [...DEFAULT_SUB_AGENT_TOOLS] };
		}

		const values = raw
			.split(",")
			.map((value) => value.trim())
			.filter((value) => value.length > 0);

		return validateToolNames(values);
	}

	if (Array.isArray(raw)) {
		const invalidValue = raw.find((value) => typeof value !== "string");
		if (invalidValue !== undefined) {
			return { tools: [], error: 'Invalid "tools" frontmatter: expected a string or string[]' };
		}
		return validateToolNames(raw);
	}

	return { tools: [], error: 'Invalid "tools" frontmatter: expected a string or string[]' };
}

function parseStringList(raw: unknown, label: string): { values: string[]; error?: string } {
	if (raw === undefined || raw === null) {
		return { values: [] };
	}

	if (typeof raw === "string") {
		if (!raw.trim()) {
			return { values: [] };
		}

		return {
			values: Array.from(
				new Set(
					raw
						.split(",")
						.map((value) => value.trim())
						.filter((value) => value.length > 0),
				),
			),
		};
	}

	if (Array.isArray(raw)) {
		const invalidValue = raw.find((value) => typeof value !== "string");
		if (invalidValue !== undefined) {
			return { values: [], error: `Invalid "${label}" frontmatter: expected a string or string[]` };
		}

		return {
			values: Array.from(new Set(raw.map((value) => value.trim()).filter((value) => value.length > 0))),
		};
	}

	return { values: [], error: `Invalid "${label}" frontmatter: expected a string or string[]` };
}

function parseContextMode(raw: unknown): { value: SubAgentContextMode; error?: string } {
	const normalized = readOptionalTrimmedString(raw);
	if (!normalized) {
		return { value: "isolated" };
	}
	if (ALLOWED_CONTEXT_MODES.includes(normalized as SubAgentContextMode)) {
		return { value: normalized as SubAgentContextMode };
	}
	return {
		value: "isolated",
		error: `Unknown contextMode "${normalized}". Allowed values: ${ALLOWED_CONTEXT_MODES.join(", ")}`,
	};
}

function parseMemoryMode(
	raw: unknown,
	contextMode: SubAgentContextMode,
): { value: SubAgentMemoryMode; error?: string } {
	const normalized = readOptionalTrimmedString(raw);
	if (!normalized) {
		return { value: contextMode === "contextual" ? "relevant" : "none" };
	}
	if (ALLOWED_MEMORY_MODES.includes(normalized as SubAgentMemoryMode)) {
		return { value: normalized as SubAgentMemoryMode };
	}
	return {
		value: contextMode === "contextual" ? "relevant" : "none",
		error: `Unknown memory "${normalized}". Allowed values: ${ALLOWED_MEMORY_MODES.join(", ")}`,
	};
}

export function validateToolNames(values: string[] | undefined): { tools: SubAgentToolName[]; error?: string } {
	if (!values || values.length === 0) {
		return { tools: [...DEFAULT_SUB_AGENT_TOOLS] };
	}

	const tools: SubAgentToolName[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		const normalized = value.trim();
		if (!normalized || seen.has(normalized)) {
			continue;
		}
		if (!ALLOWED_SUB_AGENT_TOOLS.includes(normalized as SubAgentToolName)) {
			return {
				tools: [],
				error: `Unknown tool "${normalized}". Allowed tools: ${ALLOWED_SUB_AGENT_TOOLS.join(", ")}`,
			};
		}
		seen.add(normalized);
		tools.push(normalized as SubAgentToolName);
	}

	return { tools: tools.length > 0 ? tools : [...DEFAULT_SUB_AGENT_TOOLS] };
}

function parsePositiveInteger(raw: unknown, fallback: number): { value: number; warning?: string } {
	if (raw === undefined || raw === null) {
		return { value: fallback };
	}

	if (typeof raw === "number") {
		if (!Number.isFinite(raw) || raw <= 0) {
			return { value: fallback, warning: `Invalid numeric value "${String(raw)}", using default ${fallback}` };
		}
		return { value: Math.floor(raw) };
	}

	if (typeof raw !== "string") {
		return { value: fallback, warning: `Invalid numeric value "${String(raw)}", using default ${fallback}` };
	}

	if (!raw.trim()) {
		return { value: fallback };
	}

	const parsed = Number.parseInt(raw.trim(), 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return { value: fallback, warning: `Invalid numeric value "${raw}", using default ${fallback}` };
	}

	return { value: parsed };
}

function resolvePositiveOverride(value: number | undefined, fallback: number): number {
	if (!Number.isFinite(value) || value === undefined || value <= 0) {
		return fallback;
	}
	return Math.floor(value);
}

function resolveModelReference(
	modelRef: string,
	availableModels: Model<Api>[],
): { model?: Model<Api>; error?: string } {
	const { match, ambiguous } = findExactModelReferenceMatch(modelRef, availableModels);
	if (match) {
		return { model: match };
	}
	if (ambiguous) {
		return { error: `Model reference "${modelRef}" is ambiguous. Use provider/modelId.` };
	}
	return { error: `Model reference "${modelRef}" was not found among available models.` };
}

export function discoverSubAgents(workspaceDir: string, availableModels: Model<Api>[]): SubAgentDiscoveryResult {
	const directory = getSubAgentsDir(workspaceDir);
	if (!existsSync(directory)) {
		return { directory, agents: [], warnings: [] };
	}

	const warnings: string[] = [];
	const agents: SubAgentConfig[] = [];
	const seenNames = new Set<string>();
	let entries: Dirent<string>[];
	try {
		entries = readdirSync(directory, { withFileTypes: true })
			.filter((entry) => entry.name.endsWith(".md") && (entry.isFile() || entry.isSymbolicLink()))
			.sort((a, b) => a.name.localeCompare(b.name));
	} catch (error) {
		return {
			directory,
			agents: [],
			warnings: [`Failed to read sub-agents directory (${error instanceof Error ? error.message : String(error)})`],
		};
	}

	for (const entry of entries) {
		const filePath = join(directory, entry.name);
		let content = "";
		try {
			content = readFileSync(filePath, "utf-8");
		} catch (error) {
			warnings.push(
				`${entry.name}: failed to read file (${error instanceof Error ? error.message : String(error)})`,
			);
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
		const name = readOptionalTrimmedString(frontmatter.name);
		const description = readOptionalTrimmedString(frontmatter.description);

		if (!name || !description) {
			warnings.push(`${entry.name}: missing required frontmatter fields "name" or "description"`);
			continue;
		}

		if (seenNames.has(name)) {
			warnings.push(`${entry.name}: duplicate sub-agent name "${name}" ignored`);
			continue;
		}

		const toolParse = parseToolNames(frontmatter.tools);
		if (toolParse.error) {
			warnings.push(`${entry.name}: ${toolParse.error}`);
			continue;
		}

		const contextMode = parseContextMode(frontmatter.contextMode);
		if (contextMode.error) {
			warnings.push(`${entry.name}: ${contextMode.error}`);
			continue;
		}

		const memoryMode = parseMemoryMode(frontmatter.memory, contextMode.value);
		if (memoryMode.error) {
			warnings.push(`${entry.name}: ${memoryMode.error}`);
			continue;
		}

		const parsedPaths = parseStringList(frontmatter.paths, "paths");
		if (parsedPaths.error) {
			warnings.push(`${entry.name}: ${parsedPaths.error}`);
			continue;
		}

		const maxTurns = parsePositiveInteger(frontmatter.maxTurns, DEFAULT_MAX_TURNS);
		const maxToolCalls = parsePositiveInteger(frontmatter.maxToolCalls, DEFAULT_MAX_TOOL_CALLS);
		const maxWallTimeSec = parsePositiveInteger(frontmatter.maxWallTimeSec, DEFAULT_MAX_WALL_TIME_SEC);
		const bashTimeoutSec = parsePositiveInteger(frontmatter.bashTimeoutSec, DEFAULT_BASH_TIMEOUT_SEC);

		for (const warning of [maxTurns.warning, maxToolCalls.warning, maxWallTimeSec.warning, bashTimeoutSec.warning]) {
			if (warning) {
				warnings.push(`${entry.name}: ${warning}`);
			}
		}

		const modelRef = readOptionalTrimmedString(frontmatter.model);
		let model: Model<Api> | undefined;
		if (modelRef) {
			const resolved = resolveModelReference(modelRef, availableModels);
			if (!resolved.model) {
				warnings.push(`${entry.name}: ${resolved.error}`);
				continue;
			}
			model = resolved.model;
		}

		const trimmedBody = body.trim();
		if (!trimmedBody) {
			warnings.push(`${entry.name}: empty system prompt body`);
			continue;
		}
		const promptLengthError = validateSubAgentSystemPrompt(trimmedBody, "Sub-agent system prompt");
		if (promptLengthError) {
			warnings.push(`${entry.name}: ${promptLengthError}`);
			continue;
		}

		seenNames.add(name);
		agents.push({
			name,
			description,
			systemPrompt: trimmedBody,
			tools: toolParse.tools,
			model,
			modelRef: modelRef || (model ? formatModelReference(model) : undefined),
			maxTurns: maxTurns.value,
			maxToolCalls: maxToolCalls.value,
			maxWallTimeSec: maxWallTimeSec.value,
			bashTimeoutSec: bashTimeoutSec.value,
			contextMode: contextMode.value,
			memory: memoryMode.value,
			paths: parsedPaths.values,
			filePath,
			source: "predefined",
		});
	}

	return { directory, agents, warnings };
}

export function resolveSubAgentConfig(
	availableModels: Model<Api>[],
	currentModel: Model<Api>,
	predefinedAgents: SubAgentConfig[],
	overrides: SubAgentInvocationOverrides,
): { config?: ResolvedSubAgentConfig; error?: string } {
	const baseConfig = overrides.agent ? predefinedAgents.find((agent) => agent.name === overrides.agent) : undefined;
	if (overrides.agent && !baseConfig) {
		const available = predefinedAgents.length > 0 ? predefinedAgents.map((agent) => agent.name).join(", ") : "none";
		return { error: `Unknown sub-agent "${overrides.agent}". Available sub-agents: ${available}.` };
	}

	if (!baseConfig && (!overrides.systemPrompt || !overrides.systemPrompt.trim())) {
		return { error: 'Provide either "agent" or "systemPrompt" to define the sub-agent.' };
	}

	const tools = overrides.tools
		? validateToolNames(overrides.tools)
		: { tools: baseConfig?.tools ?? [...DEFAULT_SUB_AGENT_TOOLS] };
	if (tools.error) {
		return { error: tools.error };
	}

	let model = baseConfig?.model;
	let modelRef = baseConfig?.modelRef;
	if (overrides.model?.trim()) {
		const resolved = resolveModelReference(overrides.model.trim(), availableModels);
		if (!resolved.model) {
			return { error: resolved.error };
		}
		model = resolved.model;
		modelRef = formatModelReference(resolved.model);
	}

	const maxTurns = resolvePositiveOverride(overrides.maxTurns, baseConfig?.maxTurns ?? DEFAULT_MAX_TURNS);
	const maxToolCalls = resolvePositiveOverride(
		overrides.maxToolCalls,
		baseConfig?.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS,
	);
	const maxWallTimeSec = resolvePositiveOverride(
		overrides.maxWallTimeSec,
		baseConfig?.maxWallTimeSec ?? DEFAULT_MAX_WALL_TIME_SEC,
	);
	const bashTimeoutSec = resolvePositiveOverride(
		overrides.bashTimeoutSec,
		baseConfig?.bashTimeoutSec ?? DEFAULT_BASH_TIMEOUT_SEC,
	);
	const contextModeOverride = overrides.contextMode ? parseContextMode(overrides.contextMode) : undefined;
	if (contextModeOverride?.error) {
		return { error: contextModeOverride.error };
	}
	const contextMode = contextModeOverride?.value ?? baseConfig?.contextMode ?? "isolated";

	const memoryOverride = overrides.memory ? parseMemoryMode(overrides.memory, contextMode) : undefined;
	if (memoryOverride?.error) {
		return { error: memoryOverride.error };
	}
	const memory = memoryOverride?.value ?? baseConfig?.memory ?? (contextMode === "contextual" ? "relevant" : "none");

	const pathsOverride = overrides.paths ? parseStringList(overrides.paths, "paths") : undefined;
	if (pathsOverride?.error) {
		return { error: pathsOverride.error };
	}
	const paths = pathsOverride?.values ?? baseConfig?.paths ?? [];

	const systemPrompt = overrides.systemPrompt?.trim() || baseConfig?.systemPrompt || "";
	if (!systemPrompt) {
		return { error: "Sub-agent system prompt cannot be empty." };
	}
	if (overrides.systemPrompt?.trim()) {
		const promptLengthError = validateSubAgentSystemPrompt(
			overrides.systemPrompt.trim(),
			"Inline sub-agent systemPrompt",
		);
		if (promptLengthError) {
			return { error: promptLengthError };
		}
	}

	return {
		config: {
			name: overrides.name?.trim() || baseConfig?.name || "dynamic-subagent",
			description: baseConfig?.description || "Inline sub-agent",
			systemPrompt,
			tools: tools.tools,
			model: model ?? currentModel,
			modelRef: modelRef ?? formatModelReference(model ?? currentModel),
			maxTurns,
			maxToolCalls,
			maxWallTimeSec,
			bashTimeoutSec,
			contextMode,
			memory,
			paths,
			filePath: baseConfig?.filePath,
			source: baseConfig ? "predefined" : "inline",
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
