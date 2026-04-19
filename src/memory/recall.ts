import type { Api, Model } from "@mariozechner/pi-ai";
import { parseJsonObject } from "../shared/llm-json.js";
import { HAN_REGEX } from "../shared/text-utils.js";
import {
	buildMemoryCandidates,
	createMemoryCandidateStore,
	type MemoryCandidate,
	type MemoryCandidateStore,
} from "./candidates.js";
import { COMMON_CHINESE_WORDS } from "./chinese-words.js";
import { runSidecarTask } from "./sidecar-worker.js";

export interface RecallRequest {
	query: string;
	workspaceDir: string;
	channelDir: string;
	allowedSources?: MemoryCandidate["source"][];
	maxCandidates: number;
	maxInjected: number;
	maxChars: number;
	rerankWithModel: boolean | "auto";
	autoRerank?: boolean;
	model: Model<Api>;
	resolveApiKey: (model: Model<Api>) => Promise<string>;
	candidateStore?: MemoryCandidateStore;
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

type QueryIntent = "current-state" | "next-steps" | "constraints" | "decisions" | "errors" | "history";

interface TokenMatchStats {
	matchedCount: number;
	coverage: number;
}

interface ScoredCandidate {
	candidate: MemoryCandidate;
	score: number;
	lexicalMatchCount: number;
	intentBoost: number;
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
const ASCII_SPLIT_REGEX = /[._/-]+/g;
const MEMORY_RECALL_RERANK_TIMEOUT_MS = 8_000;
const RERANK_CONTENT_CLIP = 800;
const HIGH_CONFIDENCE_SCORE = 36;
const CLOSE_SCORE_DELTA = 8;
const MAX_HAN_WORD_LENGTH = Array.from(COMMON_CHINESE_WORDS).reduce((max, word) => Math.max(max, word.length), 2);
const LATIN_STOP_WORDS = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"been",
	"being",
	"by",
	"can",
	"could",
	"did",
	"do",
	"does",
	"doing",
	"for",
	"from",
	"had",
	"has",
	"have",
	"here",
	"how",
	"i",
	"in",
	"is",
	"it",
	"its",
	"me",
	"my",
	"of",
	"on",
	"or",
	"our",
	"please",
	"should",
	"that",
	"the",
	"their",
	"them",
	"there",
	"these",
	"they",
	"this",
	"to",
	"was",
	"we",
	"were",
	"what",
	"when",
	"where",
	"which",
	"who",
	"why",
	"with",
	"would",
	"you",
	"your",
]);
const CHINESE_STOP_CHARS = new Set([
	"的",
	"了",
	"在",
	"是",
	"有",
	"不",
	"和",
	"与",
	"个",
	"把",
	"被",
	"从",
	"对",
	"而",
	"给",
	"将",
	"就",
	"让",
	"向",
	"也",
	"以",
	"因",
	"又",
	"于",
	"则",
	"之",
	"这",
	"那",
	"其",
	"它",
	"他",
	"她",
	"们",
	"都",
	"要",
	"会",
	"能",
	"很",
	"得",
	"地",
	"着",
	"过",
	"吗",
	"呢",
	"吧",
	"啊",
	"哦",
	"嗯",
	"呀",
]);

function containsHanText(text: string): boolean {
	return HAN_REGEX.test(text);
}

