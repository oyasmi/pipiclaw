/**
 * Prompt manifest and the `/context` report (spec 025 §9, spec 026 §10.9).
 *
 * Zero LLM cost: everything here is computed from the last build plus counters
 * the runner already keeps. Tool JSON schemas are reported alongside the system
 * prompt because they are billed the same way and are often the larger half.
 *
 * Skills are reported here, never budgeted: pi renders `<available_skills>` and
 * owns the same list that backs `/skill:name`, so `estimateSkillsPromptChars` lives
 * next to the report — not in the builder's budget path (spec 026 §9, §10.9).
 */

import { countPromptUnits } from "../../shared/prompt-units.js";
import { estimateTokens } from "../../shared/token-estimate.js";
import { RUNTIME_PROMPT_TARGET_UNITS, sha256 } from "./builder.js";
import type { LoadedPromptResource, PromptBuildResult, ResolvedPromptSection } from "./types.js";

/** The design ceiling for everything Pipiclaw auto-appends to a turn (spec 026 §5.3). */
export const AUTOMATIC_TURN_CONTEXT_BUDGET_UNITS = 3_000;

/**
 * Soft budget for the tool JSON schemas, in the same units as the prompt sections.
 *
 * Tool schemas are the larger half of the fixed per-turn cost and were the only part of it with
 * no budget at all: the runtime-authored prompt is capped at 700 units while the schemas beside it
 * run several thousand. They sit in the provider's cache prefix, so the steady-state price is low —
 * but every `rebuildSessionTools` (a workspace skill write, `/reload`, any resource reload) swaps
 * that prefix and pays for all of it again.
 *
 * There is no hard cap on purpose. A schema cannot be auto-trimmed the way a prompt section can:
 * the fix is always a human deciding which tool says less, or which tool should not be registered.
 * So this is a warning line in the log and in `/context`, not an enforcement point. It is set just
 * above the current set (≈2.8k units for 15 tools) — one more heavyweight tool crosses it, which
 * is exactly when someone should be looking.
 */
export const TOOL_SCHEMA_TARGET_UNITS = 3_000;

export interface ToolSchemaMeasurement {
	chars: number;
	units: number;
}

/** The one wording for "the tool set is over budget", shared by `/context` and the rebuild log. */
export function toolSchemaBudgetWarning(measurement: ToolSchemaMeasurement): string {
	return `tool JSON schemas are ${measurement.units} units (${measurement.chars} chars), over the ${TOOL_SCHEMA_TARGET_UNITS} unit target. Shorten a tool description, move detail into a playbook, or unregister a tool; \`/context detail\` lists the set.`;
}

/**
 * What the tool set costs on top of the system prompt. Counts what the provider is actually sent
 * per tool — name, description and the JSON schema — the same way `/context` has always reported it.
 */
export function measureToolSchemas(
	tools: Array<{ name: string; description: string; parameters?: unknown }>,
): ToolSchemaMeasurement {
	let chars = 0;
	let units = 0;
	for (const tool of tools) {
		const text = `${tool.name}${tool.description}${JSON.stringify(tool.parameters ?? {})}`;
		chars += text.length;
		units += countPromptUnits(text);
	}
	return { chars, units };
}

export interface PromptTurnContextStats {
	durableMemoryChars: number;
	durableMemoryUnits: number;
	taskDigestChars: number;
	taskDigestUnits: number;
	recalledMemoryChars: number;
	recalledMemoryUnits: number;
	channelCapsuleUnits: number;
	userMessageChars: number;
}

export interface PromptContextReportInput {
	build: PromptBuildResult;
	/** What the provider actually received: our prompt + pi's skills/date/cwd tail + the boundary footer. */
	finalPrompt?: string;
	skills: Array<{ name: string; description: string }>;
	toolNames: string[];
	toolSchemas: ToolSchemaMeasurement;
	/** Resolved SOUL.md / AGENTS.md, for the independent body-budget lines. */
	soul?: LoadedPromptResource;
	agents?: LoadedPromptResource;
	lastTurn?: PromptTurnContextStats;
	detail: boolean;
}

