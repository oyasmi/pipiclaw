import { describe, expect, it, vi } from "vitest";

const { requestText } = vi.hoisted(() => ({ requestText: vi.fn() }));
vi.mock("../src/web/client.js", () => ({ createWebHttpClient: () => ({ requestText }) }));

import { DEFAULT_TOOLS_CONFIG } from "../src/config/tools.js";
import { DEFAULT_SECURITY_CONFIG } from "../src/security/config.js";
import { runWebSearch } from "../src/web/search.js";

describe("default web search", () => {
	it("searches DuckDuckGo without credentials and returns parsed results", async () => {
		requestText.mockResolvedValueOnce({
			response: { status: 200 },
			text: `<div class="result"><h2 class="result__title"><a href="https://example.com/">Example</a></h2><p class="result__snippet">A result</p></div>
				<div class="result"><a class="result__a" href="https://example.org/">Another</a></div>`,
		});
		const result = await runWebSearch(
			{
				webConfig: DEFAULT_TOOLS_CONFIG.tools.web,
				securityConfig: DEFAULT_SECURITY_CONFIG,
				workspaceDir: "/workspace",
			},
			"example query",
			1,
		);
		expect(requestText).toHaveBeenCalledWith(
			expect.objectContaining({
				url: "https://html.duckduckgo.com/html/",
				params: { q: "example query" },
			}),
		);
		expect(result.details.provider).toBe("duckduckgo");
		expect(result.details.results).toEqual([{ title: "Example", url: "https://example.com/", snippet: "A result" }]);
	});
});
