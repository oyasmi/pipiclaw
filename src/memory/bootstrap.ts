import { splitH2Sections } from "../shared/markdown-sections.js";
import { clipTextByPromptUnits, countPromptUnits } from "../shared/prompt-units.js";
import { buildMemoryCandidateId } from "./candidates.js";
import { parseChannelMemoryEntries } from "./files.js";

const FIRST_TURN_MEMORY_SNAPSHOT_MAX_CHARS = 3_000;
/**
 * Automatic-context share for the first-turn durable snapshot (spec 026 §5.3).
 * It is a fallback, not a full memory dump: turn-specific recall carries the rest.
 */
export const FIRST_TURN_BOOTSTRAP_MAX_UNITS = 400;
const MIN_SECTION_CHARS = 600;
const MIN_SECTION_UNITS = 100;
const CHANNEL_MEMORY_WEIGHT = 0.6;

interface Budget {
	chars: number;
	units: number;
}

const ZERO_BUDGET: Budget = { chars: 0, units: 0 };

function normalizeContent(content: string): string {
	return content.replace(/\r/g, "").trim();
}

function hasVisibleContent(content: string): boolean {
	return content.replace(/<!--[\s\S]*?-->/g, "").trim().length > 0;
}

/** Keep `text` within both the char and unit ceilings, head/tail (or head-only when headRatio ≥ 1). */
function clipToBudget(text: string, budget: Budget, headRatio: number): string {
	return clipTextByPromptUnits(text, budget.units, {
		headRatio,
		maxChars: budget.chars,
		marker: "\n\n[... omitted for length ...]\n\n",
	}).text;
}

// Channel MEMORY.md is "structured sections up top, `## Update <ts>` blocks appended
// at the tail". A plain head clip would drop the newest facts, so pick sections by
// priority (structured first, then newest Update blocks) but render in document order
// for readability. A section is kept only if it fits both the char and unit budget.
function selectChannelMemoryForBootstrap(content: string, budget: Budget): string {
	const sections = splitH2Sections(content).filter((section) => hasVisibleContent(section.content));
	if (sections.length === 0) {
		return clipToBudget(content, budget, 1);
	}

	const renderSection = (section: { heading: string; content: string }): string =>
		`## ${section.heading}\n\n${section.content}`;
	const structured = sections.filter((section) => !section.heading.startsWith("Update "));
	const updatesNewestFirst = sections.filter((section) => section.heading.startsWith("Update ")).reverse();
	const byPriority = [...structured, ...updatesNewestFirst];

	const chosen = new Set<(typeof sections)[number]>();
	let usedChars = 0;
	let usedUnits = 0;
	for (const section of byPriority) {
		const text = renderSection(section);
		const separatorChars = chosen.size > 0 ? 2 : 0;
		const costChars = separatorChars + text.length;
		const costUnits = countPromptUnits(text); // section separators are whitespace → 0 units
		if (usedChars + costChars <= budget.chars && usedUnits + costUnits <= budget.units) {
			chosen.add(section);
			usedChars += costChars;
			usedUnits += costUnits;
		}
	}

	if (chosen.size === 0) {
		return clipToBudget(renderSection(byPriority[0]), budget, 0.5);
	}

	return sections
		.filter((section) => chosen.has(section))
		.map(renderSection)
		.join("\n\n");
}

/** Split the total budget across channel (60%) and workspace memory in both dimensions. */
function splitBudget(max: Budget): [Budget, Budget] {
	const channelChars = Math.max(MIN_SECTION_CHARS, Math.floor(max.chars * CHANNEL_MEMORY_WEIGHT));
	const workspaceChars = Math.max(MIN_SECTION_CHARS, max.chars - channelChars);
	const channelUnits = Math.max(MIN_SECTION_UNITS, Math.floor(max.units * CHANNEL_MEMORY_WEIGHT));
	const workspaceUnits = Math.max(MIN_SECTION_UNITS, max.units - channelUnits);
	const channel: Budget = {
		chars: channelChars + Math.max(0, max.chars - channelChars - workspaceChars),
		units: channelUnits + Math.max(0, max.units - channelUnits - workspaceUnits),
	};
	return [channel, { chars: workspaceChars, units: workspaceUnits }];
}

function allocateBudgets(channelMemory: string, workspaceMemory: string, max: Budget): [Budget, Budget] {
	if (!channelMemory && !workspaceMemory) {
		return [ZERO_BUDGET, ZERO_BUDGET];
	}
	if (!channelMemory) {
		return [ZERO_BUDGET, max];
	}
	if (!workspaceMemory) {
		return [max, ZERO_BUDGET];
	}
	return splitBudget(max);
}

export interface FirstTurnMemoryBootstrapOptions {
	channelMemory: string;
	workspaceMemory: string;
	maxChars?: number;
	maxUnits?: number;
}

export interface FirstTurnMemoryBootstrapResult {
	renderedText: string;
	includedCandidateIds: string[];
}

export function buildFirstTurnMemoryBootstrap(options: FirstTurnMemoryBootstrapOptions): string {
	return buildFirstTurnMemoryBootstrapResult(options).renderedText;
}

export function buildFirstTurnMemoryBootstrapResult(
	options: FirstTurnMemoryBootstrapOptions,
): FirstTurnMemoryBootstrapResult {
	const max: Budget = {
		chars: options.maxChars ?? FIRST_TURN_MEMORY_SNAPSHOT_MAX_CHARS,
		units: options.maxUnits ?? FIRST_TURN_BOOTSTRAP_MAX_UNITS,
	};
	const channelMemory = normalizeContent(options.channelMemory);
	const workspaceMemory = normalizeContent(options.workspaceMemory);

	if (!channelMemory && !workspaceMemory) {
		return { renderedText: "", includedCandidateIds: [] };
	}

	const [channelBudget, workspaceBudget] = allocateBudgets(channelMemory, workspaceMemory, max);
	const sections: string[] = [
		"<durable_memory_snapshot>",
		"Durable memory bootstrap for the first user turn in this session.",
		"Use it as background context together with any turn-specific recalled snippets.",
	];
	const includedCandidateIds: string[] = [];

	if (channelMemory) {
		const selectedChannelMemory =
			channelBudget.chars > 0 ? selectChannelMemoryForBootstrap(channelMemory, channelBudget) : channelMemory;
		sections.push("", "[Channel MEMORY.md]");
		sections.push(selectedChannelMemory);
		includedCandidateIds.push(...parseChannelMemoryEntries(selectedChannelMemory).map((entry) => entry.id));
	}

	if (workspaceMemory) {
		const selectedWorkspaceMemory =
			workspaceBudget.chars > 0 ? clipToBudget(workspaceMemory, workspaceBudget, 1) : workspaceMemory;
		sections.push("", "[Workspace MEMORY.md]");
		sections.push(selectedWorkspaceMemory);
		includedCandidateIds.push(
			...splitH2Sections(selectedWorkspaceMemory).map((section) =>
				buildMemoryCandidateId("workspace-memory", section.heading),
			),
		);
	}

	sections.push("</durable_memory_snapshot>");
	return { renderedText: sections.join("\n"), includedCandidateIds };
}
