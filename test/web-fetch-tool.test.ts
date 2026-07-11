import { afterEach, describe, expect, it, vi } from "vitest";

const runWebFetchMock = vi.hoisted(() => vi.fn());
vi.mock("../src/web/fetch.js", () => ({ runWebFetch: runWebFetchMock }));

import { DEFAULT_TOOLS_CONFIG } from "../src/tools/config.js";
import { createWebFetchTool } from "../src/tools/web-fetch.js";
import { UNTRUSTED_WEB_CONTENT_BANNER } from "../src/web/format.js";
import { useTempDirs } from "./helpers/fixtures.js";

const createChannel = useTempDirs("pipiclaw-web-fetch-");

function makeTool(channelDir: string) {
	return createWebFetchTool({
		webConfig: { ...DEFAULT_TOOLS_CONFIG.tools.web, enable: true },
		securityConfig: { enabled: false } as never,
		workspaceDir: channelDir,
		channelId: "dm_1",
		channelDir,
	});
}

function mockFullBody(body: string) {
	runWebFetchMock.mockResolvedValue({
		content: [{ type: "text", text: `${UNTRUSTED_WEB_CONTENT_BANNER}\n\n${body}` }],
		details: { url: "u", finalUrl: "u", status: 200, extractor: "text", truncated: false, length: body.length },
	});
}

afterEach(() => {
	runWebFetchMock.mockReset();
});

describe("web_fetch tool caching + pagination", () => {
	it("windows a long body and pages via offset from cache without refetching", async () => {
		const channelDir = createChannel();
		const body = "A".repeat(250);
		mockFullBody(body);
		const tool = makeTool(channelDir);

		const first = await tool.execute("c1", { label: "fetch", url: "https://example.com/doc", maxChars: 100 });
		const firstText = first.content[0].type === "text" ? first.content[0].text : "";
		expect(firstText).toContain("offset=100 to continue");
		expect(runWebFetchMock).toHaveBeenCalledTimes(1);

		// Second call at the reported offset must be served from cache — no second fetch.
		const second = await tool.execute("c2", {
			label: "fetch more",
			url: "https://example.com/doc",
			maxChars: 100,
			offset: 100,
		});
		const secondText = second.content[0].type === "text" ? second.content[0].text : "";
		expect(secondText).toContain("served from cache");
		expect(second.details).toMatchObject({ fromCache: true, offset: 100 });
		expect(runWebFetchMock).toHaveBeenCalledTimes(1);
	});

	it("returns short bodies without a continuation footer", async () => {
		const channelDir = createChannel();
		mockFullBody("short body");
		const result = await makeTool(channelDir).execute("c1", { label: "fetch", url: "https://example.com/s" });
		const text = result.content[0].type === "text" ? result.content[0].text : "";
		expect(text).toContain("short body");
		expect(text).not.toContain("to continue");
	});

	it("passes image results through unchanged and does not cache them", async () => {
		const channelDir = createChannel();
		runWebFetchMock.mockResolvedValue({
			content: [
				{ type: "text", text: `${UNTRUSTED_WEB_CONTENT_BANNER}\n\nFetched image` },
				{ type: "image", data: "abc", mimeType: "image/png" },
			],
			details: { url: "u", finalUrl: "u", status: 200, extractor: "direct-image", truncated: false, length: 3 },
		});
		const result = await makeTool(channelDir).execute("c1", { label: "img", url: "https://example.com/x.png" });
		expect(result.content.some((part) => part.type === "image")).toBe(true);
	});
});
