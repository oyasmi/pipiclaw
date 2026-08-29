import { createHash } from "node:crypto";
import { existsSync as existsSyncFs } from "node:fs";
import { join as joinPath, delimiter as pathDelimiter } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { Dirent } from "fs";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { findExactModelReferenceMatch, formatModelReference } from "../models/utils.js";
import { SUB_AGENTS_DIR_NAME } from "../paths.js";
import type { SecurityConfig } from "../security/types.js";
import { splitShellWords } from "../shared/shell-words.js";
import { errorMessage } from "../shared/text-utils.js";

const ALLOWED_SUB_AGENT_TOOLS = ["read", "grep", "bash", "edit", "write", "web_search", "web_fetch"] as const;
const DEFAULT_SUB_AGENT_TOOLS = ["read", "bash"] as const;
const DEFAULT_MAX_TURNS = 32;
const DEFAULT_MAX_TOOL_CALLS = 96;
const DEFAULT_MAX_WALL_TIME_SEC = 600;
const DEFAULT_BASH_TIMEOUT_SEC = 120;
/** External runs have no turn/tool-call budget (D5); wall time is their only lever. */
const DEFAULT_EXTERNAL_MAX_WALL_TIME_SEC = 3600;
const MAX_SUB_AGENT_TASK_CHARS = 12000;
const MAX_SUB_AGENT_SYSTEM_PROMPT_CHARS = 16000;
const ALLOWED_CONTEXT_MODES = ["isolated", "contextual"] as const;
const ALLOWED_MEMORY_MODES = ["none", "session", "relevant"] as const;
// "max" is a real SDK ThinkingLevel; pipiclaw's own whitelist previously omitted it (spec 040, D4).
const ALLOWED_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const ALLOWED_RUNTIMES = ["internal", "external"] as const;
const ALLOWED_HARNESSES = ["claude-code", "codex-cli", "exec"] as const;
const ALLOWED_WORKLOADS = ["light", "heavy"] as const;
const ALLOWED_MUTATES = ["read", "write"] as const;

export type SubAgentToolName = (typeof ALLOWED_SUB_AGENT_TOOLS)[number];
export type SubAgentContextMode = (typeof ALLOWED_CONTEXT_MODES)[number];
export type SubAgentMemoryMode = (typeof ALLOWED_MEMORY_MODES)[number];
export type SubAgentThinkingLevel = (typeof ALLOWED_THINKING_LEVELS)[number];
export type SubAgentRuntime = (typeof ALLOWED_RUNTIMES)[number];
export type SubAgentHarness = (typeof ALLOWED_HARNESSES)[number];
export type SubAgentWorkload = (typeof ALLOWED_WORKLOADS)[number];
export type SubAgentMutates = (typeof ALLOWED_MUTATES)[number];

/**
 * Execution budgets as a single named tuple. Frontmatter keeps the four numeric knobs
 * (a human editing a config file has grounds to pick numbers); the invocation surface
 * only offers these presets, because a model choosing `maxToolCalls` per delegation is
 * guessing. `standard` is byte-identical to the DEFAULT_* values, so omitting `effort`
 * leaves behavior unchanged.
 */
export const SUB_AGENT_EFFORT_PRESETS = {
	quick: { maxTurns: 8, maxToolCalls: 16, maxWallTimeSec: 120, bashTimeoutSec: 60 },
	standard: {
		maxTurns: DEFAULT_MAX_TURNS,
		maxToolCalls: DEFAULT_MAX_TOOL_CALLS,
		maxWallTimeSec: DEFAULT_MAX_WALL_TIME_SEC,
		bashTimeoutSec: DEFAULT_BASH_TIMEOUT_SEC,
	},
	deep: { maxTurns: 64, maxToolCalls: 160, maxWallTimeSec: 1800, bashTimeoutSec: 300 },
} as const;

export type SubAgentEffort = keyof typeof SUB_AGENT_EFFORT_PRESETS;

const ALLOWED_EFFORTS = Object.keys(SUB_AGENT_EFFORT_PRESETS) as SubAgentEffort[];

