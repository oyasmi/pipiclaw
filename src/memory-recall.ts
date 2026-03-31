import type { Api, Model } from "@mariozechner/pi-ai";
import { buildMemoryCandidates, type MemoryCandidate } from "./memory-candidates.js";
import { runSidecarTask } from "./sidecar-worker.js";

export interface RecallRequest {
	query: string;
	workspaceDir: string;
	channelDir: string;
	allowedSources?: MemoryCandidate["source"][];
	maxCandidates: number;
	maxInjected: number;
	maxChars: number;
	rerankWithModel: boolean;
	model: Model<Api>;
	resolveApiKey: (model: Model<Api>) => Promise<string>;
}

export interface RecalledMemory {
	source: MemoryCandidate["source"];
	path: string;
	title: string;
	content: string;
	score: number;
}

export interface RecallResult {
	items: RecalledMemory[];
	renderedText: string;
}

const RERANK_SYSTEM_PROMPT = `You are selecting which memory snippets are most relevant to the current user turn.

Return strict JSON only:
{
  "selectedIds": ["candidate-id"]
}

Rules:
- Select only snippets that are clearly useful for answering the current turn.
- Prefer current work state, constraints, active files, recent corrections, and durable decisions.
- If nothing is clearly useful, return an empty array.
- Do not rewrite the candidates. Only return candidate ids.`;

function tokenize(text: string): string[] {
	return Array.from(
		new Set(
			text
				.toLowerCase()
				.split(/[^\p{L}\p{N}_./-]+/u)
				.map((token) => token.trim())
				.filter((token) => token.length >= 2),
		),
	);
}

function computeTokenOverlapScore(queryTokens: string[], text: string, weight: number): number {
	const haystack = text.toLowerCase();
	let score = 0;
	for (const token of queryTokens) {
		if (haystack.includes(token)) {
			score += weight;
		}
	}
	return score;
}

function computeRecencyBoost(timestamp: string | undefined): number {
	if (!timestamp) return 0;
	const timestampMs = Date.parse(timestamp);
	if (!Number.isFinite(timestampMs)) return 0;

	const ageMs = Date.now() - timestampMs;
	const dayMs = 24 * 60 * 60 * 1000;
	if (ageMs <= dayMs) return 8;
	if (ageMs <= 7 * dayMs) return 5;
	if (ageMs <= 30 * dayMs) return 2;
	return 0;
}

function scoreCandidate(queryTokens: string[], candidate: MemoryCandidate): number {
	let score = candidate.priority;
	score += computeTokenOverlapScore(queryTokens, candidate.title, 10);
	score += computeTokenOverlapScore(queryTokens, candidate.content, 3);
	score += computeTokenOverlapScore(queryTokens, candidate.path, 6);
	score += computeRecencyBoost(candidate.timestamp);
	return score;
}

function extractJsonObject(text: string): string {
	const trimmed = text.trim();
	if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
		return trimmed;
	}

	const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenceMatch?.[1]) {
		return fenceMatch[1].trim();
	}

	const firstBrace = trimmed.indexOf("{");
	const lastBrace = trimmed.lastIndexOf("}");
	if (firstBrace >= 0 && lastBrace > firstBrace) {
		return trimmed.slice(firstBrace, lastBrace + 1);
	}

	return trimmed;
}

async function rerankCandidates(
	request: RecallRequest,
	candidates: Array<{ candidate: MemoryCandidate; score: number }>,
): Promise<Array<{ candidate: MemoryCandidate; score: number }>> {
	if (!request.rerankWithModel || candidates.length <= request.maxInjected) {
		return candidates;
	}

	const renderedCandidates = candidates
		.map(({ candidate, score }) => {
			const clippedContent =
				candidate.content.length > 300 ? `${candidate.content.slice(0, 300)}...` : candidate.content;
			return [
				`id: ${candidate.id}`,
				`source: ${candidate.source}`,
				`title: ${candidate.title}`,
				`path: ${candidate.path}`,
				`score: ${score}`,
				`content: ${clippedContent}`,
			].join("\n");
		})
		.join("\n\n---\n\n");

	try {
		const result = await runSidecarTask({
			name: "memory-recall-rerank",
			model: request.model,
			resolveApiKey: request.resolveApiKey,
			systemPrompt: RERANK_SYSTEM_PROMPT,
			prompt: `User turn:\n${request.query.trim()}\n\nCandidates:\n${renderedCandidates}`,
			parse: (text) => {
				const parsed = JSON.parse(extractJsonObject(text)) as { selectedIds?: unknown };
				return Array.isArray(parsed.selectedIds)
					? parsed.selectedIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
					: [];
			},
		});

		const selectedIds = new Set(result.output);
		if (selectedIds.size === 0) {
			return candidates;
		}

		const selected = candidates.filter(({ candidate }) => selectedIds.has(candidate.id));
		return selected.length > 0 ? selected : candidates;
	} catch {
		return candidates;
	}
}

function renderRecallResult(items: RecalledMemory[], maxChars: number): string {
	if (items.length === 0) {
		return "";
	}

	const lines: string[] = ["<runtime_context>", "Relevant context for this turn:"];
	for (const item of items) {
		lines.push("");
		lines.push(`[${item.source}/${item.title}]`);
		lines.push(`Path: ${item.path}`);
		lines.push(item.content);
	}
	lines.push("</runtime_context>");

	const rendered = lines.join("\n");
	if (rendered.length <= maxChars) {
		return rendered;
	}

	const clippedLines = ["<runtime_context>", "Relevant context for this turn:"];
	let usedChars = clippedLines.join("\n").length + "</runtime_context>".length + 2;
	for (const item of items) {
		const block = ["", `[${item.source}/${item.title}]`, `Path: ${item.path}`, item.content].join("\n");
		if (usedChars + block.length > maxChars) {
			break;
		}
		clippedLines.push("", `[${item.source}/${item.title}]`, `Path: ${item.path}`, item.content);
		usedChars += block.length;
	}
	clippedLines.push("</runtime_context>");
	return clippedLines.join("\n");
}

export async function recallRelevantMemory(request: RecallRequest): Promise<RecallResult> {
	const query = request.query.trim();
	if (!query) {
		return { items: [], renderedText: "" };
	}

	const candidates = await buildMemoryCandidates({
		workspaceDir: request.workspaceDir,
		channelDir: request.channelDir,
	});
	const filteredCandidates = request.allowedSources?.length
		? candidates.filter((candidate) => request.allowedSources?.includes(candidate.source))
		: candidates;
	if (filteredCandidates.length === 0) {
		return { items: [], renderedText: "" };
	}

	const queryTokens = tokenize(query);
	const scored = filteredCandidates
		.map((candidate) => ({ candidate, score: scoreCandidate(queryTokens, candidate) }))
		.filter(({ score }) => score > 0)
		.sort((a, b) => b.score - a.score || a.candidate.title.localeCompare(b.candidate.title))
		.slice(0, Math.max(request.maxCandidates, request.maxInjected));

	if (scored.length === 0) {
		return { items: [], renderedText: "" };
	}

	const reranked = await rerankCandidates(request, scored);
	const items = reranked.slice(0, request.maxInjected).map(({ candidate, score }) => ({
		source: candidate.source,
		path: candidate.path,
		title: candidate.title,
		content: candidate.content,
		score,
	}));

	return {
		items,
		renderedText: renderRecallResult(items, request.maxChars),
	};
}
