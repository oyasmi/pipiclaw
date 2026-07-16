/**
 * Prompt pipeline: filter → sort → render → budget → fingerprint (spec 025, 026).
 *
 * The output is deterministic: same build context in, same bytes and same
 * fingerprint out. Nothing here may read the clock, the filesystem iteration
 * order, a channel id, or anything else that would make two channels in one
 * workspace disagree — that is what makes the provider-side prompt cache hold.
 *
 * Budget model (spec 026 §5, §10.3): there is no single global char cap that lets
 * runtime text, SOUL, AGENTS and skills compete. The only budget enforced here is
 * on the sections Pipiclaw *authors* — measured in prompt units. SOUL/AGENTS are
 * budgeted independently in resources.ts, and skills are pi's to render.
 */

import { createHash } from "node:crypto";
import { countPromptUnits } from "../../shared/prompt-units.js";
import { FINAL_BOUNDARY_SECTION, MAIN_PROMPT_SECTIONS } from "./sections.js";
import type {
	PromptBuildContext,
	PromptBuildResult,
	PromptDiagnostic,
	PromptSectionDefinition,
	ResolvedPromptSection,
} from "./types.js";

/** Bumped whenever the runtime-authored prompt text changes in a way worth attributing in telemetry. */
export const RUNTIME_PROMPT_VERSION = 3;

/**
 * The sections Pipiclaw authors and must keep tight (spec 026 §10.3): identity,
 * execution, invariants, persistent-task rules, the runtime-guide catalog and the
 * final boundary. SOUL/AGENTS, the sub-agent catalog (its descriptions are user
 * text) and pi's skills are deliberately excluded.
 */
const RUNTIME_AUTHORED_SECTION_IDS = new Set([
	"runtime.identity",
	"runtime.execution",
	"runtime.invariants",
	"runtime.tasks",
	"playbooks",
	"runtime.boundary",
]);

/** Over this, the runtime-authored prompt still works but is worth a warning (spec 026 §5.2). */
export const RUNTIME_PROMPT_TARGET_UNITS = 700;
/** Over this it is a development error: runtime text has drifted well past its budget. */
export const RUNTIME_PROMPT_HARD_UNITS = 1_200;

export function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Rough token estimate for reporting only. CJK runs about one token per
 * character, Latin text about four characters per token; the provider's real
 * tokenizer is the authority, and the usage ledger records what it billed.
 */
const CJK_REGEX = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u;

export function estimateTokens(text: string): number {
	let cjk = 0;
	for (const char of text) {
		if (CJK_REGEX.test(char)) cjk++;
	}
	return Math.ceil(cjk + (text.length - cjk) / 4);
}

function truncateItems(content: string, maxChars: number): string {
	const lines = content.split("\n");
	const kept: string[] = [];
	let used = 0;
	let omitted = 0;
	for (const line of lines) {
		const cost = line.length + 1;
		if (omitted === 0 && used + cost <= maxChars - 80) {
			kept.push(line);
			used += cost;
		} else {
			omitted++;
		}
	}
	kept.push(`[${omitted} more entries omitted: prompt budget reached. Ask for the full list if you need it.]`);
	return kept.join("\n");
}

function truncateHeadTail(content: string, maxChars: number, hint: string): string {
	const marker = `\n\n[... ${hint} ...]\n\n`;
	const room = Math.max(0, maxChars - marker.length);
	const head = Math.floor(room * 0.6);
	const tail = room - head;
	return `${content.slice(0, head).trimEnd()}${marker}${content.slice(content.length - tail).trimStart()}`;
}

function applyOverflow(
	definition: PromptSectionDefinition,
	content: string,
	diagnostics: PromptDiagnostic[],
): { content: string; truncated: boolean } {
	if (content.length <= definition.maxChars) {
		return { content, truncated: false };
	}

	switch (definition.overflow) {
		case "omit":
			diagnostics.push({
				level: "warning",
				sectionId: definition.id,
				message: `${content.length} chars exceeds the ${definition.maxChars} char budget; section omitted.`,
			});
			return { content: "", truncated: true };
		case "truncate-items":
			diagnostics.push({
				level: "warning",
				sectionId: definition.id,
				message: `${content.length} chars exceeds the ${definition.maxChars} char budget; trailing entries dropped.`,
			});
			return { content: truncateItems(content, definition.maxChars), truncated: true };
		case "truncate-head-tail":
			diagnostics.push({
				level: "warning",
				sectionId: definition.id,
				message: `${content.length} chars exceeds the ${definition.maxChars} char budget; middle truncated. Run /context detail, and move procedures into workspace skills so they load on demand.`,
			});
			return {
				content: truncateHeadTail(content, definition.maxChars, "truncated: see /context detail"),
				truncated: true,
			};
		case "error":
			// Runtime-authored text overflowing its budget is a development error, not a
			// user problem: fail the build's diagnostics (tests assert on them) but still
			// ship a bounded prompt rather than crashing a live channel.
			diagnostics.push({
				level: "error",
				sectionId: definition.id,
				message: `runtime-authored section is ${content.length} chars, over its ${definition.maxChars} char budget. Shorten it in src/agent/prompt/sections.ts.`,
			});
			return {
				content: truncateHeadTail(content, definition.maxChars, "runtime section over budget"),
				truncated: true,
			};
	}
}