export interface PromptSectionManifestEntry {
	id: string;
	order: number;
	source: string;
	authority: string;
	cacheClass: string;
	rawChars: number;
	injectedChars: number;
	rawUnits: number;
	injectedUnits: number;
	truncated: boolean;
	sha256: string;
}

export interface PromptManifest {
	fingerprint: string;
	totalChars: number;
	totalUnits: number;
	runtimeAuthoredUnits: number;
	estimatedTokens: number;
	sections: PromptSectionManifestEntry[];
	diagnostics: PromptBuildResult["diagnostics"];
	/** Present when the fully assembled prompt (including pi's tail) was captured. */
	finalPromptSha256?: string;
	finalPromptChars?: number;
}

/**
 * What pi's `<available_skills>` block will cost, close enough to report on:
 * name, description and location inside a five-line XML wrapper, plus the preamble.
 * This is observation only — Pipiclaw never trims skills (spec 026 §9).
 */
export function estimateSkillsPromptChars(skills: Array<{ name: string; description: string }>): number {
	if (!skills || skills.length === 0) return 0;
	const SKILL_WRAPPER_CHARS = 90;
	const PREAMBLE_CHARS = 290;
	return (
		PREAMBLE_CHARS +
		skills.reduce((sum, skill) => sum + skill.name.length + skill.description.length + SKILL_WRAPPER_CHARS, 0)
	);
}

/** Section metadata without any section body — safe to write next to a channel. */
export function buildPromptManifest(build: PromptBuildResult, finalPrompt?: string): PromptManifest {
	return {
		fingerprint: build.fingerprint,
		totalChars: build.totalChars,
		totalUnits: build.totalUnits,
		runtimeAuthoredUnits: build.runtimeAuthoredUnits,
		estimatedTokens: build.estimatedTokens,
		sections: build.sections.map(
			({ content: _content, ...entry }: ResolvedPromptSection): PromptSectionManifestEntry => entry,
		),
		diagnostics: build.diagnostics,
		finalPromptSha256: finalPrompt ? sha256(finalPrompt) : undefined,
		finalPromptChars: finalPrompt?.length,
	};
}

function formatNumber(value: number): string {
	return value.toLocaleString("en-US");
}

function renderWorkspaceResourceLine(label: string, resource: LoadedPromptResource | undefined): string | undefined {
	if (!resource || resource.isDefaultTemplate) return undefined;
	const state = resource.truncated ? "truncated" : "complete";
	return `- ${label}: ${formatNumber(resource.injectedUnits)} / ${formatNumber(resource.budgetUnits)} units, ${state}`;
}

