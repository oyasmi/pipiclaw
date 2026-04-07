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
import { runWebSearch } from "../src/web/search.js";

const baseContext = {
	webConfig: DEFAULT_TOOLS_CONFIG.tools.web,
	securityConfig: DEFAULT_SECURITY_CONFIG,
	workspaceDir: "/workspace",
	channelId: "dm_test",
};

describe("web search", () => {
	beforeEach(() => {
		requestMock.mockReset();
		lookupMock.mockReset();
		lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
	});

	it("queries Brave with the configured API key", async () => {
		requestMock.mockResolvedValueOnce({
			status: 200,
			headers: { "content-type": "application/json" },
			data: Buffer.from(
				JSON.stringify({
					web: {
						results: [{ title: "NanoBot", url: "https://example.com", description: "AI assistant" }],
					},
				}),
			),
		});

		const result = await runWebSearch(
			{
				...baseContext,
				webConfig: {
					...baseContext.webConfig,
					search: {
						...baseContext.webConfig.search,
						provider: "brave",
						apiKey: "brave-key",
					},
				},
			},
			"nanobot",
			1,
		);

		expect(requestMock).toHaveBeenCalledWith(
			expect.objectContaining({
				url: "https://api.search.brave.com/res/v1/web/search?q=nanobot&count=1",
				headers: expect.objectContaining({
					"X-Subscription-Token": "brave-key",
				}),
			}),
		);
		expect(result.content).toContain("NanoBot");
		expect(result.details.provider).toBe("brave");
	});

	it("falls back to DuckDuckGo on recoverable provider failure", async () => {
		requestMock
			.mockResolvedValueOnce({
				status: 503,
				headers: { "content-type": "application/json" },
				data: Buffer.from(JSON.stringify({ error: "unavailable" })),
			})
			.mockResolvedValueOnce({
				status: 200,
				headers: { "content-type": "text/html" },
				data: Buffer.from(
					`<html><body><div class="result"><a class="result__a" href="https://ddg.example">Fallback</a><a class="result__snippet">DuckDuckGo fallback</a></div></body></html>`,
				),
			});

		const result = await runWebSearch(
			{
				...baseContext,
				webConfig: {
					...baseContext.webConfig,
					search: {
						...baseContext.webConfig.search,
						provider: "brave",
						apiKey: "brave-key",
					},
				},
			},
			"fallback",
			1,
		);

		expect(result.details.provider).toBe("duckduckgo");
		expect(result.content).toContain("DuckDuckGo fallback");
	});

	it("does not fall back when the configured provider rejects credentials", async () => {
		requestMock.mockResolvedValueOnce({
			status: 401,
			headers: { "content-type": "application/json" },
			data: Buffer.from(JSON.stringify({ error: "unauthorized" })),
		});

		await expect(
			runWebSearch(
				{
					...baseContext,
					webConfig: {
						...baseContext.webConfig,
						search: {
							...baseContext.webConfig.search,
							provider: "brave",
							apiKey: "bad-key",
						},
					},
				},
				"auth failure",
				1,
			),
		).rejects.toThrow("Brave search failed with HTTP 401");
		expect(requestMock).toHaveBeenCalledTimes(1);
	});

	it("uses SearXNG baseUrl from tools config", async () => {
		requestMock.mockResolvedValueOnce({
			status: 200,
			headers: { "content-type": "application/json" },
			data: Buffer.from(
				JSON.stringify({
					results: [{ title: "SearXNG Result", url: "https://example.com", content: "Search result" }],
				}),
			),
		});

		const result = await runWebSearch(
			{
				...baseContext,
				webConfig: {
					...baseContext.webConfig,
					search: {
						...baseContext.webConfig.search,
						provider: "searxng",
						baseUrl: "https://searx.example/base",
					},
				},
			},
			"searx",
			1,
		);

		expect(requestMock).toHaveBeenCalledWith(
			expect.objectContaining({
				url: "https://searx.example/search?q=searx&format=json",
			}),
		);
		expect(result.content).toContain("SearXNG Result");
	});
});
