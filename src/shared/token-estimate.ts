/**
 * Rough token estimate, shared by everything that has to reason about context size without
 * calling a tokenizer. CJK runs about one token per character, Latin text about four characters
 * per token; the provider's real tokenizer is the authority, and the usage ledger records what
 * it billed.
 *
 * The script split matters wherever the estimate gates behavior rather than just reporting: a
 * flat characters-per-token ratio tuned for Latin text underestimates Chinese input roughly
 * threefold, so a budget check would clear a message that in fact does not fit.
 */
const CJK_REGEX = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u;

export function estimateTokens(text: string): number {
	let cjk = 0;
	for (const char of text) {
		if (CJK_REGEX.test(char)) cjk++;
	}
	return Math.ceil(cjk + (text.length - cjk) / 4);
}
