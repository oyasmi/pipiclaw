import { splitH2Sections } from "../shared/markdown-sections.js";
import { clipText } from "../shared/text-utils.js";
import { buildMemoryCandidateId } from "./candidates.js";
import { parseChannelMemoryEntries } from "./files.js";

const FIRST_TURN_MEMORY_SNAPSHOT_MAX_CHARS = 3_000;
const MIN_SECTION_BUDGET = 600;
const CHANNEL_MEMORY_WEIGHT = 0.6;

function normalizeContent(content: string): string {
	return content.replace(/\r/g, "").trim();
}

function hasVisibleContent(content: string): boolean {
	return content.replace(/<!--[\s\S]*?-->/g, "").trim().length > 0;
}

// Channel MEMORY.md is "structured sections up top, `## Update <ts>` blocks appended
// at the tail". A plain head clip would drop the newest facts, so pick sections by
// priority (structured first, then newest Update blocks) but render in document order
// for readability.
function selectChannelMemoryForBootstrap(content: string, budget: number): string {
	const sections = splitH2Sections(content).filter((section) => hasVisibleContent(section.content));
	if (sections.length === 0) {
		return clipText(content, budget, { headRatio: 1 });
	}

	const renderSection = (section: { heading: string; content: string }): string =>
		`## ${section.heading}\n\n${section.content}`;
	const structured = sections.filter((section) => !section.heading.startsWith("Update "));
	const updatesNewestFirst = sections.filter((section) => section.heading.startsWith("Update ")).reverse();
	const byPriority = [...structured, ...updatesNewestFirst];

	const chosen = new Set<(typeof sections)[number]>();
	let used = 0;
	for (const section of byPriority) {
		const cost = (chosen.size > 0 ? 2 : 0) + renderSection(section).length;
		if (used + cost <= budget) {
			chosen.add(section);
			used += cost;
		}
	}

	if (chosen.size === 0) {
		return clipText(renderSection(byPriority[0]), budget, { headRatio: 0.5 });
	}

	return sections
		.filter((section) => chosen.has(section))
		.map(renderSection)
		.join("\n\n");
}

function allocateBudgets(channelMemory: string, workspaceMemory: string, maxChars: number): [number, number] {
	if (!channelMemory && !workspaceMemory) {
		return [0, 0];
	}
	if (!channelMemory) {
		return [0, maxChars];
	}
	if (!workspaceMemory) {
		return [maxChars, 0];
	}

	const channelBudget = Math.max(MIN_SECTION_BUDGET, Math.floor(maxChars * CHANNEL_MEMORY_WEIGHT));
	const workspaceBudget = Math.max(MIN_SECTION_BUDGET, maxChars - channelBudget);
	const remainder = maxChars - channelBudget - workspaceBudget;
	return [channelBudget + Math.max(0, remainder), workspaceBudget];
}

export interface FirstTurnMemoryBootstrapOptions {
	channelMemory: string;
	workspaceMemory: string;
	maxChars?: number;
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
	const maxChars = options.maxChars ?? FIRST_TURN_MEMORY_SNAPSHOT_MAX_CHARS;
	const channelMemory = normalizeContent(options.channelMemory);
	const workspaceMemory = normalizeContent(options.workspaceMemory);

	if (!channelMemory && !workspaceMemory) {
		return { renderedText: "", includedCandidateIds: [] };
	}

	const [channelBudget, workspaceBudget] = allocateBudgets(channelMemory, workspaceMemory, maxChars);
	const sections: string[] = [
		"<durable_memory_snapshot>",
		"Durable memory bootstrap for the first user turn in this session.",
		"Use it as background context together with any turn-specific recalled snippets.",
	];
	const includedCandidateIds: string[] = [];

	if (channelMemory) {
		const selectedChannelMemory =
			channelBudget > 0 ? selectChannelMemoryForBootstrap(channelMemory, channelBudget) : channelMemory;
		sections.push("", "[Channel MEMORY.md]");
		sections.push(selectedChannelMemory);
		includedCandidateIds.push(...parseChannelMemoryEntries(selectedChannelMemory).map((entry) => entry.id));
	}

	if (workspaceMemory) {
		const selectedWorkspaceMemory =
			workspaceBudget > 0 ? clipText(workspaceMemory, workspaceBudget, { headRatio: 1 }) : workspaceMemory;
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
