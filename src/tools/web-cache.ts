import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomically } from "../shared/atomic-file.js";

/**
 * Small per-channel cache of fetched web page bodies so a long page can be paged over with `offset`
 * without re-issuing the (slow, non-deterministic) HTTP request. Bodies are the clean extracted text
 * — the banner and windowing are re-applied by the tool on each read. The entry also carries the
 * fetch-time facts the model needs to judge the content (final URL after redirects, HTTP status,
 * whether the *source* was itself truncated) — the old cache dropped all of that (fix plan §2.7).
 */

const WEB_CACHE_DIR = "web-cache";
export const WEB_CACHE_TTL_MS = 15 * 60 * 1000;
const WEB_CACHE_MAX_FILES = 20;

export interface WebCacheEntry {
	body: string;
	fetchedAt: number;
	finalUrl: string;
	status: number;
	extractor: string;
	contentType: string;
	/** True when the origin returned more than the fetch cap and the body is not the whole page. */
	sourceTruncated: boolean;
}

function cacheDir(channelDir: string): string {
	return join(channelDir, WEB_CACHE_DIR);
}

/** Cache key from the requested URL plus extract mode (markdown vs text render differently). */
export function webCacheKey(url: string, extractMode: string): string {
	return createHash("sha256").update(`${extractMode}\n${url}`).digest("hex").slice(0, 24);
}

function bodyPath(channelDir: string, key: string): string {
	return join(cacheDir(channelDir), `${key}.json`);
}

/** Return the cached entry if present and within the TTL, else null. */
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
		const raw = JSON.parse(await readFile(path, "utf-8")) as Partial<WebCacheEntry>;
		if (typeof raw.body !== "string") {
			return null;
		}
		return {
			body: raw.body,
			fetchedAt: raw.fetchedAt ?? stats.mtimeMs,
			finalUrl: raw.finalUrl ?? "",
			status: raw.status ?? 0,
			extractor: raw.extractor ?? "",
			contentType: raw.contentType ?? "",
			sourceTruncated: raw.sourceTruncated === true,
		};
	} catch {
		return null;
	}
}

/** Persist an entry and evict the oldest beyond the cap. Best-effort; never throws. */
export async function writeWebCache(channelDir: string, key: string, entry: WebCacheEntry): Promise<void> {
	try {
		const dir = cacheDir(channelDir);
		if (!existsSync(dir)) {
			await mkdir(dir, { recursive: true });
		}
		await writeFileAtomically(bodyPath(channelDir, key), JSON.stringify(entry));
		await pruneWebCache(dir);
	} catch {
		// Caching is an optimization; a failure just means the next read refetches.
	}
}

/** Remove one cached entry (used by `refresh: true` before a forced refetch). */
export async function clearWebCacheEntry(channelDir: string, key: string): Promise<void> {
	await rm(bodyPath(channelDir, key), { force: true }).catch(() => undefined);
}

async function pruneWebCache(dir: string): Promise<void> {
	const files = (await readdir(dir)).filter((name) => name.endsWith(".json"));
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
