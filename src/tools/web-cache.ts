import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomically } from "../shared/atomic-file.js";

/**
 * Small per-channel cache of fetched web page bodies so a long page can be paged over with `offset`
 * without re-issuing the (slow, non-deterministic) HTTP request. Bodies are the clean extracted text
 * — the banner and windowing are re-applied by the tool on each read.
 */

const WEB_CACHE_DIR = "web-cache";
export const WEB_CACHE_TTL_MS = 15 * 60 * 1000;
const WEB_CACHE_MAX_FILES = 20;

export interface WebCacheEntry {
	body: string;
	fetchedAt: number;
}

function cacheDir(channelDir: string): string {
	return join(channelDir, WEB_CACHE_DIR);
}

/** Cache key from the requested URL plus extract mode (markdown vs text render differently). */
export function webCacheKey(url: string, extractMode: string): string {
	return createHash("sha256").update(`${extractMode}\n${url}`).digest("hex").slice(0, 24);
}

function bodyPath(channelDir: string, key: string): string {
	return join(cacheDir(channelDir), `${key}.txt`);
}

/** Return the cached body if present and within the TTL, else null. */
export async function readWebCache(
	channelDir: string,
	key: string,
	ttlMs = WEB_CACHE_TTL_MS,
): Promise<WebCacheEntry | null> {
	const path = bodyPath(channelDir, key);
	try {
		const stats = await stat(path);
		// `>=` so a TTL of 0 means "always refetch" rather than depending on sub-ms timing.
		if (Date.now() - stats.mtimeMs >= ttlMs) {
			return null;
		}
		return { body: await readFile(path, "utf-8"), fetchedAt: stats.mtimeMs };
	} catch {
		return null;
	}
}

/** Persist a body and evict the oldest entries beyond the cap. Best-effort; never throws. */
export async function writeWebCache(channelDir: string, key: string, body: string): Promise<void> {
	try {
		const dir = cacheDir(channelDir);
		if (!existsSync(dir)) {
			await mkdir(dir, { recursive: true });
		}
		await writeFileAtomically(bodyPath(channelDir, key), body);
		await pruneWebCache(dir);
	} catch {
		// Caching is an optimization; a failure just means the next read refetches.
	}
}

async function pruneWebCache(dir: string): Promise<void> {
	const files = (await readdir(dir)).filter((name) => name.endsWith(".txt"));
	if (files.length <= WEB_CACHE_MAX_FILES) {
		return;
	}
	const withTimes = await Promise.all(
		files.map(async (name) => ({ name, mtimeMs: (await stat(join(dir, name)).catch(() => null))?.mtimeMs ?? 0 })),
	);
	withTimes.sort((a, b) => a.mtimeMs - b.mtimeMs);
	const excess = withTimes.slice(0, withTimes.length - WEB_CACHE_MAX_FILES);
	await Promise.all(excess.map((entry) => rm(join(dir, entry.name), { force: true })));
}
