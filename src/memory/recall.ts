import type { Api, Model } from "@mariozechner/pi-ai";
import { parseJsonObject } from "../llm-json.js";
import { buildMemoryCandidates, type MemoryCandidate, type MemoryCandidateCache } from "./candidates.js";
import { HAN_REGEX } from "../shared/text-utils.js";
import { runSidecarTask } from "../sidecar-worker.js";

export interface RecallRequest {
	query: string;
	workspaceDir: string;
	channelDir: string;
	allowedSources?: MemoryCandidate["source"][];
	maxCandidates: number;
	maxInjected: number;
	maxChars: number;
	rerankWithModel: boolean;
	autoRerank?: boolean;
	model: Model<Api>;
	resolveApiKey: (model: Model<Api>) => Promise<string>;
	candidateCache?: MemoryCandidateCache;
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

const TOKEN_PART_REGEX = /[\p{Script=Han}]+|[\p{L}\p{N}_./-]+/gu;
const MEMORY_RECALL_RERANK_TIMEOUT_MS = 5_000;

function containsHanText(text: string): boolean {
	return HAN_REGEX.test(text);
}

function tokenizeHanPart(part: string): string[] {
	const chars = Array.from(part);
	const tokens: string[] = [];
	for (const size of [2, 3]) {
		if (chars.length < size) {
			continue;
		}
		for (let index = 0; index <= chars.length - size; index++) {
			tokens.push(chars.slice(index, index + size).join(""));
		}
	}
	return tokens;
}

function tokenize(text: string): string[] {
	const parts = text.toLowerCase().match(TOKEN_PART_REGEX) ?? [];
	const tokens: string[] = [];
	for (const part of parts) {
		if (containsHanText(part)) {
			tokens.push(...tokenizeHanPart(part));
			continue;
		}
		if (part.length >= 2) {
			tokens.push(part);
		}
	}
	return Array.from(new Set(tokens));
}

function computeTokenOverlapScore(queryTokens: string[], text: string, weight: number): number {
	const haystack = new Set(tokenize(text));
	let score = 0;
	for (const token of queryTokens) {
		if (haystack.has(token)) {
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

function buildFallbackCandidates(
	request: RecallRequest,
	candidates: MemoryCandidate[],
	existing: Array<{ candidate: MemoryCandidate; score: number }>,
): Array<{ candidate: MemoryCandidate; score: number }> {
	if (!containsHanText(request.query) && existing.length > 0) {
		return existing;
	}

	const seen = new Set(existing.map(({ candidate }) => candidate.id));
	const seeded = [...existing];
	const limit = Math.max(request.maxCandidates, request.maxInjected);

	for (const candidate of candidates
		.filter((item) => item.source === "channel-session" || item.source === "channel-memory")
		.sort((a, b) => b.priority - a.priority || a.title.localeCompare(b.title))) {
		if (seen.has(candidate.id)) {
			continue;
		}
		seeded.push({ candidate, score: candidate.priority });
		seen.add(candidate.id);
		if (seeded.length >= limit) {
			break;
		}
	}

	return seeded;
}

async function rerankCandidates(
	request: RecallRequest,
	candidates: Array<{ candidate: MemoryCandidate; score: number }>,
): Promise<Array<{ candidate: MemoryCandidate; score: number }>> {
	if ((!request.rerankWithModel && !request.autoRerank) || candidates.length <= request.maxInjected) {
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
			timeoutMs: MEMORY_RECALL_RERANK_TIMEOUT_MS,
			parse: (text) => {
				const parsed = parseJsonObject(text) as { selectedIds?: unknown };
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
		cache: request.candidateCache,
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
		.sort((a, b) => b.score - a.score || a.candidate.title.localeCompare(b.candidate.title));

	const shortlist = buildFallbackCandidates(request, filteredCandidates, scored)
		.sort(
			(a, b) =>
				b.score - a.score ||
				b.candidate.priority - a.candidate.priority ||
				a.candidate.title.localeCompare(b.candidate.title),
		)
		.slice(0, Math.max(request.maxCandidates, request.maxInjected));

	if (shortlist.length === 0) {
		return { items: [], renderedText: "" };
	}

	const reranked = await rerankCandidates(request, shortlist);
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
