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

const SEARCH_MARK = "\u200b";
const CJK = String.raw`\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u30fc\uff70\uff9e\uff9f`;
const HAS_CJK = new RegExp(`[${CJK}]`, "u");
const CJK_BOUNDARY = new RegExp(`(?<=[${CJK}])(?=[\\p{L}\\p{N}${CJK}])|(?<=[\\p{L}\\p{N}${CJK}])(?=[${CJK}])`, "gu");
const CJK_RUN = new RegExp(`([${CJK}]+)`, "gu");
const LATIN_PART = /[\p{L}\p{N}]+(?:[-./_:]+[\p{L}\p{N}]+)*/gu;
const CJK_STOP_WORDS = new RegExp(
	(
		"我们 你们 他们 这个 那个 一下 一个 可以 时候 现在 知道 告诉 记得 还是 就是 不是 没有 已经 因为 所以 但是 如果 然后 还有 请问 帮我 怎么 怎样 如何 为什么 什么 是否 哪里 哪个 哪些 应该 一些 上次 之前 刚才 刚刚 那次 问题 " +
		"的 了 是 吗 呢 吧 啊 呀 哦 嗯 么 在 和 与 也 都 就 还 又 把 被"
	)
		.split(" ")
		.sort((a, b) => b.length - a.length)
		.join("|"),
	"gu",
);

export function searchTextFor(text: string): string | null {
	return HAS_CJK.test(text) ? text.replace(CJK_BOUNDARY, SEARCH_MARK) : null;
}

function stripSearchMarks(text: string): string {
	return text.replaceAll(SEARCH_MARK, "");
}

export interface QueryTerms {
	latin: string[];
	cjk: string[];
}

export function buildQueryTerms(query: string): QueryTerms {
	const latin = new Set<string>();
	const cjk = new Set<string>();
	for (const [index, part] of query.toLowerCase().split(CJK_RUN).entries()) {
		if (index % 2 === 0) {
			for (const word of part.matchAll(LATIN_PART)) {
				if (latin.size >= 16) break;
				if (word[0].length >= 2 && !LATIN_STOP_WORDS.has(word[0])) latin.add(word[0]);
			}
			continue;
		}
		for (const fragment of part.split(CJK_STOP_WORDS)) {
			if (cjk.size >= 24) break;
			const chars = [...fragment];
			if (chars.length === 1) cjk.add(chars[0]);
			for (let i = 1; i < chars.length && cjk.size < 24; i++) {
				cjk.add(chars[i - 1] + chars[i]);
			}
		}
	}
	return { latin: [...latin], cjk: [...cjk] };
}

function isPrefixTerm(word: string): boolean {
	return word.length >= 4 && /(?:^|[-./:])[a-z0-9_]+$/.test(word);
}

function quote(word: string): string {
	return `"${word.replaceAll('"', "")}"`;
}

export function buildMatchExpression(terms: QueryTerms): string | null {
	return (
		[
			...terms.latin.map((word) => quote(word) + (isPrefixTerm(word) ? "*" : "")),
			...terms.cjk.map((word) => quote([...word].join(" "))),
		].join(" OR ") || null
	);
}

export function matchedTerms(text: string, terms: QueryTerms): QueryTerms {
	const lower = stripSearchMarks(text).toLowerCase();
	return {
		latin: terms.latin.filter((word) => {
			if (!isPrefixTerm(word)) return lower.includes(word);
			// CJK boundaries are token boundaries too, even though both sides can be letters.
			const literal = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			return new RegExp(`(?<![\\p{L}\\p{N}])${literal}|(?<=[${CJK}])${literal}`, "u").test(lower);
		}),
		cjk: terms.cjk.filter((word) => lower.includes(word)),
	};
}

export function effectiveTermCount(terms: QueryTerms): number {
	return terms.latin.length + Math.ceil(terms.cjk.length / 2);
}

export function countMatchedUnits(text: string, terms: QueryTerms): number {
	return effectiveTermCount(matchedTerms(text, terms));
}

export function enoughMatches(units: number, effective: number): boolean {
	return effective < 5 || units >= 2;
}

export function windowAroundDensestMatch(text: string, matches: string[], limit: number, omission = "[...]"): string {
	if (text.length <= limit) return text;
	const inline = omission === "…";
	const maxChars = Math.max(1, limit - (inline ? 2 * omission.length : 0));
	const lower = text.toLowerCase();
	const cursors = matches.map((word) => ({ word, offset: lower.indexOf(word) })).filter((item) => item.offset >= 0);
	const positions: Array<{ word: string; offset: number }> = [];
	// Take occurrences in rounds so a frequently repeated word cannot exhaust the whole budget.
	while (cursors.length && positions.length < 400) {
		for (let i = cursors.length - 1; i >= 0 && positions.length < 400; i--) {
			const { word, offset } = cursors[i];
			positions.push({ word, offset });
			const next = lower.indexOf(word, offset + 1);
			if (next < 0) cursors.splice(i, 1);
			else cursors[i].offset = next;
		}
	}
	positions.sort((a, b) => a.offset - b.offset || a.word.length - b.word.length);
	const counts = new Map<string, number>();
	let left = 0;
	let bestCount = 0;
	let bestStart = 0;
	let bestEnd = 0;
	for (const { word, offset } of positions) {
		const end = offset + Math.min(word.length, maxChars);
		counts.set(word, (counts.get(word) ?? 0) + 1);
		while (end - positions[left].offset > maxChars) {
			const leaving = positions[left++].word;
			const count = (counts.get(leaving) ?? 1) - 1;
			if (count) counts.set(leaving, count);
			else counts.delete(leaving);
		}
		if (counts.size > bestCount) {
			bestCount = counts.size;
			bestStart = positions[left].offset;
			bestEnd = end;
		}
	}
	const start = Math.min(text.length - maxChars, Math.max(0, Math.floor((bestStart + bestEnd - maxChars) / 2)));
	const end = start + maxChars;
	const separator = inline ? "" : "\n";
	return `${start > 0 ? omission + separator : ""}${text.slice(start, end)}${end < text.length ? separator + omission : ""}`;
}