function resolve(
	definition: PromptSectionDefinition,
	context: PromptBuildContext,
	diagnostics: PromptDiagnostic[],
): ResolvedPromptSection | undefined {
	if (definition.modes && !definition.modes.includes(context.mode)) {
		return undefined;
	}
	if (definition.requiresAllTools?.some((name) => !context.tools.some((tool) => tool.name === name))) {
		return undefined;
	}

	const raw = definition.render(context)?.trim();
	if (!raw) {
		return undefined;
	}

	const { content, truncated } = applyOverflow(definition, raw, diagnostics);
	if (!content) {
		return undefined;
	}

	return {
		id: definition.id,
		order: definition.order,
		source: definition.source,
		authority: definition.authority,
		cacheClass: definition.cacheClass,
		content,
		rawChars: raw.length,
		injectedChars: content.length,
		rawUnits: countPromptUnits(raw),
		injectedUnits: countPromptUnits(content),
		truncated,
		sha256: sha256(content),
	};
}

export function buildPipiclawSystemPrompt(
	context: PromptBuildContext,
	definitions: PromptSectionDefinition[] = MAIN_PROMPT_SECTIONS,
): PromptBuildResult {
	const diagnostics: PromptDiagnostic[] = [];

	const ids = new Set<string>();
	const orders = new Set<number>();
	for (const definition of [...definitions, FINAL_BOUNDARY_SECTION]) {
		if (ids.has(definition.id)) throw new Error(`Duplicate prompt section id: ${definition.id}`);
		if (orders.has(definition.order)) throw new Error(`Duplicate prompt section order: ${definition.order}`);
		ids.add(definition.id);
		orders.add(definition.order);
	}

	const sections = [...definitions]
		.sort((a, b) => a.order - b.order)
		.map((definition) => resolve(definition, context, diagnostics))
		.filter((section): section is ResolvedPromptSection => section !== undefined);

	const footerSection = resolve(FINAL_BOUNDARY_SECTION, context, diagnostics);
	const text = sections.map((section) => section.content).join("\n\n");
	const footer = footerSection?.content ?? "";
	const allSections = footerSection ? [...sections, footerSection] : sections;
	const totalChars = text.length + footer.length;

	// The only budget enforced at build time: the sections Pipiclaw authors (spec 026 §10.3).
	// SOUL/AGENTS are budgeted independently in resources.ts; skills are rendered by pi.
	const runtimeAuthoredUnits = allSections
		.filter((section) => RUNTIME_AUTHORED_SECTION_IDS.has(section.id))
		.reduce((sum, section) => sum + section.injectedUnits, 0);
	const totalUnits = allSections.reduce((sum, section) => sum + section.injectedUnits, 0);

	if (runtimeAuthoredUnits > RUNTIME_PROMPT_HARD_UNITS) {
		diagnostics.push({
			level: "error",
			sectionId: "prompt",
			message: `runtime-authored prompt is ${runtimeAuthoredUnits} units, over the ${RUNTIME_PROMPT_HARD_UNITS} unit hard cap. Shorten the runtime sections in src/agent/prompt/sections.ts.`,
		});
	} else if (runtimeAuthoredUnits > RUNTIME_PROMPT_TARGET_UNITS) {
		diagnostics.push({
			level: "warning",
			sectionId: "prompt",
			message: `runtime-authored prompt is ${runtimeAuthoredUnits} units, over the ${RUNTIME_PROMPT_TARGET_UNITS} unit target. Run /context detail and trim the runtime sections.`,
		});
	}

	return {
		text,
		footer,
		sections: allSections,
		diagnostics,
		totalChars,
		totalUnits,
		runtimeAuthoredUnits,
		estimatedTokens: estimateTokens(text) + estimateTokens(footer),
		fingerprint: sha256(`v${RUNTIME_PROMPT_VERSION}\n${text}\n${footer}`),
	};
}
