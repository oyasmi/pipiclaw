import { statSync } from "node:fs";

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
