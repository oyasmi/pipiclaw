import { splitH2Sections } from "../shared/markdown-sections.js";
import { clipTextByPromptUnits, countPromptUnits } from "../shared/prompt-units.js";
import { stripCrAndTrim } from "../shared/text-utils.js";
import { type MemoryEntry, renderMemoryIndex } from "./store.js";

/**
 * Spec 050, D1/D4/D11: what actually goes into `<memory_bootstrap>` on the first turn, and the
 * budget tiering when the channel index does not fit.
 *
 * Budgets are code constants, reallocated inside spec 026 §5.3's automatic-context share.
 */
export const WORKSPACE_MEMORY_MAX_UNITS = 500;
export const CHANNEL_INDEX_MAX_UNITS = 1_400;
export const JOURNAL_TAIL_MAX_UNITS = 400;
const WORKSPACE_MEMORY_MAX_CHARS = 4_000;
const JOURNAL_TAIL_MAX_CHARS = 3_000;

const ALWAYS_INCLUDED: ReadonlySet<MemoryEntry["type"]> = new Set(["user", "feedback"]);

export interface TieredIndexResult {
	text: string;
	includedNames: string[];
	omittedCount: number;
	/** The full index did not fit; the reflect pass should run in `condense` mode. */
	overBudget: boolean;
}

/**
 * D4: full index if it fits; otherwise `user` + `feedback` entries in full, then
 * `project` / `reference` by `updated` descending until the budget is spent, with a
 * trailing pointer to `memory_search`.
 */
export function buildChannelIndexForBootstrap(
	entries: MemoryEntry[],
	maxUnits: number = CHANNEL_INDEX_MAX_UNITS,
): TieredIndexResult {
	const full = renderMemoryIndex(entries);
	if (entries.length === 0 || countPromptUnits(full) <= maxUnits) {
		return { text: full, includedNames: entries.map((e) => e.name), omittedCount: 0, overBudget: false };
	}

	const pinned = entries.filter((e) => ALWAYS_INCLUDED.has(e.type));
	const droppable = entries
		.filter((e) => !ALWAYS_INCLUDED.has(e.type))
		.sort((a, b) => b.updated.localeCompare(a.updated) || a.name.localeCompare(b.name));

	let kept = droppable.length;
	let rendered = "";
	while (true) {
		const included = [...pinned, ...droppable.slice(0, kept)];
		const omitted = entries.length - included.length;
		rendered = renderMemoryIndex(included) + (omitted > 0 ? omittedLine(omitted) : "");
		if (kept === 0 || countPromptUnits(rendered) <= maxUnits) {
			return {
				text: rendered,
				includedNames: included.map((e) => e.name),
				omittedCount: omitted,
				overBudget: true,
			};
		}
		kept--;
	}
}

function omittedLine(count: number): string {
	return `\n[- ${count} more ${count === 1 ? "entry" : "entries"} omitted; use memory_search]\n`;
}

/** D11: workspace MEMORY.md, whole H2 sections from the top until the budget is spent. */
export function clipWorkspaceMemoryForBootstrap(
	workspaceMemory: string,
	maxUnits: number = WORKSPACE_MEMORY_MAX_UNITS,
): string {
	const text = stripCrAndTrim(workspaceMemory);
	if (!text) {
		return "";
	}
	if (countPromptUnits(text) <= maxUnits && text.length <= WORKSPACE_MEMORY_MAX_CHARS) {
		return text;
	}
	const sections = splitH2Sections(text);
	if (sections.length === 0) {
		return clipTextByPromptUnits(text, maxUnits, {
			headRatio: 1,
			maxChars: WORKSPACE_MEMORY_MAX_CHARS,
			marker: "\n\n[... omitted for length ...]\n",
		}).text;
	}
	const head = text.slice(0, text.indexOf("## ") === -1 ? 0 : text.indexOf("## ")).trim();
	const kept: string[] = head ? [head] : [];
	let used = countPromptUnits(kept.join("\n\n"));
	let omitted = 0;
	for (const section of sections) {
		const block = `## ${section.heading}\n\n${section.content}`;
		const cost = countPromptUnits(block);
		if (used + cost <= maxUnits && kept.join("\n\n").length + block.length <= WORKSPACE_MEMORY_MAX_CHARS) {
			kept.push(block);
			used += cost;
		} else {
			omitted++;
		}
	}
	if (omitted > 0) {
		kept.push(`[... ${omitted} more section(s) omitted; read workspace/MEMORY.md ...]`);
	}
	return kept.join("\n\n");
}

/** Tail of a journal day, clipped to the injection budget (head dropped, newest kept). */
export function clipJournalTailForBootstrap(journalText: string, maxUnits: number = JOURNAL_TAIL_MAX_UNITS): string {
	const text = stripCrAndTrim(journalText);
	if (!text) {
		return "";
	}
	return clipTextByPromptUnits(text, maxUnits, {
		headRatio: 0,
		maxChars: JOURNAL_TAIL_MAX_CHARS,
		marker: "[... earlier entries omitted ...]\n",
	}).text;
}
