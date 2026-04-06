import { JSDOM } from "jsdom";
import type { PipiclawWebSearchConfig, WebSearchProvider as WebSearchProviderName } from "../tools/config.js";
import type { WebHttpClient } from "./client.js";
import type { WebSearchResultItem } from "./format.js";

export class WebSearchProviderError extends Error {
	readonly kind: "config" | "provider";

	constructor(kind: "config" | "provider", message: string) {
		super(message);
		this.name = "WebSearchProviderError";
		this.kind = kind;
	}
}

export interface SearchProviderContext {
	client: WebHttpClient;
	config: PipiclawWebSearchConfig;
}

export interface SearchProvider {
	search(query: string, count: number, signal?: AbortSignal): Promise<WebSearchResultItem[]>;
}

function normalizeResult(item: Partial<WebSearchResultItem>): WebSearchResultItem | null {
	const title = item.title?.trim() ?? "";
	const url = item.url?.trim() ?? "";
	const snippet = item.snippet?.trim() ?? "";
	if (!url) {
		return null;
	}
	return {
		title: title || url,
		url,
		snippet,
	};
}

class BraveSearchProvider implements SearchProvider {
	constructor(private readonly context: SearchProviderContext) {}

	async search(query: string, count: number, signal?: AbortSignal): Promise<WebSearchResultItem[]> {
		if (!this.context.config.apiKey) {
			throw new WebSearchProviderError("config", "Brave search requires tools.web.search.apiKey");
		}
		const { response, data } = await this.context.client.requestJson<{
			web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
		}>({
			url: "https://api.search.brave.com/res/v1/web/search",
			params: { q: query, count },
			headers: {
				"X-Subscription-Token": this.context.config.apiKey,
				Accept: "application/json",
			},
			timeoutMs: this.context.config.timeoutMs,
			signal,
		});
		if (response.status < 200 || response.status >= 300) {
			throw new WebSearchProviderError("provider", `Brave search failed with HTTP ${response.status}`);
		}
		return (data.web?.results ?? [])
			.map((item) =>
				normalizeResult({
					title: item.title,
					url: item.url,
					snippet: item.description,
				}),
			)
			.filter((item): item is WebSearchResultItem => item !== null)
			.slice(0, count);
	}
}

class TavilySearchProvider implements SearchProvider {
	constructor(private readonly context: SearchProviderContext) {}

	async search(query: string, count: number, signal?: AbortSignal): Promise<WebSearchResultItem[]> {
		if (!this.context.config.apiKey) {
			throw new WebSearchProviderError("config", "Tavily search requires tools.web.search.apiKey");
		}
		const { response, data } = await this.context.client.requestJson<{
			results?: Array<{ title?: string; url?: string; content?: string }>;
		}>({
			method: "POST",
			url: "https://api.tavily.com/search",
			headers: {
				Authorization: `Bearer ${this.context.config.apiKey}`,
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			data: { query, max_results: count },
			timeoutMs: this.context.config.timeoutMs,
			signal,
		});
		if (response.status < 200 || response.status >= 300) {
			throw new WebSearchProviderError("provider", `Tavily search failed with HTTP ${response.status}`);
		}
		return (data.results ?? [])
			.map((item) =>
				normalizeResult({
					title: item.title,
					url: item.url,
					snippet: item.content,
				}),
			)
			.filter((item): item is WebSearchResultItem => item !== null)
			.slice(0, count);
	}
}

class JinaSearchProvider implements SearchProvider {
	constructor(private readonly context: SearchProviderContext) {}

	async search(query: string, count: number, signal?: AbortSignal): Promise<WebSearchResultItem[]> {
		if (!this.context.config.apiKey) {
			throw new WebSearchProviderError("config", "Jina search requires tools.web.search.apiKey");
		}
		const { response, data } = await this.context.client.requestJson<{
			data?: Array<{ title?: string; url?: string; content?: string }>;
		}>({
			url: `https://s.jina.ai/${encodeURIComponent(query)}`,
			headers: {
				Authorization: `Bearer ${this.context.config.apiKey}`,
				Accept: "application/json",
			},
			timeoutMs: this.context.config.timeoutMs,
			signal,
		});
		if (response.status < 200 || response.status >= 300) {
			throw new WebSearchProviderError("provider", `Jina search failed with HTTP ${response.status}`);
		}
		return (data.data ?? [])
			.map((item) =>
				normalizeResult({
					title: item.title,
					url: item.url,
					snippet: item.content,
				}),
			)
			.filter((item): item is WebSearchResultItem => item !== null)
			.slice(0, count);
	}
}

class SearxngSearchProvider implements SearchProvider {
	constructor(private readonly context: SearchProviderContext) {}

	async search(query: string, count: number, signal?: AbortSignal): Promise<WebSearchResultItem[]> {
		if (!this.context.config.baseUrl) {
			throw new WebSearchProviderError("config", "SearXNG search requires tools.web.search.baseUrl");
		}
		const baseUrl = new URL("/search", this.context.config.baseUrl).toString();
		const { response, data } = await this.context.client.requestJson<{
			results?: Array<{ title?: string; url?: string; content?: string }>;
		}>({
			url: baseUrl,
			params: { q: query, format: "json" },
			timeoutMs: this.context.config.timeoutMs,
			signal,
		});
		if (response.status < 200 || response.status >= 300) {
			throw new WebSearchProviderError("provider", `SearXNG search failed with HTTP ${response.status}`);
		}
		return (data.results ?? [])
			.map((item) =>
				normalizeResult({
					title: item.title,
					url: item.url,
					snippet: item.content,
				}),
			)
			.filter((item): item is WebSearchResultItem => item !== null)
			.slice(0, count);
	}
}

class DuckDuckGoSearchProvider implements SearchProvider {
	constructor(private readonly context: SearchProviderContext) {}

	async search(query: string, count: number, signal?: AbortSignal): Promise<WebSearchResultItem[]> {
		const { response, text } = await this.context.client.requestText({
			url: "https://html.duckduckgo.com/html/",
			params: { q: query },
			headers: { Accept: "text/html" },
			timeoutMs: this.context.config.timeoutMs,
			signal,
		});
		if (response.status < 200 || response.status >= 300) {
			throw new WebSearchProviderError("provider", `DuckDuckGo search failed with HTTP ${response.status}`);
		}

		const dom = new JSDOM(text);
		const items = Array.from(dom.window.document.querySelectorAll(".result"));
		const results: WebSearchResultItem[] = [];
		for (const item of items) {
			const link = item.querySelector(".result__title a") ?? item.querySelector("a.result__a");
			const snippet = item.querySelector(".result__snippet");
			const href = link?.getAttribute("href")?.trim() ?? "";
			if (!href) {
				continue;
			}
			results.push({
				title: link?.textContent?.trim() || href,
				url: href,
				snippet: snippet?.textContent?.trim() || "",
			});
			if (results.length >= count) {
				break;
			}
		}
		return results;
	}
}

export function createSearchProvider(provider: WebSearchProviderName, context: SearchProviderContext): SearchProvider {
	switch (provider) {
		case "brave":
			return new BraveSearchProvider(context);
		case "tavily":
			return new TavilySearchProvider(context);
		case "jina":
			return new JinaSearchProvider(context);
		case "searxng":
			return new SearxngSearchProvider(context);
		case "duckduckgo":
			return new DuckDuckGoSearchProvider(context);
		default:
			throw new WebSearchProviderError("config", `Unknown search provider: ${provider}`);
	}
}