/**
 * The invocation-side spelling of `contextMode` + `memory`. Those two frontmatter knobs
 * encode only four meaningful states (`isolated` implies `memory: none`), so the calling
 * surface collapses them into one enum. The dropped state — contextual with `memory: none`,
 * i.e. paths-only injection — remains expressible in frontmatter.
 */
const ALLOWED_CONTEXT_CHOICES = ["none", "session", "relevant"] as const;

export type SubAgentContextChoice = (typeof ALLOWED_CONTEXT_CHOICES)[number];

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
	/** Unset means "apply the purpose-based default at resolution time" (spec 032 D3). */
	thinkingLevel?: SubAgentThinkingLevel;
	filePath?: string;
	source: "predefined" | "inline";
	/** Defaults to "internal"; existing role files therefore parse unchanged (spec 040, D5). */
	runtime: SubAgentRuntime;
	/** External only. */
	harness?: SubAgentHarness;
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

export interface ResolvedSubAgentConfig extends Omit<SubAgentConfig, "model" | "modelRef"> {
	model: Model<Api>;
	modelRef: string;
}

export interface SubAgentDiscoveryResult {
	directory: string;
	agents: SubAgentConfig[];
	warnings: string[];
}

/**
 * `subagent` (role-based) invocation surface (spec 046, D2.1). Deliberately has no override
 * fields beyond `purpose`: everything else a configured role could vary — tools, model, effort,
 * context, thinkingLevel, mutates — lives in the role file, which is the deployer's decision, not
 * a per-call one. This is what makes "external role + tools/model/mutates" unrepresentable at the
 * type level instead of rejected at runtime (spec 042 D3's three checks are now dead by construction).
 */
export interface ConfiguredRoleOverrides {
	agent: string;
	/** Drives the thinkingLevel default: "verify" defaults on, everything else stays off. */
	purpose?: string;
}

/**
 * `subagent_inline` invocation surface (spec 046, D2.1) — a one-off executor with no role file,
 * so every field a role file would otherwise supply is a call-time override here instead.
 */
export interface InlineAgentOverrides {
	systemPrompt: string;
	tools?: string[];
	model?: string;
	/** Named budget preset; wins over frontmatter numbers as a whole tuple, never field by field. */
	effort?: string;
	/** Collapsed `contextMode` + `memory`; see SubAgentContextChoice. */
	context?: string;
	thinkingLevel?: string;
	/** Drives the thinkingLevel default: "verify" defaults on, everything else stays off. */
	purpose?: string;
	mutates?: string;
}

/** Internal work/verify default, aligned with the main agent's DEFAULT_MAIN_THINKING_LEVEL
 *  (channel-runner.ts). External work leaves thinkingLevel unset instead (see resolveSubAgentConfig):
 *  pipiclaw has no standing to pick a reasoning effort for another CLI's own configuration. */
export const DEFAULT_THINKING_LEVEL: SubAgentThinkingLevel = "medium";

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

/**
 * Deny `write`/`edit` on `workspace/sub-agents/` itself (spec 040, D8.1).
 *
 * `DEFAULT_SECURITY_CONFIG.writeAllow` is empty and `pathAllowedByDefaults` permits the whole
 * workspace, so without this the main agent (and a sub-agent it dispatches) can write a
 * `runtime: external` role file with an arbitrary `command` and then invoke it — a command-guard
 * bypass wearing a delegation costume. This closes the `write`/`edit` path; it does not close
 * `bash` (same known gap as the memory-write-deny it mirrors — see the spec's risk list). The
 * role directory hot-reloads on purpose (P4): this is the only gate, and it must stay cheap.
 */
