import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { runWebFetchMock } = vi.hoisted(() => ({ runWebFetchMock: vi.fn() }));
vi.mock("../src/web/fetch.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/web/fetch.js")>()),
	runWebFetch: runWebFetchMock,
}));

import { DEFAULT_SECURITY_CONFIG } from "../src/security/config.js";
import { DEFAULT_TOOLS_CONFIG } from "../src/tools/config.js";
import { readWebCache, webCacheKey, writeWebCache } from "../src/tools/web-cache.js";
import { createWebFetchTool } from "../src/tools/web-fetch.js";

function textOutput(details: { finalUrl?: string; status?: number; truncated?: boolean }, body: string) {
	return {
		content: [{ type: "text" as const, text: body }],
		details: {
			url: "u",
			finalUrl: details.finalUrl ?? "https://example.com/page",
			status: details.status ?? 200,
			extractor: "readability",
			truncated: details.truncated ?? false,
			length: body.length,
			untrusted: true as const,
			contentType: "text/html",
		},
	};
}

function makeTool(channelDir: string) {
	return createWebFetchTool({
		webConfig: DEFAULT_TOOLS_CONFIG.tools.web,
		securityConfig: DEFAULT_SECURITY_CONFIG,
		workspaceDir: channelDir,
		channelId: "dm_1",
		channelDir,
	});
}

describe("web_fetch tool caching and pagination (batch 2.7)", () => {
	let channelDir: string;
	beforeEach(() => {
		runWebFetchMock.mockReset();
		channelDir = mkdtempSync(join(tmpdir(), "pipiclaw-webfetch-"));
	});

	it("pages a long page from one cached snapshot without refetching", async () => {
		const body = "A".repeat(600) + "MIDDLE_MARK" + "B".repeat(600);
		runWebFetchMock.mockResolvedValueOnce(textOutput({}, body));
		const tool = makeTool(channelDir);

		const first = await tool.execute("c", { url: "https://example.com/page", maxChars: 600 });
		const firstText = first.content[0].type === "text" ? first.content[0].text : "";
		expect(firstText).toContain("Showing chars 0-600");

		const second = await tool.execute("c", { url: "https://example.com/page", maxChars: 600, offset: 600 });
		const secondText = second.content[0].type === "text" ? second.content[0].text : "";
		expect(secondText).toContain("MIDDLE_MARK");
		expect(runWebFetchMock).toHaveBeenCalledTimes(1); // second call served from cache
	});

	it("distinguishes 'more to page' from 'the source itself was truncated'", async () => {
		runWebFetchMock.mockResolvedValueOnce(textOutput({ truncated: true }, "short body"));
		const tool = makeTool(channelDir);

		const res = await tool.execute("c", { url: "https://example.com/big", maxChars: 9999 });
		const text = res.content[0].type === "text" ? res.content[0].text : "";
		expect(text).toContain("origin returned more than the fetch limit");
		expect(res.details).toMatchObject({ sourceTruncated: true });
	});

	it("refresh:true bypasses the cache", async () => {
		runWebFetchMock.mockResolvedValue(textOutput({}, "v1"));
		const tool = makeTool(channelDir);
		await tool.execute("c", { url: "https://example.com/p", maxChars: 100 });

		runWebFetchMock.mockResolvedValue(textOutput({}, "v2 content"));
		const refreshed = await tool.execute("c", { url: "https://example.com/p", maxChars: 100, refresh: true });
		const text = refreshed.content[0].type === "text" ? refreshed.content[0].text : "";
		expect(text).toContain("v2 content");
		expect(runWebFetchMock).toHaveBeenCalledTimes(2);
	});

	it("refuses offset>0 when the snapshot is gone instead of stitching a fresh one", async () => {
		const tool = makeTool(channelDir);
		await expect(
			tool.execute("c", { url: "https://example.com/expired", maxChars: 100, offset: 400 }),
		).rejects.toThrow(/offset=0/);
		expect(runWebFetchMock).not.toHaveBeenCalled();
	});

	it("keeps the redirect final URL and status through the cache round-trip", async () => {
		const key = webCacheKey("https://example.com/r", "markdown");
		await writeWebCache(channelDir, key, {
			body: "cached body",
			fetchedAt: Date.now(),
			finalUrl: "https://example.com/final",
			status: 200,
			extractor: "readability",
			contentType: "text/html",
			sourceTruncated: false,
		});
		const roundTripped = await readWebCache(channelDir, key);
		expect(roundTripped?.finalUrl).toBe("https://example.com/final");

		const tool = makeTool(channelDir);
		const res = await tool.execute("c", { url: "https://example.com/r", extractMode: "markdown", maxChars: 100 });
		const text = res.content[0].type === "text" ? res.content[0].text : "";
		expect(text).toContain("Final URL after redirects: https://example.com/final");
	});
});
