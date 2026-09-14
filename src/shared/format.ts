import { statSync } from "node:fs";

/** Render a millisecond duration as compact human text (`"42s"`, `"3m7s"`). */
export function formatDuration(ms: number): string {
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

/**
 * Coerce an untrusted numeric config/request value into an integer within `[minimum, maximum]`,
 * falling back to `fallback` for anything not a finite number or out of range. Shared by the
 * app-level config loaders (`tools.json`) and web request parameter resolution — both need the
 * same "trust nothing, fail closed to a safe default" numeric parsing.
 */
export function clampInteger(value: unknown, fallback: number, minimum: number, maximum?: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return fallback;
	}
	const normalized = Math.floor(value);
	if (normalized < minimum) {
		return fallback;
	}
	if (maximum !== undefined && normalized > maximum) {
		return fallback;
	}
	return normalized;
}

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

/**
 * A cheap change token for a config file: `mtime:ctime:size`, or `""` when the file
 * cannot be stat'ed (missing or unreadable — itself a stable state worth caching).
 *
 * Used by the hot re-read paths (`settings.json` on every driver/maintenance tick,
 * `tools.json` on every driver tick) to skip a JSON parse when nothing changed. Same
 * triple as the task-ledger parse cache: mtime alone misses an atomic-rename overwrite
 * that preserves the timestamp, ctime catches the rename, size catches the rest.
 */
export function fileStamp(path: string): string {
	try {
		const stats = statSync(path);
		return `${stats.mtimeMs}:${stats.ctimeMs}:${stats.size}`;
	} catch {
		return "";
	}
}
