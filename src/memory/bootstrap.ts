import { clipText } from "../shared/text-utils.js";

const FIRST_TURN_MEMORY_SNAPSHOT_MAX_CHARS = 3_000;
const MIN_SECTION_BUDGET = 600;
const CHANNEL_MEMORY_WEIGHT = 0.6;

function normalizeContent(content: string): string {
	return content.replace(/\r/g, "").trim();
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

export function buildFirstTurnMemoryBootstrap(options: FirstTurnMemoryBootstrapOptions): string {
	const maxChars = options.maxChars ?? FIRST_TURN_MEMORY_SNAPSHOT_MAX_CHARS;
	const channelMemory = normalizeContent(options.channelMemory);
	const workspaceMemory = normalizeContent(options.workspaceMemory);

	if (!channelMemory && !workspaceMemory) {
		return "";
	}

	const [channelBudget, workspaceBudget] = allocateBudgets(channelMemory, workspaceMemory, maxChars);
	const sections: string[] = [
		"<durable_memory_snapshot>",
		"Durable memory bootstrap for the first user turn in this session.",
		"Use it as background context together with any turn-specific recalled snippets.",
	];

	if (channelMemory) {
		sections.push("", "[Channel MEMORY.md]");
		sections.push(channelBudget > 0 ? clipText(channelMemory, channelBudget, { headRatio: 1 }) : channelMemory);
	}

	if (workspaceMemory) {
		sections.push("", "[Workspace MEMORY.md]");
		sections.push(
			workspaceBudget > 0 ? clipText(workspaceMemory, workspaceBudget, { headRatio: 1 }) : workspaceMemory,
		);
	}

	sections.push("</durable_memory_snapshot>");
	return sections.join("\n");
}
