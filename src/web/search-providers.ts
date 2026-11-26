import { isAxiosError } from "axios";
import { JSDOM } from "jsdom";
import type { PipiclawWebSearchConfig, WebSearchBackendConfig } from "../config/tools.js";
import { isRecord } from "../shared/type-guards.js";
import { type WebHttpClient, type WebHttpRequestOptions, WebResponseError } from "./client.js";
import { hasSearchFilters, isSearchDate, type ResolvedWebSearchRequest } from "./config.js";
import type { WebSearchResultItem } from "./format.js";

type SearchFailureKind =
	| "configuration"
	| "invalid_request"
	| "rate_limit"
	| "timeout"
	| "challenge"
	| "invalid_response"
	| "unavailable";

export class WebSearchProviderError extends Error {
	constructor(
		readonly kind: SearchFailureKind,
		message: string,
	) {
		super(message);
		this.name = "WebSearchProviderError";
	}
}

export interface SearchProviderContext {
	client: WebHttpClient;
	backend: WebSearchBackendConfig;
	parallelMode: PipiclawWebSearchConfig["parallelMode"];
	timeoutMs: number;
	signal: AbortSignal;
}

interface SearchBatch {
	results: WebSearchResultItem[];
	searchId?: string;
}

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_SNIPPET_CHARS = 1_500;
const DUCKDUCKGO_URL = "https://html.duckduckgo.com/html/";

function responseError(provider: string, status: number): WebSearchProviderError {
	const prefix = `${provider} search returned HTTP ${status}.`;
	if (status === 429)
		return new WebSearchProviderError("rate_limit", `${prefix} Wait before retrying or use another source.`);
	if (status === 408 || status === 504) {
		return new WebSearchProviderError("timeout", `${prefix} Retry once or narrow the search.`);
	}
	if ([401, 402, 403, 404].includes(status)) {
		return new WebSearchProviderError(
			"configuration",
			`${prefix} Ask the operator to check the provider settings and account access.`,
		);
	}
	if (status === 400 || status === 422) {
		return new WebSearchProviderError("invalid_request", `${prefix} Check the query and filters and retry once.`);
	}
	return new WebSearchProviderError("unavailable", `${prefix} Retry later or use another source.`);
}

function invalidResponse(provider: string): WebSearchProviderError {
	return new WebSearchProviderError(
		"invalid_response",
		`${provider} search returned an unexpected response. Use another source or retry later.`,
	);
}

async function requestSearchText(
	context: SearchProviderContext,
	options: Omit<WebHttpRequestOptions, "timeoutMs" | "signal" | "maxResponseBytes">,
): Promise<string> {
	const { client, backend, signal, timeoutMs } = context;
	const { provider } = backend;
	let payload: Awaited<ReturnType<WebHttpClient["requestText"]>>;
	try {
		payload = await client.requestText({ ...options, timeoutMs, signal, maxResponseBytes: MAX_RESPONSE_BYTES });
	} catch (error) {
		signal.throwIfAborted();
		if (error instanceof WebResponseError) throw invalidResponse(provider);
		if (!isAxiosError(error)) throw error;
		if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") {
			throw new WebSearchProviderError("timeout", `${provider} search timed out. Retry once or narrow the search.`);
		}
		throw new WebSearchProviderError(
			"unavailable",
			`${provider} search could not reach the server. Use another source or retry later.`,
		);
	}

	const { status } = payload.response;
	if (provider === "duckduckgo" && status === 202) throw duckDuckGoChallenge();
	if (status !== 200) throw responseError(provider, status);
	return payload.text;
}

function decodeSearchJson(text: string, provider: string): Record<string, unknown> {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		throw invalidResponse(provider);
	}
	if (!isRecord(data)) throw invalidResponse(provider);
	return data;
}

