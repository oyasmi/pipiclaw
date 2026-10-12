import { statSync } from "node:fs";

/** Render a millisecond duration as compact human text (`"42s"`, `"3m7s"`). */
export function formatDuration(ms: number): string {
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

/**
 * User-facing elapsed time in Chinese, two units at most (`42秒`, `1分02秒`, `3小时05分`, `2天3小时`) —
 * for "how long did this take / has this been running" in replies, receipts and cards (spec 053,
 * D4). Model-facing text keeps `formatDuration` above.
 */
export function formatElapsedZh(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}秒`;
	const totalMinutes = Math.floor(totalSeconds / 60);
	if (totalMinutes < 60) return `${totalMinutes}分${String(totalSeconds % 60).padStart(2, "0")}秒`;
	const totalHours = Math.floor(totalMinutes / 60);
	if (totalHours < 24) {
		const minutes = totalMinutes % 60;
		return minutes > 0 ? `${totalHours}小时${String(minutes).padStart(2, "0")}分` : `${totalHours}小时`;
	}
	const hours = totalHours % 24;
	return hours > 0 ? `${Math.floor(totalHours / 24)}天${hours}小时` : `${Math.floor(totalHours / 24)}天`;
}

/**
 * A coarse, single-unit span in Chinese (`30 秒`, `12 分钟`, `3 小时`, `2 天`) — for "how far away is
 * this deadline", where a second unit is noise. Rounds within a unit and promotes to the next unit
 * when rounding reaches it, so the output never reads `60 分钟` or `24 小时`.
 */
export function formatSpanZh(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds} 秒`;
	const minutes = Math.round(ms / 60_000);
	if (minutes < 60) return `${minutes} 分钟`;
	const hours = Math.round(ms / 3_600_000);
	if (hours < 24) return `${hours} 小时`;
	return `${Math.round(ms / 86_400_000)} 天`;
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
