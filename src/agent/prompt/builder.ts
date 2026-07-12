/**
 * Prompt pipeline: filter → sort → render → budget → fingerprint (spec 025).
 *
 * The output is deterministic: same build context in, same bytes and same
 * fingerprint out. Nothing here may read the clock, the filesystem iteration
 * order, a channel id, or anything else that would make two channels in one
 * workspace disagree — that is what makes the provider-side prompt cache hold.
 */

import { createHash } from "node:crypto";
import { FINAL_BOUNDARY_SECTION, MAIN_PROMPT_SECTIONS } from "./sections.js";
import type {
	PromptBuildContext,
	PromptBuildResult,
	PromptDiagnostic,
	PromptSectionDefinition,
	ResolvedPromptSection,
} from "./types.js";

/** Bumped whenever the runtime-authored prompt text changes in a way worth attributing in telemetry. */
export const RUNTIME_PROMPT_VERSION = 2;

/** Above this the prompt still works but is worth a warning. */
export const SOFT_TOTAL_BUDGET_CHARS = 20_000;
/**
 * Above this we shrink user-owned catalogs and files; runtime core is never cut.
 *
 * Both totals cover the Pipiclaw-owned sections only. pi renders `<available_skills>`
 * after them and Pipiclaw cannot trim that list without also destroying `/skill:name`
 * (spec 025 §6.10), so skills are *warned about* here, not shrunk: the prompt actually
 * sent can exceed this cap by the size of the skills catalog.
 */
export const HARD_TOTAL_BUDGET_CHARS = 32_000;
/** Skills are pi's to render; over this we can only tell the operator (spec 025 §8.1). */
export const SKILLS_BUDGET_CHARS = 6_000;

/**
 * Least-important first: the order in which sections give up characters when the
 * whole prompt exceeds the hard cap (spec 025 §8.2). Runtime-authored sections
 * are absent by design — they are never shrunk.
 */
const SHRINK_ORDER = ["subagents", "playbooks", "workspace.agents", "workspace.soul"];
/** A shrunk workspace file still keeps this much of itself; below it, the file says nothing useful. */
const MIN_SHRUNK_SECTION_CHARS = 800;

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
		truncated,
		sha256: sha256(content),
	};
}

/** Re-shrink user-owned sections until the whole prompt fits the hard cap. */
function enforceTotalBudget(sections: ResolvedPromptSection[], diagnostics: PromptDiagnostic[]): void {
	const total = () => sections.reduce((sum, section) => sum + section.injectedChars, 0) + 2 * (sections.length - 1);

	for (const id of SHRINK_ORDER) {
		if (total() <= HARD_TOTAL_BUDGET_CHARS) {
			return;
		}
		const index = sections.findIndex((section) => section.id === id);
		if (index < 0) continue;

		const section = sections[index];
		const overBy = total() - HARD_TOTAL_BUDGET_CHARS;
		const target = section.injectedChars - overBy;
		if (target < MIN_SHRUNK_SECTION_CHARS) {
			sections.splice(index, 1);
			diagnostics.push({
				level: "warning",
				sectionId: id,
				message: `dropped to keep the prompt under the ${HARD_TOTAL_BUDGET_CHARS} char hard cap. Run /context detail to see what is competing for space.`,
			});
			continue;
		}
		const content = truncateHeadTail(section.content, target, "shrunk to fit the total prompt budget");
		sections[index] = {
			...section,
			content,
			injectedChars: content.length,
			truncated: true,
			sha256: sha256(content),
		};
		diagnostics.push({
			level: "warning",
			sectionId: id,
			message: `shrunk to fit the ${HARD_TOTAL_BUDGET_CHARS} char hard cap. Run /context detail.`,
		});
	}

	if (total() > HARD_TOTAL_BUDGET_CHARS) {
		diagnostics.push({
			level: "error",
			sectionId: "prompt",
			message: `system prompt is ${total()} chars, over the ${HARD_TOTAL_BUDGET_CHARS} char hard cap even after shrinking every user-owned section.`,
		});
	}
}

/**
 * What pi's `<available_skills>` block will cost, close enough to budget against:
 * name, description and location inside a five-line XML wrapper, plus the preamble.
 */
export function estimateSkillsPromptChars(skills: PromptBuildContext["skills"]): number {
	if (!skills || skills.length === 0) return 0;
	const SKILL_WRAPPER_CHARS = 90;
	const PREAMBLE_CHARS = 290;
	return (
		PREAMBLE_CHARS +
		skills.reduce((sum, skill) => sum + skill.name.length + skill.description.length + SKILL_WRAPPER_CHARS, 0)
	);
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

	enforceTotalBudget(sections, diagnostics);

	const footerSection = resolve(FINAL_BOUNDARY_SECTION, context, diagnostics);
	const text = sections.map((section) => section.content).join("\n\n");
	const footer = footerSection?.content ?? "";
	const allSections = footerSection ? [...sections, footerSection] : sections;
	const totalChars = text.length + footer.length;

	if (totalChars > SOFT_TOTAL_BUDGET_CHARS) {
		diagnostics.push({
			level: "warning",
			sectionId: "prompt",
			message: `system prompt is ${totalChars} chars, over the ${SOFT_TOTAL_BUDGET_CHARS} char soft target. Run /context detail.`,
		});
	}

	// Skills sit outside every budget above: pi renders them and owns the same list that
	// backs `/skill:name`, so trimming here would delete commands. Report instead of cut.
	const skillsChars = estimateSkillsPromptChars(context.skills);
	if (skillsChars > SKILLS_BUDGET_CHARS) {
		diagnostics.push({
			level: "warning",
			sectionId: "skills",
			message: `skills catalog is ≈${skillsChars} chars, over the ${SKILLS_BUDGET_CHARS} char budget, and is appended after the sections above (Pipiclaw cannot trim it without dropping /skill:name). Run /context detail, then shorten or remove workspace skill descriptions.`,
		});
	}

	return {
		text,
		footer,
		sections: allSections,
		diagnostics,
		totalChars,
		estimatedTokens: estimateTokens(text) + estimateTokens(footer),
		fingerprint: sha256(`v${RUNTIME_PROMPT_VERSION}\n${text}\n${footer}`),
	};
}