function buildResult(title: unknown, href: unknown, excerpt: unknown, date?: unknown): WebSearchResultItem | null {
	if (typeof href !== "string") return null;
	const url = URL.parse(href.trim());
	if (!url || !["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
	const publishedDate = typeof date === "string" ? /^\d{4}-\d{2}-\d{2}(?=$|T)/.exec(date)?.[0] : undefined;
	return {
		title: (typeof title === "string" ? title.trim().slice(0, 300) : "") || url.href,
		url: url.href,
		snippet: typeof excerpt === "string" ? excerpt.trim().slice(0, MAX_SNIPPET_CHARS) : "",
		...(publishedDate && isSearchDate(publishedDate) ? { publishedDate } : {}),
	};
}

function resultList(
	data: unknown,
	context: SearchProviderContext,
	count: number,
	parse: (row: Record<string, unknown>) => WebSearchResultItem | null,
): WebSearchResultItem[] {
	if (!Array.isArray(data)) throw invalidResponse(context.backend.provider);
	const results: WebSearchResultItem[] = [];
	for (const row of data) {
		const result = isRecord(row) ? parse(row) : null;
		if (result) results.push(result);
		if (results.length >= count) break;
	}
	if (data.length > 0 && results.length === 0) throw invalidResponse(context.backend.provider);
	return results;
}

function requireApiKey(context: SearchProviderContext): string {
	const { provider, apiKey } = context.backend;
	const key = apiKey || (provider === "parallel" ? process.env.PARALLEL_API_KEY?.trim() : undefined);
	if (key) return key;
	const envHint = provider === "parallel" ? " or set PARALLEL_API_KEY" : "";
	throw new WebSearchProviderError(
		"configuration",
		`${provider} search requires an API key. Ask the operator to set the apiKey for this search provider in tools.json${envHint}.`,
	);
}

async function searchParallel(context: SearchProviderContext, request: ResolvedWebSearchRequest): Promise<SearchBatch> {
	const { objective, queries, count, includeDomains, excludeDomains, publishedAfter } = request;
	const text = await requestSearchText(context, {
		method: "POST",
		url: "https://api.parallel.ai/v1/search",
		headers: { "x-api-key": requireApiKey(context), "Content-Type": "application/json", Accept: "application/json" },
		data: {
			objective,
			search_queries: queries,
			mode: context.parallelMode,
			max_chars_total: count * MAX_SNIPPET_CHARS,
			advanced_settings: {
				max_results: count,
				...(hasSearchFilters(request)
					? {
							source_policy: {
								include_domains: includeDomains.length ? includeDomains : undefined,
								exclude_domains: excludeDomains.length ? excludeDomains : undefined,
								after_date: publishedAfter,
							},
						}
					: {}),
			},
		},
	});
	const data = decodeSearchJson(text, context.backend.provider);
	return {
		searchId: typeof data.search_id === "string" ? data.search_id : undefined,
		results: resultList(data.results, context, count, (row) =>
			buildResult(
				row.title,
				row.url,
				Array.isArray(row.excerpts) ? row.excerpts.filter((part) => typeof part === "string").join("\n\n") : "",
				row.publish_date,
			),
		),
	};
}

async function searchTavily(context: SearchProviderContext, request: ResolvedWebSearchRequest): Promise<SearchBatch> {
	const { query, count, includeDomains, excludeDomains, publishedAfter } = request;
	const text = await requestSearchText(context, {
		method: "POST",
		url: "https://api.tavily.com/search",
		headers: {
			Authorization: `Bearer ${requireApiKey(context)}`,
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		data: {
			query,
			max_results: count,
			include_published_date: true,
			...(includeDomains.length ? { include_domains: includeDomains } : {}),
			...(excludeDomains.length ? { exclude_domains: excludeDomains } : {}),
			...(publishedAfter ? { start_date: publishedAfter, filter_by_published_date: true } : {}),
		},
	});
	const data = decodeSearchJson(text, context.backend.provider);
	return {
		results: resultList(data.results, context, count, (row) =>
			buildResult(row.title, row.url, row.content, row.published_date),
		),
	};
}

async function searchJina(
	context: SearchProviderContext,
	{ query, count }: ResolvedWebSearchRequest,
): Promise<SearchBatch> {
	const text = await requestSearchText(context, {
		url: `https://s.jina.ai/${encodeURIComponent(query)}`,
		headers: { Authorization: `Bearer ${requireApiKey(context)}`, Accept: "application/json" },
	});
	const data = decodeSearchJson(text, context.backend.provider);
	return { results: resultList(data.data, context, count, (row) => buildResult(row.title, row.url, row.content)) };
}

async function searchSearxng(
	context: SearchProviderContext,
	{ query, count }: ResolvedWebSearchRequest,
): Promise<SearchBatch> {
	const base = URL.parse(context.backend.baseUrl);
	if (!base || !["http:", "https:"].includes(base.protocol)) {
		throw new WebSearchProviderError(
			"configuration",
			"SearXNG search requires an HTTP(S) baseUrl. Ask the operator to set the URL in tools.json.",
		);
	}
	const text = await requestSearchText(context, {
		url: new URL("/search", base).href,
		params: { q: query, format: "json" },
		headers: { Accept: "application/json" },
	});
	const data = decodeSearchJson(text, context.backend.provider);
	return { results: resultList(data.results, context, count, (row) => buildResult(row.title, row.url, row.content)) };
}

function duckDuckGoChallenge(): WebSearchProviderError {
	return new WebSearchProviderError(
		"challenge",
		"DuckDuckGo returned a verification page. Use another search source or open the official site directly.",
	);
}

function duckDuckGoResultUrl(href: string): string | null {
	const url = URL.parse(href, DUCKDUCKGO_URL);
	if (url?.hostname === "duckduckgo.com" && url.pathname === "/l/") return url.searchParams.get("uddg");
	return url?.href ?? null;
}

async function searchDuckDuckGo(
	context: SearchProviderContext,
	{ query, count }: ResolvedWebSearchRequest,
): Promise<SearchBatch> {
	const text = await requestSearchText(context, {
		url: DUCKDUCKGO_URL,
		params: { q: query },
		headers: { Accept: "text/html" },
	});
	const { window } = new JSDOM(text);
	try {
		const document = window.document;
		if (document.querySelector("#challenge-form, #anomaly-modal, .anomaly-modal")) throw duckDuckGoChallenge();
		if (document.querySelector(".no-results, .result--no-result")) return { results: [] };
		const results: WebSearchResultItem[] = [];
		for (const item of document.querySelectorAll(".result")) {
			const link = item.querySelector(".result__title a, a.result__a");
			const href = link?.getAttribute("href");
			if (!link || !href) continue;
			const result = buildResult(
				link.textContent,
				duckDuckGoResultUrl(href),
				item.querySelector(".result__snippet")?.textContent,
			);
			if (result) results.push(result);
			if (results.length >= count) break;
		}
		if (results.length === 0) throw invalidResponse(context.backend.provider);
		return { results };
	} finally {
		window.close();
	}
}

const providers = {
	parallel: searchParallel,
	tavily: searchTavily,
	jina: searchJina,
	searxng: searchSearxng,
	duckduckgo: searchDuckDuckGo,
} satisfies Record<
	WebSearchBackendConfig["provider"],
	(context: SearchProviderContext, request: ResolvedWebSearchRequest) => Promise<SearchBatch>
>;

export function searchByProvider(
	context: SearchProviderContext,
	request: ResolvedWebSearchRequest,
): Promise<SearchBatch> {
	return providers[context.backend.provider](context, request);
}
