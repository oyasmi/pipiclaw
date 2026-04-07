import { beforeEach, describe, expect, it, vi } from "vitest";

const { requestMock, lookupMock } = vi.hoisted(() => ({
	requestMock: vi.fn(),
	lookupMock: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

vi.mock("axios", () => ({
	default: {
		request: requestMock,
	},
}));

vi.mock("node:dns/promises", () => ({
	lookup: lookupMock,
}));

import { DEFAULT_SECURITY_CONFIG } from "../src/security/config.js";
import { DEFAULT_TOOLS_CONFIG } from "../src/tools/config.js";
import { runWebFetch } from "../src/web/fetch.js";

const baseContext = {
	webConfig: DEFAULT_TOOLS_CONFIG.tools.web,
	securityConfig: DEFAULT_SECURITY_CONFIG,
	workspaceDir: "/workspace",
	channelId: "dm_test",
};

describe("web fetch", () => {
	beforeEach(() => {
		requestMock.mockReset();
		lookupMock.mockReset();
		lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
	});

	it("extracts HTML pages into text content", async () => {
		requestMock.mockResolvedValueOnce({
			status: 200,
			headers: { "content-type": "text/html" },
			data: Buffer.from(
				"<html><head><title>Test</title></head><body><article><h1>Hello</h1><p>World</p></article></body></html>",
			),
		});

		const result = await runWebFetch(baseContext, {
			url: "https://example.com/page",
			extractMode: "markdown",
			maxChars: 5000,
			maxImageBytes: baseContext.webConfig.fetch.maxImageBytes,
			maxResponseBytes: baseContext.webConfig.fetch.maxResponseBytes,
			preferJina: false,
			enableJinaFallback: false,
		});

		expect(result.content[0]).toMatchObject({ type: "text" });
		expect((result.content[0] as { text: string }).text).toContain("External content");
		expect((result.content[0] as { text: string }).text).toContain("Hello");
		expect(result.details.contentType).toContain("text/html");
		expect(result.details.untrusted).toBe(true);
	});

	it("returns pretty-printed JSON content", async () => {
		requestMock.mockResolvedValueOnce({
			status: 200,
			headers: { "content-type": "application/json" },
			data: Buffer.from(JSON.stringify({ ok: true, value: 42 })),
		});

		const result = await runWebFetch(baseContext, {
			url: "https://example.com/data.json",
			extractMode: "text",
			maxChars: 5000,
			maxImageBytes: baseContext.webConfig.fetch.maxImageBytes,
			maxResponseBytes: baseContext.webConfig.fetch.maxResponseBytes,
			preferJina: false,
			enableJinaFallback: false,
		});

		expect((result.content[0] as { text: string }).text).toContain('"ok": true');
		expect(result.details.extractor).toBe("json");
	});

	it("returns image content blocks for images", async () => {
		requestMock.mockResolvedValueOnce({
			status: 200,
			headers: { "content-type": "image/png" },
			data: Buffer.from("89504e470d0a1a0a", "hex"),
		});

		const result = await runWebFetch(baseContext, {
			url: "https://example.com/image.png",
			extractMode: "markdown",
			maxChars: 5000,
			maxImageBytes: baseContext.webConfig.fetch.maxImageBytes,
			maxResponseBytes: baseContext.webConfig.fetch.maxResponseBytes,
			preferJina: false,
			enableJinaFallback: false,
		});

		expect(result.content).toHaveLength(2);
		expect(result.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
		expect(result.details.extractor).toBe("direct-image");
	});

	it("ignores malformed inline CSS without logging parser noise", async () => {
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		requestMock.mockResolvedValueOnce({
			status: 200,
			headers: { "content-type": "text/html" },
			data: Buffer.from(`<!doctype html>
<html>
  <head>
    <title>Malformed CSS</title>
    <style>
      body>pre {
        margin-bottom: 0 !important;
        line-height: 0;
      }
      .article-section .comments-shares { justify-content: flex-end !important; height: 48px;}}
    </style>
  </head>
  <body>
    <article><h1>Readable Title</h1><p>Readable body</p></article>
  </body>
</html>`),
		});

		const result = await runWebFetch(baseContext, {
			url: "https://example.com/malformed-css",
			extractMode: "text",
			maxChars: 5000,
			maxImageBytes: baseContext.webConfig.fetch.maxImageBytes,
			maxResponseBytes: baseContext.webConfig.fetch.maxResponseBytes,
			preferJina: false,
			enableJinaFallback: false,
		});

		expect((result.content[0] as { text: string }).text).toContain("Readable body");
		expect(consoleErrorSpy).not.toHaveBeenCalled();
		consoleErrorSpy.mockRestore();
	});

	it("rejects oversized non-image responses before extraction", async () => {
		requestMock.mockRejectedValueOnce({
			isAxiosError: true,
			message: "maxContentLength size of 32 exceeded",
		});

		await expect(
			runWebFetch(baseContext, {
				url: "https://example.com/huge",
				extractMode: "text",
				maxChars: 5000,
				maxImageBytes: baseContext.webConfig.fetch.maxImageBytes,
				maxResponseBytes: 32,
				preferJina: false,
				enableJinaFallback: false,
			}),
		).rejects.toThrow("Response exceeds maxResponseBytes (32 bytes)");
	});
});
