import { parseLocalTime } from "../shared/local-time.js";
import { splitH2Sections } from "../shared/markdown-sections.js";
import { HAN_REGEX } from "../shared/text-utils.js";
import { COMMON_CHINESE_WORDS } from "./chinese-words.js";
import type { MemoryEntry } from "./store.js";

/**
 * Age-bucketed recency boost (≤1 day / ≤7 days / ≤30 days / older), scaled by `weights`. Kept
 * here (not `session-search.ts`) so both cold-storage callers share one scoring primitive; each
 * caller supplies its own weights since the two scoring systems live on different magnitudes.
 */
export function recencyBoostByAge(
	timestamp: string | undefined,
	weights: { day: number; week: number; month: number },
): number {
	if (!timestamp) return 0;
	const timestampMs = parseLocalTime(timestamp);
	if (timestampMs === undefined) return 0;

	const ageMs = Date.now() - timestampMs;
	const dayMs = 24 * 60 * 60 * 1000;
	if (ageMs <= dayMs) return weights.day;
	if (ageMs <= 7 * dayMs) return weights.week;
	if (ageMs <= 30 * dayMs) return weights.month;
	return 0;
}

/**
 * Spec 050, D3/D4: the lexical tokenizer, moved here from the retired `recall.ts`. It now serves
 * exactly two callers — `memory_search` and `memory_save`'s deterministic near-duplicate guard.
 * Per-turn recall scoring, intent seeding, and the usage-count boost are gone.
 */

const TOKEN_PART_REGEX = /[\p{Script=Han}]+|[\p{L}\p{N}_./-]+/gu;
const ASCII_SPLIT_REGEX = /[._/-]+/g;
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
		const maxLength = Math.min(MAX_HAN_WORD_LENGTH, chars.length - index);
		for (let size = maxLength; size >= 2; size--) {
			const candidate = chars.slice(index, index + size).join("");
			if (COMMON_CHINESE_WORDS.has(candidate)) {
				tokens.push(candidate);
				for (let c = index; c < index + size; c++) {
					covered[c] = 1;
				}
				break;
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
		if (!covered[index] && !CHINESE_STOP_CHARS.has(chars[index])) {
			tokens.push(chars[index]);
		}
	}

	// Trigrams across the whole run — they survive greedy dictionary shredding of domain compounds
	// and match verbatim on both the query and the stored side.
	for (let index = 0; index + 3 <= chars.length; index++) {
		tokens.push(chars.slice(index, index + 3).join(""));
	}

	return Array.from(new Set(tokens));
}

function tokenizeAsciiPart(part: string): string[] {
	const tokens: string[] = [];
	const normalized = part.toLowerCase();
	if (normalized.length >= 2 && !LATIN_STOP_WORDS.has(normalized)) {
		tokens.push(normalized);
	}
	for (const segment of normalized.split(ASCII_SPLIT_REGEX).filter(Boolean)) {
		if (segment.length >= 2 && !LATIN_STOP_WORDS.has(segment)) {
			tokens.push(segment);
		}
	}
	return tokens;
}

export function tokenizeRecallText(text: string): string[] {
	const parts = text.toLowerCase().match(TOKEN_PART_REGEX) ?? [];
	const tokens: string[] = [];
	for (const part of parts) {
		if (containsHanText(part)) {
			tokens.push(...tokenizeHanPart(part));
		} else {
			tokens.push(...tokenizeAsciiPart(part));
		}
	}
	return Array.from(new Set(tokens));
}

// -------------------------------------------------------------------------------------------------
// Near-duplicate detection for memory_save (spec 050, D3)
// -------------------------------------------------------------------------------------------------

export const NEAR_DUPLICATE_JACCARD = 0.6;

function normalizeForEquality(text: string): string {
	return text.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

export function descriptionSimilarity(a: string, b: string): number {
	if (normalizeForEquality(a) === normalizeForEquality(b)) {
		return 1;
	}
	const setA = new Set(tokenizeRecallText(a));
	const setB = new Set(tokenizeRecallText(b));
	if (setA.size === 0 || setB.size === 0) {
		return 0;
	}
	let intersection = 0;
	for (const token of setA) {
		if (setB.has(token)) {
			intersection++;
		}
	}
	return intersection / (setA.size + setB.size - intersection);
}

/** Entries whose description is a near-duplicate of `description`, strongest match first. */
export function findNearDuplicateEntries(description: string, entries: MemoryEntry[]): MemoryEntry[] {
	return entries
		.map((entry) => ({ entry, score: descriptionSimilarity(description, entry.description) }))
		.filter(({ score }) => score >= NEAR_DUPLICATE_JACCARD)
		.sort((a, b) => b.score - a.score)
		.map(({ entry }) => entry);
}

// -------------------------------------------------------------------------------------------------
// memory_search
// -------------------------------------------------------------------------------------------------

export interface MemorySearchHit {
	kind: "memory" | "journal" | "workspace";
	/** entry name, journal date, or workspace section heading */
	label: string;
	date?: string;
	line: string;
}

export interface MemorySearchInput {
	query: string;
	entries: MemoryEntry[];
	/** `{ date, content }` per journal file, newest first. */
	journal?: Array<{ date: string; content: string }>;
	workspaceMemory?: string;
	limit?: number;
}

function scoreText(queryTokens: Set<string>, text: string): { score: number; line: string } {
	const textTokens = new Set(tokenizeRecallText(text));
	let score = 0;
	for (const token of queryTokens) {
		if (textTokens.has(token)) {
			score++;
		}
	}
	const lower = text.toLowerCase();
	for (const token of queryTokens) {
		if (token.length >= 3 && lower.includes(token)) {
			score += 0.5;
		}
	}
	const firstLine =
		text
			.split("\n")
			.find((l) => l.trim().length > 0)
			?.trim() ?? text.trim();
	return { score, line: firstLine.length > 200 ? `${firstLine.slice(0, 197)}…` : firstLine };
}

export function searchMemory(input: MemorySearchInput): MemorySearchHit[] {
	const queryTokens = new Set(tokenizeRecallText(input.query));
	if (queryTokens.size === 0) {
		return [];
	}
	const hits: Array<MemorySearchHit & { score: number }> = [];

	for (const entry of input.entries) {
		const { score, line } = scoreText(queryTokens, `${entry.description}\n${entry.body}`);
		if (score > 0) {
			hits.push({ kind: "memory", label: entry.name, date: entry.updated, line, score });
		}
	}

	for (const day of input.journal ?? []) {
		for (const rawLine of day.content.split("\n")) {
			const line = rawLine.replace(/^[-*]\s*/, "").trim();
			if (!line || line.startsWith("#")) {
				continue;
			}
			const { score } = scoreText(queryTokens, line);
			if (score > 0) {
				hits.push({ kind: "journal", label: day.date, date: day.date, line, score });
			}
		}
	}

	if (input.workspaceMemory) {
		for (const section of splitH2Sections(input.workspaceMemory)) {
			const { score, line } = scoreText(queryTokens, section.content);
			if (score > 0) {
				hits.push({ kind: "workspace", label: section.heading, line, score });
			}
		}
	}

	return hits
		.sort((a, b) => b.score - a.score || (b.date ?? "").localeCompare(a.date ?? ""))
		.slice(0, input.limit ?? 12)
		.map(({ score: _score, ...hit }) => hit);
}
