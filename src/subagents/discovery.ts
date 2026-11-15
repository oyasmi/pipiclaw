/**
 * Workspace role discovery (`workspace/sub-agents/*.md`): frontmatter parsing, per-runtime field
 * legality checks, static security/role warnings, `workspace/sub-agents/` write-deny guard, and
 * external role fingerprinting. Call-time invocation resolution lives in `resolve.ts`.
 */
import { createHash } from "node:crypto";
import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { join, delimiter as pathDelimiter } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { findExactModelReferenceMatch, formatModelReference } from "../models/reference.js";
import { SUB_AGENTS_DIR_NAME } from "../paths.js";
import type { SecurityConfig } from "../security/types.js";
import { splitShellWords } from "../shared/shell-words.js";
import { errorMessage } from "../shared/text-utils.js";
import { SUBAGENT_TOOL_NAMES, type SubAgentToolName } from "../tools/contract/names.js";
import { externalRoleWarning } from "./external/role-warnings.js";
import {
	EXTERNAL_HARNESS_IDS as ALLOWED_HARNESSES,
	ALLOWED_THINKING_LEVELS,
	type RunHarness,
	type SubAgentThinkingLevel,
} from "./run-record.js";
import {
	ALLOWED_CONTEXT_MODES,
	ALLOWED_MEMORY_MODES,
	ALLOWED_MUTATES,
	ALLOWED_RUNTIMES,
	ALLOWED_WORKLOADS,
	DEFAULT_BASH_TIMEOUT_SEC,
	DEFAULT_EXTERNAL_MAX_WALL_TIME_SEC,
	DEFAULT_MAX_TOOL_CALLS,
	DEFAULT_MAX_TURNS,
	DEFAULT_MAX_WALL_TIME_SEC,
	DEFAULT_SUB_AGENT_TOOLS,
	type SubAgentConfig,
	type SubAgentContextMode,
	type SubAgentDiscoveryResult,
	type SubAgentMemoryMode,
	type SubAgentMutates,
	type SubAgentRoleRuntime,
	type SubAgentWorkload,
} from "./types.js";

/** Re-exported from the leaf source of truth so validation and the tool set never drift. */
const ALLOWED_SUB_AGENT_TOOLS = SUBAGENT_TOOL_NAMES;
const MAX_SUB_AGENT_SYSTEM_PROMPT_CHARS = 16000;

export function validateSubAgentSystemPrompt(systemPrompt: string, label: string): string | undefined {
	if (systemPrompt.length <= MAX_SUB_AGENT_SYSTEM_PROMPT_CHARS) {
		return undefined;
	}
	return `${label} exceeds ${MAX_SUB_AGENT_SYSTEM_PROMPT_CHARS} characters (got ${systemPrompt.length}).`;
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

export function readOptionalTrimmedString(value: unknown): string | undefined {
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
 * `runtime`, `harness`, `workload`, `mutates` all share this logic.
 */
export function parseEnumField<T extends string>(
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

/**
 * `defaultValue` is computed per call site rather than derived from `contextMode` inside this
 * function (spec 042 D4): internal keeps following `contextMode` (`contextual` → `index`), but an
 * external role's default is always `none` regardless of `contextMode` — a role that merely wants
 * `paths` injected (via `contextMode: contextual`) should not also silently start sending
 * session/memory content to a third-party process.
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

export function resolveModelReference(
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

function parseRuntime(raw: unknown): { value: SubAgentRoleRuntime; error?: string } {
	const result = parseEnumField(raw, "runtime", ALLOWED_RUNTIMES, "internal");
	return { value: result.value ?? "internal", error: result.error };
}

function parseHarness(raw: unknown): { value?: RunHarness; error?: string } {
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
	if (token.includes("/")) return existsSync(token);
	const pathEnv = process.env.PATH ?? "";
	return pathEnv.split(pathDelimiter).some((dir) => dir && existsSync(join(dir, token)));
}

type FieldSupport = "supported" | "rejected";

/**
 * Which role-file fields mean something under which runtime (spec 040 D5's "对某种 runtime 无意义
 * 的字段一律驳回", made into data per spec 042 D3/F3). A field present under a runtime marked
 * `"rejected"` here is rejected outright, not silently ignored. `cwd` is deliberately absent: it
 * is rejected for *both* runtimes with a different message ("not a role field at all"), handled
 * separately in `loadAgentsFromDir` rather than as a per-runtime mismatch.
 */
const ROLE_FIELD_MATRIX: Record<string, Record<SubAgentRoleRuntime, FieldSupport>> = {
	harness: { internal: "rejected", external: "supported" },
	command: { internal: "rejected", external: "supported" },
	shell: { internal: "rejected", external: "supported" },
	env: { internal: "rejected", external: "supported" },
	tools: { internal: "supported", external: "rejected" },
	maxTurns: { internal: "supported", external: "rejected" },
	maxToolCalls: { internal: "supported", external: "rejected" },
	bashTimeoutSec: { internal: "supported", external: "rejected" },
};

function rejectedFieldNames(frontmatter: Record<string, unknown>, runtime: SubAgentRoleRuntime): string[] {
	return Object.keys(ROLE_FIELD_MATRIX).filter(
		(field) => frontmatter[field] !== undefined && ROLE_FIELD_MATRIX[field][runtime] === "rejected",
	);
}

export function inferMutatesFromTools(tools: SubAgentToolName[]): SubAgentMutates {
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

	const memoryMode = parseMemoryMode(frontmatter.memory, contextMode.value === "contextual" ? "index" : "none");
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
	// tool set (`read,bash`) is inferred "read" — surface so the declaration is a conscious choice.
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
			workload: workload.value ?? "light",
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

	// Spec 042 D4: external default is always "none", never following contextMode.
	const memoryMode = parseMemoryMode(frontmatter.memory, "none");
	if (memoryMode.error) return { warning: `${entryName}: ${memoryMode.error}` };

	const maxWallTimeSec = parsePositiveInteger(frontmatter.maxWallTimeSec, DEFAULT_EXTERNAL_MAX_WALL_TIME_SEC);

	// An empty body is a legitimate declaration for an external role, not a defect.
	const trimmedBody = body.trim();
	const promptLengthError = validateSubAgentSystemPrompt(trimmedBody, "Sub-agent system prompt");
	if (promptLengthError) return { warning: `${entryName}: ${promptLengthError}` };

	const executable = firstCommandToken(command);
	const unavailable =
		executable && !isExecutableAvailable(executable)
			? `executable "${executable}" was not found on PATH; install it or fix "command" in ${filePath}`
			: undefined;

	const externalModelRef = readOptionalTrimmedString(frontmatter.model);
	const combinedWarning = externalRoleWarning({
		entryName,
		harness: harness.value,
		command,
		mutates: mutates.value,
		memory: memoryMode.value ?? "none",
		modelConfigured: Boolean(externalModelRef),
	});

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
			workload: workload.value ?? "heavy",
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
		knownNames.add(name);

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
 * Spec 042 D7: a fingerprint of the parts of an external role that decide *how a launched process
 * is built* — `command`, `externalModelRef`, `shell`. Persisted on a run at launch and compared
 * against the role's current config on `follow_up` so hot-edited roles cannot silently resume an
 * older session under a changed executable/model/shell mode.
 */
export function externalRoleFingerprint(role: Pick<SubAgentConfig, "command" | "externalModelRef" | "shell">): string {
	return createHash("sha256")
		.update(JSON.stringify([role.command ?? "", role.externalModelRef ?? "", Boolean(role.shell)]))
		.digest("hex");
}
