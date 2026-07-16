/**
 * Prompt "units": a deterministic, tokenizer-free approximation of prompt size
 * that is stable across models (spec 026 §5.1). Both the system-prompt builder and
 * the per-turn memory context budget against it, so it is a real cross-domain helper
 * — kept out of text-utils.ts on purpose, to avoid growing an unrelated grab bag.
 *
 * Counting rule:
 * - each Han / Hiragana / Katakana / Hangul code point → 1 unit;
 * - each run of Unicode letters/numbers (a non-CJK "word") → 1 unit;
 * - punctuation and whitespace → 0.
 *
 * It never calls a tokenizer, the network or a model, and the same input always
 * produces the same output.
 */

/** A code point that is its own unit and always ends the surrounding word run. */
const CJK_REGEX = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
/** A code point that participates in a non-CJK word run. */
const WORD_REGEX = /[\p{L}\p{N}]/u;

function isCjk(codePoint: string): boolean {
	return CJK_REGEX.test(codePoint);
}

function isWord(codePoint: string): boolean {
	return WORD_REGEX.test(codePoint);
}

/** Count prompt units in `text` in a single Unicode-aware pass. */
export function countPromptUnits(text: string): number {
	let units = 0;
	let inWord = false;
	// `for...of` iterates code points, so surrogate pairs count as one character.
	for (const char of text) {
		if (isCjk(char)) {
			units++;
			inWord = false;
		} else if (isWord(char)) {
			if (!inWord) {
				units++;
				inWord = true;
			}
		} else {
			inWord = false;
		}
	}
	return units;
}

export interface ClipByPromptUnitsOptions {
	/** Fraction of the budget kept from the head; the rest is the tail. Default 0.6. */
	headRatio?: number;
	/** Separator shown where the middle was removed. Its own units/chars count against the budget. */
	marker?: string;
	/** Optional hard character ceiling; whichever of units/chars is hit first triggers truncation. */
	maxChars?: number;
}

export interface ClipByPromptUnitsResult {
	text: string;
	/** Units in the original input. */
	rawUnits: number;
	/** Units actually kept (head + marker + tail), always ≤ maxUnits. */
	injectedUnits: number;
	truncated: boolean;
}

const DEFAULT_MARKER = "\n\n[... truncated ...]\n\n";

/**
 * Clip `text` to at most `maxUnits` prompt units (and, when given, `maxChars`
 * characters), keeping a head and a tail joined by `marker`. Cuts land only on
 * code-point boundaries, so a surrogate pair is never split, and the marker is
 * paid for out of the budget so the result never exceeds either limit.
 */
export function clipTextByPromptUnits(
	text: string,
	maxUnits: number,
	options: ClipByPromptUnitsOptions = {},
): ClipByPromptUnitsResult {
	const headRatio = Math.max(0, Math.min(1, options.headRatio ?? 0.6));
	const marker = options.marker ?? DEFAULT_MARKER;
	const maxChars = options.maxChars;

	const codePoints = Array.from(text);
	const rawUnits = countPromptUnits(text);
	const rawChars = text.length;

	const withinUnits = rawUnits <= maxUnits;
	const withinChars = maxChars === undefined || rawChars <= maxChars;
	if (withinUnits && withinChars) {
		return { text, rawUnits, injectedUnits: rawUnits, truncated: false };
	}

	// Cumulative units and characters after each code point, computed in one pass.
	const cumulativeUnits: number[] = new Array(codePoints.length);
	const cumulativeChars: number[] = new Array(codePoints.length);
	let units = 0;
	let chars = 0;
	let inWord = false;
	for (let index = 0; index < codePoints.length; index++) {
		const char = codePoints[index] as string;
		if (isCjk(char)) {
			units++;
			inWord = false;
		} else if (isWord(char)) {
			if (!inWord) {
				units++;
				inWord = true;
			}
		} else {
			inWord = false;
		}
		chars += char.length;
		cumulativeUnits[index] = units;
		cumulativeChars[index] = chars;
	}

	const markerUnits = countPromptUnits(marker);
	const markerChars = marker.length;
	const availableUnits = Math.max(0, maxUnits - markerUnits);
	const availableChars = maxChars === undefined ? Number.POSITIVE_INFINITY : Math.max(0, maxChars - markerChars);
	const headUnitBudget = Math.floor(availableUnits * headRatio);
	const tailUnitBudget = availableUnits - headUnitBudget;
	const headCharBudget = Number.isFinite(availableChars) ? Math.floor(availableChars * headRatio) : availableChars;
	const tailCharBudget = Number.isFinite(availableChars) ? availableChars - headCharBudget : availableChars;

	// Largest prefix within both head budgets.
	let headEnd = 0; // exclusive index into codePoints
	for (let index = 0; index < codePoints.length; index++) {
		const prefixUnits = cumulativeUnits[index] as number;
		const prefixChars = cumulativeChars[index] as number;
		if (prefixUnits <= headUnitBudget && prefixChars <= headCharBudget) {
			headEnd = index + 1;
		} else {
			break;
		}
	}

	// Units of the suffix starting at `index`, derived from the forward cumulative
	// counts. If a word run straddles the cut, both halves count it, so add one back.
	const totalUnits = rawUnits;
	const unitsFromIndex = (index: number): number => {
		if (index <= 0) return totalUnits;
		const prefixUnits = cumulativeUnits[index - 1] as number;
		const left = codePoints[index - 1] as string;
		const right = codePoints[index] as string;
		const split = isWord(left) && !isCjk(left) && isWord(right) && !isCjk(right);
		return totalUnits - prefixUnits + (split ? 1 : 0);
	};
	const charsFromIndex = (index: number): number => {
		if (index <= 0) return rawChars;
		return rawChars - (cumulativeChars[index - 1] as number);
	};

	// Smallest start index (largest suffix) within both tail budgets and not overlapping the head.
	let tailStart = codePoints.length;
	for (let index = headEnd; index <= codePoints.length; index++) {
		if (unitsFromIndex(index) <= tailUnitBudget && charsFromIndex(index) <= tailCharBudget) {
			tailStart = index;
			break;
		}
	}

	const head = codePoints.slice(0, headEnd).join("");
	const tail = codePoints.slice(tailStart).join("");
	const clipped = `${head.trimEnd()}${marker}${tail.trimStart()}`;
	return { text: clipped, rawUnits, injectedUnits: countPromptUnits(clipped), truncated: true };
}