export function renderContextReport(input: PromptContextReportInput): string {
	const { build, finalPrompt, detail } = input;
	const lines: string[] = ["# Context Report", ""];

	lines.push(
		`Pipiclaw runtime-authored: ${formatNumber(build.runtimeAuthoredUnits)} units (target ${formatNumber(RUNTIME_PROMPT_TARGET_UNITS)}) · Pipiclaw sections total: ${formatNumber(build.totalUnits)} units / ${formatNumber(build.totalChars)} chars, ~${formatNumber(build.estimatedTokens)} tokens`,
	);
	if (finalPrompt) {
		// The string the provider actually caches: our sections + pi's skills/date/cwd tail +
		// the boundary footer. It is the fingerprint that matters for cache hits — the build
		// fingerprint below only covers the part Pipiclaw owns, and stays stable across a
		// date rollover that does invalidate the provider's cached prefix.
		lines.push(
			`Sent to the model (incl. skills, date, cwd): ${formatNumber(finalPrompt.length)} chars, ~${formatNumber(estimateTokens(finalPrompt))} tokens, sha256:${sha256(finalPrompt).slice(0, 16)}`,
		);
	}
	lines.push(`Fingerprint (Pipiclaw sections): sha256:${build.fingerprint.slice(0, 16)}`);
	lines.push("");

	// Space-padded column alignment relies on a monospace font: DingTalk's proportional rendering
	// collapses it back into unaligned runs, so each field is punctuation-delimited instead of
	// column-aligned (review 2026-08-24 §1.3a).
	for (const section of build.sections) {
		const flags: string[] = [section.cacheClass];
		if (section.truncated) flags.push(`truncated from ${formatNumber(section.rawUnits)} units`);
		lines.push(
			`- ${section.id}: ${formatNumber(section.injectedUnits)} units, ${formatNumber(section.injectedChars)} chars, ${flags.join(", ")}`,
		);
	}

	const soulLine = renderWorkspaceResourceLine("SOUL.md", input.soul);
	const agentsLine = renderWorkspaceResourceLine("AGENTS.md", input.agents);
	if (soulLine || agentsLine) {
		lines.push("");
		lines.push("Workspace resources (independent budgets, not competing with the runtime):");
		if (soulLine) lines.push(soulLine);
		if (agentsLine) lines.push(agentsLine);
	}

	lines.push("");
	const overToolBudget = input.toolSchemas.units > TOOL_SCHEMA_TARGET_UNITS;
	lines.push(
		`Tools: ${input.toolNames.length} registered; JSON schemas ≈ ${formatNumber(input.toolSchemas.units)} / ${formatNumber(TOOL_SCHEMA_TARGET_UNITS)} units, ${formatNumber(input.toolSchemas.chars)} chars${overToolBudget ? " — over target" : ""} (billed on top of the system prompt)`,
	);
	lines.push(
		`Skills: ${input.skills.length} visible, ≈${formatNumber(estimateSkillsPromptChars(input.skills))} chars (rendered and managed by pi, not budgeted by Pipiclaw)`,
	);

	if (input.lastTurn) {
		const turn = input.lastTurn;
		const automaticUnits =
			turn.channelCapsuleUnits + turn.recalledMemoryUnits + turn.taskDigestUnits + turn.durableMemoryUnits;
		lines.push("");
		lines.push(
			`Last automatic turn context: ${formatNumber(automaticUnits)} / ${formatNumber(AUTOMATIC_TURN_CONTEXT_BUDGET_UNITS)} units (per-turn, not cached):`,
		);
		lines.push(`- channel capsule: ${formatNumber(turn.channelCapsuleUnits)} units`);
		lines.push(
			`- recalled memory: ${formatNumber(turn.recalledMemoryUnits)} units / ${formatNumber(turn.recalledMemoryChars)} chars`,
		);
		lines.push(
			`- task agenda: ${formatNumber(turn.taskDigestUnits)} units / ${formatNumber(turn.taskDigestChars)} chars`,
		);
		lines.push(
			`- durable bootstrap: ${formatNumber(turn.durableMemoryUnits)} units / ${formatNumber(turn.durableMemoryChars)} chars`,
		);
		lines.push(`- user message: ${formatNumber(turn.userMessageChars)} chars (not automatic; not capped here)`);
	}

	if (build.diagnostics.length > 0 || overToolBudget) {
		lines.push("");
		lines.push("Diagnostics:");
		for (const diagnostic of build.diagnostics) {
			lines.push(`- [${diagnostic.level}] ${diagnostic.sectionId}: ${diagnostic.message}`);
		}
		if (overToolBudget) {
			lines.push(`- [warning] tools: ${toolSchemaBudgetWarning(input.toolSchemas)}`);
		}
	}

	if (detail) {
		lines.push("");
		lines.push("Detail:");
		for (const section of build.sections) {
			lines.push(
				`- ${section.id} (order ${section.order}, ${section.authority}) ← ${section.source} · sha256:${section.sha256.slice(0, 12)}`,
			);
		}
		if (input.toolNames.length > 0) {
			lines.push(`- tools: ${input.toolNames.join(", ")}`);
		}
		if (input.skills.length > 0) {
			lines.push(`- skills: ${input.skills.map((skill) => skill.name).join(", ")}`);
		}
	} else {
		lines.push("");
		lines.push("Run `/context detail` for per-section sources, hashes, and the tool/skill inventory.");
	}

	return lines.join("\n");
}