export function withSubAgentsDirWriteDeny(config: SecurityConfig, workspaceDir: string): SecurityConfig {
	return {
		...config,
		pathGuard: {
			...config.pathGuard,
			writeDeny: [...config.pathGuard.writeDeny, getSubAgentsDir(workspaceDir)],
		},
	};
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

/**
 * Shared shape for every frontmatter/override field whose only validation is "one of a fixed
 * allow-list, else report an error and fall back": `contextMode`, `thinkingLevel`, `effort`,
 * `runtime`, `harness`, `workload`, `mutates` all had their own byte-identical copy of this
 * before (review 2026-08-29) — only the label, allow-list and fallback ever differed.
 */
function parseEnumField<T extends string>(
	raw: unknown,
	label: string,
	allowed: readonly T[],
	fallback?: T,
): { value?: T; error?: string } {
	const normalized = readOptionalTrimmedString(raw);
	if (!normalized) {
		return { value: fallback };
	}
	if (allowed.includes(normalized as T)) {
		return { value: normalized as T };
	}
	return {
		value: fallback,
		error: `Unknown ${label} "${normalized}". Allowed values: ${allowed.join(", ")}`,
	};
}

function parseContextMode(raw: unknown): { value: SubAgentContextMode; error?: string } {
	const result = parseEnumField(raw, "contextMode", ALLOWED_CONTEXT_MODES, "isolated");
	return { value: result.value ?? "isolated", error: result.error };
}

function parseThinkingLevel(raw: unknown): { value?: SubAgentThinkingLevel; error?: string } {
	return parseEnumField(raw, "thinkingLevel", ALLOWED_THINKING_LEVELS);
}

function parseEffort(raw: unknown): { value?: SubAgentEffort; error?: string } {
	return parseEnumField(raw, "effort", ALLOWED_EFFORTS);
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
 * `defaultValue` is computed per call site rather than derived from `contextMode` inside this
 * function (spec 042 D4): internal keeps following `contextMode` (`contextual` → `relevant`),
 * but an external role's default is always `none` regardless of `contextMode` — a role that
 * merely wants `paths` injected (via `contextMode: contextual`) should not also silently start
 * sending session/memory content to a third-party process.
 */
function parseMemoryMode(
	raw: unknown,
	defaultValue: SubAgentMemoryMode,
): { value: SubAgentMemoryMode; error?: string } {
	const normalized = readOptionalTrimmedString(raw);
	if (!normalized) {
		return { value: defaultValue };
	}
	if (ALLOWED_MEMORY_MODES.includes(normalized as SubAgentMemoryMode)) {
		return { value: normalized as SubAgentMemoryMode };
	}
	return {
		value: defaultValue,
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

function parseRuntime(raw: unknown): { value: SubAgentRuntime; error?: string } {
	const result = parseEnumField(raw, "runtime", ALLOWED_RUNTIMES, "internal");
	return { value: result.value ?? "internal", error: result.error };
}

function parseHarness(raw: unknown): { value?: SubAgentHarness; error?: string } {
	return parseEnumField(raw, "harness", ALLOWED_HARNESSES);
}

function parseWorkload(raw: unknown): { value?: SubAgentWorkload; error?: string } {
	return parseEnumField(raw, "workload", ALLOWED_WORKLOADS);
}

function parseMutates(raw: unknown): { value?: SubAgentMutates; error?: string } {
	return parseEnumField(raw, "mutates", ALLOWED_MUTATES);
}

function parseBooleanField(raw: unknown, label: string): { value?: boolean; error?: string } {
	if (raw === undefined || raw === null) return {};
	if (typeof raw === "boolean") return { value: raw };
	if (raw === "true") return { value: true };
	if (raw === "false") return { value: false };
	return { error: `Invalid "${label}" frontmatter: expected true or false` };
}

function parseEnvMap(raw: unknown): { value?: Record<string, string>; error?: string } {
	if (raw === undefined || raw === null) return {};
	if (typeof raw !== "object" || Array.isArray(raw)) {
		return { error: 'Invalid "env" frontmatter: expected a mapping of string to string' };
	}
	const value: Record<string, string> = {};
	for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof val !== "string") {
			return { error: `Invalid "env.${key}" frontmatter: expected a string` };
		}
		value[key] = val;
	}
	return { value };
}

/** First whitespace-delimited token of `command` (its executable), respecting quotes (D4). */
function firstCommandToken(command: string): string | undefined {
	return splitShellWords(command)[0];
}

/** Existence check only (no exec-bit probe): cheap, spawn-free, good enough for "is it installed". */
function isExecutableAvailable(token: string): boolean {
	if (token.includes("/")) {
		return existsSyncFs(token);
	}
	const pathEnv = process.env.PATH ?? "";
	return pathEnv.split(pathDelimiter).some((dir) => dir && existsSyncFs(joinPath(dir, token)));
}

type FieldSupport = "supported" | "rejected";

/**
 * Which role-file fields mean something under which runtime (spec 040 D5's "对某种 runtime 无意义
 * 的字段一律驳回", made into data per spec 042 D3/F3). A field present under a runtime marked
 * `"rejected"` here is rejected outright, not silently ignored — silently ignoring one is a
 * defect, not a leniency (the review that produced spec 042 found `shell`/`env` on an internal
 * role doing exactly that before this table existed). `cwd` is deliberately absent: it is rejected
 * for *both* runtimes with a different message ("not a role field at all"), handled separately in
 * `loadAgentsFromDir` rather than as a per-runtime mismatch.
 */
export const ROLE_FIELD_MATRIX: Record<string, Record<SubAgentRuntime, FieldSupport>> = {
	harness: { internal: "rejected", external: "supported" },
	command: { internal: "rejected", external: "supported" },
	shell: { internal: "rejected", external: "supported" },
	env: { internal: "rejected", external: "supported" },
	tools: { internal: "supported", external: "rejected" },
	maxTurns: { internal: "supported", external: "rejected" },
	maxToolCalls: { internal: "supported", external: "rejected" },
	bashTimeoutSec: { internal: "supported", external: "rejected" },
};

function rejectedFieldNames(frontmatter: Record<string, unknown>, runtime: SubAgentRuntime): string[] {
	return Object.keys(ROLE_FIELD_MATRIX).filter(
		(field) => frontmatter[field] !== undefined && ROLE_FIELD_MATRIX[field][runtime] === "rejected",
	);
}

function inferMutatesFromTools(tools: SubAgentToolName[]): SubAgentMutates {
	return tools.includes("write") || tools.includes("edit") ? "write" : "read";
}

interface DirScanResult {
	agents: SubAgentConfig[];
	warnings: string[];
}

interface ParsedAgent {
	agent?: SubAgentConfig;
	warning?: string;
}

function parseInternalAgent(
	entryName: string,
	filePath: string,
	frontmatter: Record<string, unknown>,
	body: string,
	name: string,
	description: string,
	availableModels: Model<Api>[],
): ParsedAgent {
	const rejected = rejectedFieldNames(frontmatter, "internal");
	if (rejected.length > 0) {
		return { warning: `${entryName}: field(s) ${rejected.join(", ")} are only valid for runtime: external` };
	}

	const toolParse = parseToolNames(frontmatter.tools);
	if (toolParse.error) return { warning: `${entryName}: ${toolParse.error}` };

	const contextMode = parseContextMode(frontmatter.contextMode);
	if (contextMode.error) return { warning: `${entryName}: ${contextMode.error}` };

	const memoryMode = parseMemoryMode(frontmatter.memory, contextMode.value === "contextual" ? "relevant" : "none");
	if (memoryMode.error) return { warning: `${entryName}: ${memoryMode.error}` };

	const parsedPaths = parseStringList(frontmatter.paths, "paths");
	if (parsedPaths.error) return { warning: `${entryName}: ${parsedPaths.error}` };

	const thinkingLevel = parseThinkingLevel(frontmatter.thinkingLevel);
	if (thinkingLevel.error) return { warning: `${entryName}: ${thinkingLevel.error}` };

	const workload = parseWorkload(frontmatter.workload);
	if (workload.error) return { warning: `${entryName}: ${workload.error}` };

	const mutates = parseMutates(frontmatter.mutates);
	if (mutates.error) return { warning: `${entryName}: ${mutates.error}` };

	const maxTurns = parsePositiveInteger(frontmatter.maxTurns, DEFAULT_MAX_TURNS);
	const maxToolCalls = parsePositiveInteger(frontmatter.maxToolCalls, DEFAULT_MAX_TOOL_CALLS);
	const maxWallTimeSec = parsePositiveInteger(frontmatter.maxWallTimeSec, DEFAULT_MAX_WALL_TIME_SEC);
	const bashTimeoutSec = parsePositiveInteger(frontmatter.bashTimeoutSec, DEFAULT_BASH_TIMEOUT_SEC);
	const numericWarning = [maxTurns.warning, maxToolCalls.warning, maxWallTimeSec.warning, bashTimeoutSec.warning].find(
		Boolean,
	);
	// A malformed numeric field falls back to its default rather than dropping the whole role —
	// but it is still reported, via the first warning found.
	const modelRef = readOptionalTrimmedString(frontmatter.model);
	let model: Model<Api> | undefined;
	if (modelRef) {
		const resolved = resolveModelReference(modelRef, availableModels);
		if (!resolved.model) return { warning: `${entryName}: ${resolved.error}` };
		model = resolved.model;
	}

	const trimmedBody = body.trim();
	if (!trimmedBody) return { warning: `${entryName}: empty system prompt body` };
	const promptLengthError = validateSubAgentSystemPrompt(trimmedBody, "Sub-agent system prompt");
	if (promptLengthError) return { warning: `${entryName}: ${promptLengthError}` };

	// Spec 042 D6: `bash` can write regardless of what `tools` otherwise implies, and the default
	// tool set (`read,bash`) is inferred "read" — a role that actually writes through bash and never
	// says so does not take the workspace write lease. Not rejected (`bash` is normal and common for
	// read-only inspection too) — just surfaced so the declaration is a conscious choice.
	const bashWithoutMutatesWarning =
		toolParse.tools.includes("bash") && mutates.value === undefined
			? 'tools include bash but "mutates" is not declared; if this role writes to the workspace, declare mutates: write so it participates in the workspace write lease'
			: undefined;
	const combinedWarningBody = [numericWarning, bashWithoutMutatesWarning].filter(Boolean).join("; ");

	return {
		warning: combinedWarningBody ? `${entryName}: ${combinedWarningBody}` : undefined,
		agent: {
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
			thinkingLevel: thinkingLevel.value,
			filePath,
			source: "predefined",
			runtime: "internal",
			workload: workload.value ?? "light", // D11 default-by-runtime.
			mutates: mutates.value ?? inferMutatesFromTools(toolParse.tools),
		},
	};
}

function parseExternalAgent(
	entryName: string,
	filePath: string,
	frontmatter: Record<string, unknown>,
	body: string,
	name: string,
	description: string,
): ParsedAgent {
	const rejected = rejectedFieldNames(frontmatter, "external");
	if (rejected.length > 0) {
		return { warning: `${entryName}: field(s) ${rejected.join(", ")} are not valid for runtime: external` };
	}

	const harness = parseHarness(frontmatter.harness);
	if (harness.error) return { warning: `${entryName}: ${harness.error}` };
	if (!harness.value) return { warning: `${entryName}: runtime: external requires "harness"` };

	const command = readOptionalTrimmedString(frontmatter.command);
	if (!command) return { warning: `${entryName}: runtime: external requires a non-empty "command"` };

	const mutates = parseMutates(frontmatter.mutates);
	if (mutates.error) return { warning: `${entryName}: ${mutates.error}` };
	if (!mutates.value) return { warning: `${entryName}: runtime: external requires "mutates" (read or write)` };

	const shell = parseBooleanField(frontmatter.shell, "shell");
	if (shell.error) return { warning: `${entryName}: ${shell.error}` };
	if (shell.value && harness.value !== "exec") {
		return {
			warning: `${entryName}: "shell: true" is only supported with harness: exec; structured harnesses must assemble their own argv`,
		};
	}

	const env = parseEnvMap(frontmatter.env);
	if (env.error) return { warning: `${entryName}: ${env.error}` };

	const workload = parseWorkload(frontmatter.workload);
	if (workload.error) return { warning: `${entryName}: ${workload.error}` };

	const thinkingLevel = parseThinkingLevel(frontmatter.thinkingLevel);
	if (thinkingLevel.error) return { warning: `${entryName}: ${thinkingLevel.error}` };

	const parsedPaths = parseStringList(frontmatter.paths, "paths");
	if (parsedPaths.error) return { warning: `${entryName}: ${parsedPaths.error}` };

	const contextMode = parseContextMode(frontmatter.contextMode);
	if (contextMode.error) return { warning: `${entryName}: ${contextMode.error}` };

	// Spec 042 D4: external default is always "none", never following contextMode the way internal
	// does — a role that only wants `paths` injected (contextMode: contextual) should not also
	// silently start sending session/memory content to a third-party process. Explicitly declaring
	// `memory: session|relevant` is a real, informed choice; it gets a disclosure warning below.
	const memoryMode = parseMemoryMode(frontmatter.memory, "none");
	if (memoryMode.error) return { warning: `${entryName}: ${memoryMode.error}` };
	const memoryDisclosureWarning =
		memoryMode.value !== "none"
			? `${entryName}: memory: ${memoryMode.value} sends channel session state / recalled memory content to this external process`
			: undefined;

	const maxWallTimeSec = parsePositiveInteger(frontmatter.maxWallTimeSec, DEFAULT_EXTERNAL_MAX_WALL_TIME_SEC);

	const trimmedBody = body.trim();
	if (!trimmedBody) return { warning: `${entryName}: empty system prompt body` };
	const promptLengthError = validateSubAgentSystemPrompt(trimmedBody, "Sub-agent system prompt");
	if (promptLengthError) return { warning: `${entryName}: ${promptLengthError}` };

	// A missing binary never drops the role (that would silently push the model back onto
	// internal delegation, exactly the failure mode this spec exists to close) — it is listed,
	// marked unavailable, and only refuses at invocation time, with an installation hint.
	const executable = firstCommandToken(command);
	const unavailable =
		executable && !isExecutableAvailable(executable)
			? `executable "${executable}" was not found on PATH; install it or fix "command" in ${filePath}`
			: undefined;

	const externalModelRef = readOptionalTrimmedString(frontmatter.model);
	// Spec 042 D10: a role's `model:` can only ever come from its own frontmatter (external `model`
	// is never taken from the invocation) — so if `command` references `$MODEL` and none is
	// configured here, every dispatch of this role will silently drop that argv token. Surface it
	// at discovery time, where the fix (add `model:`) is obvious, instead of only as a per-run
	// warning after the fact. `$EFFORT` gets no equivalent check: `thinkingLevel` can be supplied
	// per invocation, so an unset frontmatter value does not mean "no value ever".
	const modelPlaceholderWarning =
		command.includes("$MODEL") && !externalModelRef
			? `${entryName}: command references $MODEL but no "model" is configured; that argv token will be dropped on every dispatch`
			: undefined;

	// Both are non-fatal (the role still loads); joined rather than picking one so an unlucky
	// combination never silently loses one of them.
	const combinedWarning = [memoryDisclosureWarning, modelPlaceholderWarning].filter(Boolean).join("; ") || undefined;

	return {
		warning: combinedWarning,
		agent: {
			name,
			description,
			systemPrompt: trimmedBody,
			tools: [],
			modelRef: undefined,
			externalModelRef,
			maxTurns: DEFAULT_MAX_TURNS,
			maxToolCalls: DEFAULT_MAX_TOOL_CALLS,
			maxWallTimeSec: maxWallTimeSec.value,
			bashTimeoutSec: DEFAULT_BASH_TIMEOUT_SEC,
			contextMode: contextMode.value,
			memory: memoryMode.value,
			paths: parsedPaths.values,
			thinkingLevel: thinkingLevel.value,
			filePath,
			source: "predefined",
			runtime: "external",
			harness: harness.value,
			command,
			shell: shell.value,
			env: env.value,
			workload: workload.value ?? "heavy", // D11 default-by-runtime.
			mutates: mutates.value,
			unavailable,
		},
	};
}

/** Parses every `*.md` sub-agent definition in the user's workspace directory. */
function loadAgentsFromDir(directory: string, availableModels: Model<Api>[]): DirScanResult {
	if (!existsSync(directory)) {
		return { agents: [], warnings: [] };
	}

	const warnings: string[] = [];
	const agents: SubAgentConfig[] = [];
	const knownNames = new Set<string>();
	let entries: Dirent<string>[];
	try {
		entries = readdirSync(directory, { withFileTypes: true })
			.filter((entry) => entry.name.endsWith(".md") && (entry.isFile() || entry.isSymbolicLink()))
			// A README is documentation about the directory, not a role in it — a warning about its
			// missing frontmatter is noise every time someone copies `examples/sub-agents/` wholesale.
			.filter((entry) => entry.name.toLowerCase() !== "readme.md")
			.sort((a, b) => a.name.localeCompare(b.name));
	} catch (error) {
		return { agents: [], warnings: [`Failed to read sub-agents directory (${errorMessage(error)})`] };
	}

	for (const entry of entries) {
		const filePath = join(directory, entry.name);
		let content = "";
		try {
			content = readFileSync(filePath, "utf-8");
		} catch (error) {
			warnings.push(`${entry.name}: failed to read file (${errorMessage(error)})`);
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
		const name = readOptionalTrimmedString(frontmatter.name);
		const description = readOptionalTrimmedString(frontmatter.description);

		if (!name || !description) {
			warnings.push(`${entry.name}: missing required frontmatter fields "name" or "description"`);
			continue;
		}

		if (knownNames.has(name)) {
			warnings.push(`${entry.name}: duplicate sub-agent name "${name}" ignored`);
			continue;
		}
		// Claim the name before later validation so a malformed duplicate cannot shadow a valid one.
		knownNames.add(name);

		// The working directory is a per-delegation decision (workingDirectory on the call), never
		// a role default — a `cwd` default would let a model skip the thinking it must do every
		// time (spec 040, D5), and would silently collide two parallel writers on one checkout.
		if (frontmatter.cwd !== undefined) {
			warnings.push(
				`${entry.name}: "cwd" is not a role field; pass workingDirectory on the delegation call instead`,
			);
			continue;
		}

		const runtimeParse = parseRuntime(frontmatter.runtime);
		if (runtimeParse.error) {
			warnings.push(`${entry.name}: ${runtimeParse.error}`);
			continue;
		}

		const parsed =
			runtimeParse.value === "internal"
				? parseInternalAgent(entry.name, filePath, frontmatter, body, name, description, availableModels)
				: parseExternalAgent(entry.name, filePath, frontmatter, body, name, description);

		if (parsed.warning) warnings.push(parsed.warning);
		if (parsed.agent) agents.push(parsed.agent);
	}

	return { agents, warnings };
}

export function discoverSubAgents(workspaceDir: string, availableModels: Model<Api>[]): SubAgentDiscoveryResult {
	const directory = getSubAgentsDir(workspaceDir);
	const result = loadAgentsFromDir(directory, availableModels);
	return { directory, agents: result.agents, warnings: result.warnings };
}

/**
 * Resolve a `subagent` (role-based) invocation (spec 046, D2.1).
 *
 * Everything the old combined resolver used to override for a configured role — `tools`,
 * `model`, `effort`, `context`, `mutates` — now has nowhere to come from but the role file
 * itself, so this is a lookup plus the two facts a role file cannot pin down: the default model
 * (parent's current model, or `settings.subagentModel`) and the purpose-driven thinkingLevel
 * default. Spec 042 D3's three "external + override" rejections no longer apply: `ConfiguredRoleOverrides`
 * has no `tools`/`model`/`mutates` field to reject in the first place.
 */
export function resolveConfiguredRole(
	availableModels: Model<Api>[],
	currentModel: Model<Api>,
	predefinedAgents: SubAgentConfig[],
	overrides: ConfiguredRoleOverrides,
	/**
	 * `settings.subagentModel` (spec 032 D5): used only when neither the role file's frontmatter
	 * nor this call names a model (it cannot — there is no override field for it).
	 */
	subagentDefaultModelRef?: string,
): { config?: ResolvedSubAgentConfig; error?: string } {
	const baseConfig = predefinedAgents.find((agent) => agent.name === overrides.agent);
	if (!baseConfig) {
		const available = predefinedAgents.length > 0 ? predefinedAgents.map((agent) => agent.name).join(", ") : "none";
		return { error: `Unknown sub-agent "${overrides.agent}". Available sub-agents: ${available}.` };
	}
	// Listed, never dropped (spec 040, D5) — but refused here with the reason, not a fallback.
	if (baseConfig.unavailable) {
		return { error: `Sub-agent "${baseConfig.name}" is currently unavailable: ${baseConfig.unavailable}` };
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

	const purpose = overrides.purpose === "verify" ? "verify" : "work";
	// External work is not defaulted: pipiclaw has no standing to pick a reasoning effort for
	// another CLI's own configuration. External verify still defaults — it is the last unattended
	// gate before an attestation is trusted, and "whatever that machine happens to have configured"
	// is not an acceptable substitute for real reasoning.
	const thinkingLevel =
		baseConfig.thinkingLevel ??
		(baseConfig.runtime === "external" && purpose !== "verify" ? undefined : DEFAULT_THINKING_LEVEL);
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
 * Resolve a `subagent_inline` invocation (spec 046, D2.1) — a one-off executor with no role
 * file. `runtime` is always `"internal"` here: only a configured role file can name `external`,
 * and `InlineAgentOverrides` has no field for it, so the old function's external branches
 * (budget table, unset-by-default thinkingLevel, model/tools/mutates rejections) simply do not
 * apply to this path and are not reproduced here.
 */
export function resolveInlineAgent(
	availableModels: Model<Api>[],
	currentModel: Model<Api>,
	overrides: InlineAgentOverrides,
	/** `settings.subagentModel` (spec 032 D5): used only when this call does not name a model. */
	subagentDefaultModelRef?: string,
): { config?: ResolvedSubAgentConfig; error?: string; warning?: string } {
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

	const effortOverride = parseEffort(overrides.effort);
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
	const memory = contextOverride.value?.memory ?? (contextMode === "contextual" ? "relevant" : "none");

	const thinkingLevelOverride = overrides.thinkingLevel ? parseThinkingLevel(overrides.thinkingLevel) : undefined;
	if (thinkingLevelOverride?.error) {
		return { error: thinkingLevelOverride.error };
	}
	const thinkingLevel = thinkingLevelOverride?.value ?? DEFAULT_THINKING_LEVEL;

	const mutatesOverride = parseMutates(overrides.mutates);
	if (mutatesOverride.error) {
		return { error: mutatesOverride.error };
	}
	const mutates = mutatesOverride.value ?? inferMutatesFromTools(tools.tools);
	// Inline roles have no frontmatter to declare `mutates` in, so this warning goes back to the
	// model in the result text instead of a discovery-time log (D6 in the pre-split resolver).
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

/**
 * Spec 042 D7: a fingerprint of the parts of an external role that decide *how a launched process
 * is built* — `command`, `externalModelRef`, `shell`. Persisted on a run at launch and compared
 * against the role's current config on `follow_up`: a mismatch means the role was hot-edited in a
 * way that would resume under a harness or executable it never actually wrote, so `follow_up`
 * refuses rather than silently reinterpreting the old session with the new config.
 *
 * Deliberately narrow — `systemPrompt` and `maxWallTimeSec` are excluded on purpose. A resumed
 * session already carries its own context, and folding prompt edits in would mean "fix a typo in
 * the role" breaks every in-flight follow-up; a full invocation snapshot was considered and
 * rejected for the same reason (spec 042 design doc, "已驳回的方案").
 */
export function externalRoleFingerprint(role: Pick<SubAgentConfig, "command" | "externalModelRef" | "shell">): string {
	return createHash("sha256")
		.update(JSON.stringify([role.command ?? "", role.externalModelRef ?? "", Boolean(role.shell)]))
		.digest("hex");
}
