import { lstat, readdir } from "node:fs/promises";
import { isNodeError } from "../shared/os.js";

export async function listIndexSourceEntries(dir: string) {
	try {
		return await readdir(dir, { withFileTypes: true });
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return [];
		throw error;
	}
}

export async function statIndexSource(path: string) {
	try {
		const stats = await lstat(path);
		return stats.isFile() ? stats : undefined;
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return undefined;
		throw error;
	}
}

export function sameIndexSourceStat(
	previous: { ino: number; size: number; mtime_ms: number },
	current: { ino: number; size: number; mtimeMs: number },
): boolean {
	return previous.ino === current.ino && previous.size === current.size && previous.mtime_ms === current.mtimeMs;
}
