import axios from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TOOLS_CONFIG, type PipiclawWebSearchConfig } from "../src/config/tools.js";
import { DEFAULT_SECURITY_CONFIG } from "../src/security/config.js";
import { createWebSearchTool } from "../src/tools/web-search.js";

const defaultWeb = DEFAULT_TOOLS_CONFIG.tools.web;
const duckDuckGoUrl = "https://html.duckduckgo.com/html/?q=example+query";
const parallelUrl = "https://api.parallel.ai/v1/search";
const tavilyUrl = "https://api.tavily.com/search";

function makeTool(search: Partial<PipiclawWebSearchConfig> = {}) {
	return createWebSearchTool({
		webConfig: { ...defaultWeb, search: { ...defaultWeb.search, ...search } },
		securityConfig: {
			...DEFAULT_SECURITY_CONFIG,
			networkGuard: { ...DEFAULT_SECURITY_CONFIG.networkGuard, enabled: false },
		},
		workspaceDir: "/workspace",
	});
}

function reply(status: number, text: string) {
	return { status, headers: {}, data: Buffer.from(text) };
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("web search", () => {
	it("searches DuckDuckGo without credentials and returns the original result URL", async () => {
		const request = vi.spyOn(axios, "request").mockResolvedValueOnce(
			reply(
				200,
				`
			<div class="result"><h2 class="result__title"><a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F">Example</a></h2><p class="result__snippet">A result</p></div>
			<div class="result"><a class="result__a" href="https://example.org/">Another</a></div>`,
			),
		);
		const result = await makeTool().execute("search", { query: "example query", count: 1 });

		expect(request).toHaveBeenCalledWith(expect.objectContaining({ url: duckDuckGoUrl }));
		expect(result.details).toMatchObject({
			provider: "duckduckgo",
			results: [{ title: "Example", url: "https://example.com/", snippet: "A result" }],
		});
	});

	it("switches a DuckDuckGo 202 challenge to the configured backend once", async () => {
		const request = vi
			.spyOn(axios, "request")
			.mockResolvedValueOnce(reply(202, "<form id=challenge-form></form>"))
			.mockResolvedValueOnce(reply(200, '{"results":[]}'));

		const result = await makeTool({ fallback: { provider: "tavily", apiKey: "fallback-key", baseUrl: "" } }).execute(
			"search",
			{ query: "example query" },
		);

		expect(request.mock.calls.map(([options]) => options.url)).toEqual([duckDuckGoUrl, tavilyUrl]);
		expect(result.details).toMatchObject({
			provider: "tavily",
			fallback: { from: "duckduckgo", reason: "challenge" },
			results: [],
		});
	});

	it("recognizes a verification page served with HTTP 200", async () => {
		const request = vi.spyOn(axios, "request").mockResolvedValueOnce(reply(200, "<div id=anomaly-modal></div>"));
		await expect(makeTool().execute("search", { query: "example query" })).rejects.toMatchObject({
			kind: "challenge",
		});
		expect(request).toHaveBeenCalledOnce();
	});

	it("reports a genuine empty DuckDuckGo result without switching providers", async () => {
		const request = vi
			.spyOn(axios, "request")
			.mockResolvedValueOnce(reply(200, "<div class=no-results>No results</div>"));
		const result = await makeTool({ fallback: { provider: "tavily", apiKey: "fallback-key", baseUrl: "" } }).execute(
			"search",
			{ query: "example query" },
		);
		expect(request).toHaveBeenCalledOnce();
		expect(result.details).toMatchObject({ provider: "duckduckgo", results: [] });
		expect(result.details).not.toHaveProperty("fallback");
	});

	it("switches on a non-JSON rate-limit response and uses only the fallback credentials", async () => {
		const request = vi
			.spyOn(axios, "request")
			.mockResolvedValueOnce(reply(429, "<html>Rate limited</html>"))
			.mockResolvedValueOnce(reply(200, '{"results":[]}'));
		const result = await makeTool({
			provider: "parallel",
			apiKey: "primary-key",
			fallback: { provider: "tavily", apiKey: "fallback-key", baseUrl: "" },
		}).execute("search", { query: "example query", includeDomains: ["example.org"], publishedAfter: "2026-01-01" });

		expect(request.mock.calls.map(([options]) => options.url)).toEqual([parallelUrl, tavilyUrl]);
		const fallback = request.mock.calls[1]?.[0];
		expect(fallback?.headers).toMatchObject({ Authorization: "Bearer fallback-key" });
		expect(fallback?.headers).not.toHaveProperty("x-api-key");
		expect(fallback?.data).toMatchObject({
			include_domains: ["example.org"],
			start_date: "2026-01-01",
			filter_by_published_date: true,
		});
		expect(result.details).toMatchObject({
			provider: "tavily",
			fallback: { from: "parallel", reason: "rate_limit" },
		});
	});

	it("keeps an authentication failure actionable and avoids a fallback request", async () => {
		const request = vi.spyOn(axios, "request").mockResolvedValueOnce(reply(401, ""));
		await expect(
			makeTool({ provider: "parallel", apiKey: "rejected-key" }).execute("search", { query: "example query" }),
		).rejects.toMatchObject({ kind: "configuration" });
		expect(request).toHaveBeenCalledOnce();
	});

	it("does not silently remove source constraints if the provider returns malformed results", async () => {
		const request = vi.spyOn(axios, "request").mockResolvedValueOnce(reply(200, '{"error":"unexpected payload"}'));
		await expect(
			makeTool({ provider: "parallel", apiKey: "primary-key" }).execute("search", {
				query: "example query",
				includeDomains: ["example.org"],
			}),
		).rejects.toMatchObject({ kind: "invalid_response" });
		expect(request).toHaveBeenCalledOnce();
	});

	it("reserves time to switch after a primary timeout and stops at the original deadline", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		const request = vi.spyOn(axios, "request").mockImplementation(() => new Promise(() => {}));
		const outcome = makeTool({
			timeoutMs: 90,
			fallback: { provider: "tavily", apiKey: "fallback-key", baseUrl: "" },
		})
			.execute("search", { query: "example query" })
			.catch((error: unknown) => error);

		await vi.advanceTimersByTimeAsync(59);
		expect(request).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(1);
		expect(request.mock.calls.map(([options]) => options.url)).toEqual([duckDuckGoUrl, tavilyUrl]);
		expect(request.mock.calls[0]?.[0].signal?.aborted).toBe(true);
		await vi.advanceTimersByTimeAsync(30);
		expect(request.mock.calls[1]?.[0].signal?.aborted).toBe(true);
		expect(await outcome).toMatchObject({ kind: "timeout" });
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("cancels pending HTTP work and avoids fallback when the caller aborts", async () => {
		let arrived: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			arrived = resolve;
		});
		const request = vi.spyOn(axios, "request").mockImplementation(() => {
			arrived?.();
			return new Promise(() => {});
		});
		const controller = new AbortController();
		const tool = makeTool({ provider: "parallel", apiKey: "primary-key" });
		const outcome = tool.execute("search", { query: "example query" }, controller.signal);
		await started;
		const reason = new Error("caller stopped");
		controller.abort(reason);
		await expect(outcome).rejects.toBe(reason);
		expect(request.mock.calls[0]?.[0].signal?.aborted).toBe(true);
		expect(request).toHaveBeenCalledOnce();
	});

	it("sends a single native Parallel request with separate intent, keywords, and source policy", async () => {
		const request = vi.spyOn(axios, "request").mockResolvedValueOnce(
			reply(
				200,
				JSON.stringify({
					search_id: "search_probe",
					results: [
						{
							url: "https://example.org/report",
							title: "Report",
							publish_date: "2026-02-02",
							excerpts: ["Original statement", "Source table"],
						},
						{ url: "https://other.example.org", title: "Other", publish_date: null, excerpts: ["Other"] },
					],
				}),
			),
		);
		const result = await makeTool({ provider: "parallel", apiKey: "parallel-key", parallelMode: "advanced" }).execute(
			"search",
			{
				query: "example query",
				count: 1,
				objective: "Find primary evidence on the stated subject.",
				queries: ["alternate terms", "example query"],
				includeDomains: ["Example.ORG"],
				excludeDomains: ["archive.example.org"],
				publishedAfter: "2026-01-01",
			},
		);

		expect(request).toHaveBeenCalledOnce();
		expect(request).toHaveBeenCalledWith(
			expect.objectContaining({
				method: "POST",
				url: parallelUrl,
				headers: expect.objectContaining({ "x-api-key": "parallel-key" }),
				data: expect.objectContaining({
					objective: "Find primary evidence on the stated subject.",
					search_queries: ["example query", "alternate terms"],
					mode: "advanced",
					advanced_settings: {
						max_results: 1,
						source_policy: {
							include_domains: ["example.org"],
							exclude_domains: ["archive.example.org"],
							after_date: "2026-01-01",
						},
					},
				}),
			}),
		);
		expect(result.details).toMatchObject({
			provider: "parallel",
			searchId: "search_probe",
			results: [
				{
					url: "https://example.org/report",
					publishedDate: "2026-02-02",
					snippet: "Original statement\n\nSource table",
				},
			],
		});
		expect(result.details.results).toHaveLength(1);
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("2026-02-02") });
	});
});