function tokenizeHanPart(part: string): string[] {
	const chars = Array.from(part);
	const covered = new Uint8Array(chars.length);
	const tokens: string[] = [];

	for (let index = 0; index < chars.length; index++) {
		let matchedLength = 0;
		const maxLength = Math.min(MAX_HAN_WORD_LENGTH, chars.length - index);
		for (let size = maxLength; size >= 2; size--) {
			const candidate = chars.slice(index, index + size).join("");
			if (COMMON_CHINESE_WORDS.has(candidate)) {
				tokens.push(candidate);
				matchedLength = size;
				break;
			}
		}
		if (matchedLength > 0) {
			for (let coveredIndex = index; coveredIndex < index + matchedLength; coveredIndex++) {
				covered[coveredIndex] = 1;
			}
		}
	}

	for (let index = 0; index <= chars.length - 2; index++) {
		if (covered[index] || covered[index + 1]) {
			continue;
		}
		tokens.push(chars.slice(index, index + 2).join(""));
	}

	for (let index = 0; index < chars.length; index++) {
		if (covered[index]) {
			continue;
		}
		const char = chars[index];
		if (!CHINESE_STOP_CHARS.has(char)) {
			tokens.push(char);
		}
	}

	return Array.from(new Set(tokens));
}

function tokenizeAsciiPart(part: string): string[] {
	const tokens: string[] = [];
	const normalized = part.toLowerCase();
	const segments = normalized.split(ASCII_SPLIT_REGEX).filter(Boolean);

	if (normalized.length >= 2 && !LATIN_STOP_WORDS.has(normalized)) {
		tokens.push(normalized);
	}

	for (const segment of segments) {
		if (segment.length >= 2 && !LATIN_STOP_WORDS.has(segment)) {
			tokens.push(segment);
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
		tokens.push(...tokenizeAsciiPart(part));
	}
	return Array.from(new Set(tokens));
}

export function tokenizeRecallText(text: string): string[] {
	return tokenize(text);
}

function buildTokenSet(text: string): Set<string> {
	return new Set(tokenize(text));
}

function computeTokenMatchStats(queryTokens: string[], text: string): TokenMatchStats {
	if (queryTokens.length === 0 || !text.trim()) {
		return { matchedCount: 0, coverage: 0 };
	}

	const haystack = buildTokenSet(text);
	let matchedCount = 0;
	for (const token of queryTokens) {
		if (haystack.has(token)) {
			matchedCount++;
		}
	}

	return {
		matchedCount,
		coverage: matchedCount / queryTokens.length,
	};
}

function collectMatchingQueryTokens(queryTokens: string[], texts: string[]): Set<string> {
	const haystack = new Set<string>();
	for (const text of texts) {
		for (const token of tokenize(text)) {
			haystack.add(token);
		}
	}

	const matches = new Set<string>();
	for (const token of queryTokens) {
		if (haystack.has(token)) {
			matches.add(token);
		}
	}
	return matches;
}

function computeExactMatchBoost(query: string, candidate: MemoryCandidate): number {
	const normalizedQuery = query.trim().toLowerCase();
	if (!normalizedQuery) {
		return 0;
	}

	const minLength = containsHanText(normalizedQuery) ? 2 : 4;
	if (normalizedQuery.length < minLength) {
		return 0;
	}

	let boost = 0;
	const scoringFields: Array<[string, number]> = [
		[candidate.title, 12],
		[candidate.searchText ?? candidate.content, 8],
		[candidate.path, 4],
	];
	for (const [field, value] of scoringFields) {
		if (field.toLowerCase().includes(normalizedQuery)) {
			boost += value;
		}
	}
	return boost;
}

function computeRecencyBoost(timestamp: string | undefined): number {
	if (!timestamp) return 0;
	const timestampMs = Date.parse(timestamp);
	if (!Number.isFinite(timestampMs)) return 0;

	const ageMs = Date.now() - timestampMs;
	const dayMs = 24 * 60 * 60 * 1000;
	if (ageMs <= dayMs) return 6;
	if (ageMs <= 7 * dayMs) return 4;
	if (ageMs <= 30 * dayMs) return 2;
	return 0;
}

function detectQueryIntents(query: string): Set<QueryIntent> {
	const intents = new Set<QueryIntent>();
	if (/\b(now|current|currently|status)\b/i.test(query) || /(现在|当前|目前|正在|状态)/u.test(query)) {
		intents.add("current-state");
	}
	if (/\b(next|follow-?up|todo|plan)\b/i.test(query) || /(下一步|接下来|后续|怎么办|怎么做|该查什么)/u.test(query)) {
		intents.add("next-steps");
	}
	if (
		/\b(constraint|requirement|guardrail|compatible|compatibility)\b/i.test(query) ||
		/(约束|限制|要求|兼容|注意事项)/u.test(query)
	) {
		intents.add("constraints");
	}
	if (/\b(decision|decided|why)\b/i.test(query) || /(决策|决定|方案|为什么)/u.test(query)) {
		intents.add("decisions");
	}
	if (/\b(error|bug|failure|issue|regression)\b/i.test(query) || /(错误|异常|失败|问题|缺陷|回归)/u.test(query)) {
		intents.add("errors");
	}
	if (/\b(history|previous|before|earlier|past)\b/i.test(query) || /(历史|之前|以前|过去|早先|曾经)/u.test(query)) {
		intents.add("history");
	}
	return intents;
}

function computeSectionIntentBoost(intents: Set<QueryIntent>, candidate: MemoryCandidate): number {
	const kind = candidate.sectionKind ?? "";
	let boost = 0;

	if (intents.has("current-state") && kind === "current state") boost += 10;
	if (intents.has("next-steps") && kind === "next steps") boost += 10;
	if (intents.has("constraints") && kind.includes("constraint")) boost += 8;
	if (intents.has("decisions") && kind.includes("decision")) boost += 8;
	if (intents.has("errors") && kind === "errors & corrections") boost += 8;
	if (intents.has("history") && candidate.source === "channel-history") boost += 8;
	return boost;
}

function compareScoredCandidates(a: ScoredCandidate, b: ScoredCandidate): number {
	return (
		b.score - a.score ||
		b.lexicalMatchCount - a.lexicalMatchCount ||
		b.candidate.priority - a.candidate.priority ||
		a.candidate.title.localeCompare(b.candidate.title)
	);
}

function scoreCandidate(
	query: string,
	queryTokens: string[],
	intents: Set<QueryIntent>,
	candidate: MemoryCandidate,
): ScoredCandidate | null {
	const searchText = candidate.searchText ?? candidate.content;
	const titleStats = computeTokenMatchStats(queryTokens, candidate.title);
	const contentStats = computeTokenMatchStats(queryTokens, searchText);
	const pathStats = computeTokenMatchStats(queryTokens, candidate.path);
	const matchedTokens = collectMatchingQueryTokens(queryTokens, [candidate.title, searchText, candidate.path]);
	const exactBoost = computeExactMatchBoost(query, candidate);
	const intentBoost = computeSectionIntentBoost(intents, candidate);
	const overallCoverage = queryTokens.length > 0 ? matchedTokens.size / queryTokens.length : 0;
	const lexicalScore =
		overallCoverage * 48 +
		titleStats.coverage * 18 +
		contentStats.coverage * 22 +
		pathStats.coverage * 8 +
		exactBoost;
	const structuralScore = candidate.priority + intentBoost + computeRecencyBoost(candidate.timestamp);

	if (matchedTokens.size === 0 && exactBoost === 0) {
		return null;
	}

	return {
		candidate,
		score: lexicalScore * (1 + structuralScore / 100),
		lexicalMatchCount: matchedTokens.size,
		intentBoost,
	};
}

function seedIntentCandidates(
	request: RecallRequest,
	candidates: MemoryCandidate[],
	existing: ScoredCandidate[],
	intents: Set<QueryIntent>,
	queryTokens: string[],
): ScoredCandidate[] {
	if (intents.size === 0) {
		return existing;
	}

	const seen = new Set(existing.map(({ candidate }) => candidate.id));
	const seeded = [...existing];
	const limit = Math.max(request.maxCandidates, request.maxInjected);

	const intentCandidates = candidates
		.map((candidate) => ({
			candidate,
			intentBoost: computeSectionIntentBoost(intents, candidate),
		}))
		.filter(({ candidate, intentBoost }) => intentBoost > 0 && !seen.has(candidate.id))
		.sort(
			(a, b) =>
				b.intentBoost - a.intentBoost ||
				b.candidate.priority - a.candidate.priority ||
				a.candidate.title.localeCompare(b.candidate.title),
		);

	for (const { candidate, intentBoost } of intentCandidates) {
		const matchedTokens = collectMatchingQueryTokens(queryTokens, [
			candidate.title,
			candidate.searchText ?? candidate.content,
		]);
		if (matchedTokens.size === 0) {
			continue;
		}

		seeded.push({
			candidate,
			score:
				(intentBoost + matchedTokens.size * 8) *
				(1 + (candidate.priority + computeRecencyBoost(candidate.timestamp)) / 100),
			lexicalMatchCount: matchedTokens.size,
			intentBoost,
		});
		seen.add(candidate.id);
		if (seeded.length >= limit) {
			break;
		}
	}

	return seeded;
}

async function rerankCandidates(request: RecallRequest, candidates: ScoredCandidate[]): Promise<ScoredCandidate[]> {
	if (!shouldUseModelRerank(request, candidates)) {
		return candidates;
	}

	const renderedCandidates = candidates
		.map(({ candidate, score, lexicalMatchCount, intentBoost }) => {
			const clippedContent =
				candidate.content.length > RERANK_CONTENT_CLIP
					? `${candidate.content.slice(0, RERANK_CONTENT_CLIP)}...`
					: candidate.content;
			return [
				`id: ${candidate.id}`,
				`source: ${candidate.source}`,
				`title: ${candidate.title}`,
				`path: ${candidate.path}`,
				`score: ${score}`,
				`lexicalMatchCount: ${lexicalMatchCount}`,
				`intentBoost: ${intentBoost}`,
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

function hasMemorySensitiveQueryIntent(query: string): boolean {
	if (HAN_REGEX.test(query)) {
		return /(之前|上次|记得|记住|偏好|决定|历史|纠正|不要再|以后|默认)/.test(query);
	}
	return /\b(previous|previously|last time|remember|preference|decision|history|correction|again|default)\b/i.test(
		query,
	);
}

function shouldUseModelRerank(request: RecallRequest, candidates: ScoredCandidate[]): boolean {
	if (candidates.length <= request.maxInjected) {
		return false;
	}
	if (request.rerankWithModel === true) {
		return true;
	}
	if (request.rerankWithModel === false && !request.autoRerank) {
		return false;
	}

	const top = candidates[0];
	const next = candidates[1];
	if (!top || !next) {
		return false;
	}
	const highLocalConfidence = top.score >= HIGH_CONFIDENCE_SCORE && top.score - next.score >= CLOSE_SCORE_DELTA;
	if (highLocalConfidence) {
		return false;
	}
	if (!request.autoRerank && !hasMemorySensitiveQueryIntent(request.query)) {
		return false;
	}
	return true;
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

	const candidates = await buildMemoryCandidates(
		{
			workspaceDir: request.workspaceDir,
			channelDir: request.channelDir,
		},
		request.candidateStore ?? createMemoryCandidateStore(),
	);
	const filteredCandidates = request.allowedSources?.length
		? candidates.filter((candidate) => request.allowedSources?.includes(candidate.source))
		: candidates;
	if (filteredCandidates.length === 0) {
		return { items: [], renderedText: "" };
	}

	const queryTokens = tokenize(query);
	const queryIntents = detectQueryIntents(query);
	const scored = filteredCandidates
		.map((candidate) => scoreCandidate(query, queryTokens, queryIntents, candidate))
		.filter((candidate): candidate is ScoredCandidate => candidate !== null)
		.sort(compareScoredCandidates);

	const shortlist = seedIntentCandidates(request, filteredCandidates, scored, queryIntents, queryTokens)
		.sort(compareScoredCandidates)
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
