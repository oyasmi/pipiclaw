import { mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readWebCache, WEB_CACHE_TTL_MS, webCacheKey, writeWebCache } from "../src/tools/web-cache.js";

const tempDirs: string[] = [];

function createChannel(): string {
	const dir = mkdtempSync(join(tmpdir(), "pipiclaw-web-cache-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("web cache", () => {
	it("round-trips a cached body", async () => {
		const channelDir = createChannel();
		const key = webCacheKey("https://example.com/a", "markdown");
		await writeWebCache(channelDir, key, "hello world");

		const entry = await readWebCache(channelDir, key);
		expect(entry?.body).toBe("hello world");
	});

	it("keys separately by url and extract mode", () => {
		expect(webCacheKey("https://x/a", "markdown")).not.toBe(webCacheKey("https://x/a", "text"));
		expect(webCacheKey("https://x/a", "markdown")).not.toBe(webCacheKey("https://x/b", "markdown"));
	});

	it("misses when the entry is older than the TTL", async () => {
		const channelDir = createChannel();
		const key = webCacheKey("https://example.com/a", "markdown");
		await writeWebCache(channelDir, key, "stale");

		// Backdate the file well past the TTL so expiry is deterministic (no sub-ms timing reliance).
		const past = (Date.now() - WEB_CACHE_TTL_MS - 60_000) / 1000;
		utimesSync(join(channelDir, "web-cache", `${key}.txt`), past, past);
		expect(await readWebCache(channelDir, key)).toBeNull();

		// A generous TTL still sees it.
		expect(await readWebCache(channelDir, key, WEB_CACHE_TTL_MS * 10)).not.toBeNull();
	});

	it("misses on a cold cache", async () => {
		const channelDir = createChannel();
		expect(await readWebCache(channelDir, webCacheKey("https://none", "markdown"))).toBeNull();
	});

	it("evicts the oldest entries beyond the cap", async () => {
		const channelDir = createChannel();
		// Write 25 entries; the cap is 20, so 5 of the oldest should be pruned.
		for (let i = 0; i < 25; i++) {
			await writeWebCache(channelDir, webCacheKey(`https://example.com/${i}`, "markdown"), `body ${i}`);
		}
		const files = readdirSync(join(channelDir, "web-cache")).filter((f) => f.endsWith(".txt"));
		expect(files.length).toBeLessThanOrEqual(20);
	});
});
