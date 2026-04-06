import type { SecurityConfig } from "../security/types.js";
import type { PipiclawWebSearchConfig, PipiclawWebToolsConfig } from "../tools/config.js";
import { createWebHttpClient } from "./client.js";
import { formatWebSearchText, type WebSearchResultItem } from "./format.js";
import { createSearchProvider, WebSearchProviderError } from "./search-providers.js";

export interface WebSearchExecutionContext {
	webConfig: PipiclawWebToolsConfig;
	securityConfig: SecurityConfig;
	workspaceDir: string;
	channelId?: string;
}

export interface WebSearchOutput {
	content: string;
	details: {
		provider: string;
		query: string;
		count: number;
		results: WebSearchResultItem[];
	};
}

async function executeProviderSearch(
	config: PipiclawWebSearchConfig,
	context: WebSearchExecutionContext,
	query: string,
	count: number,
	signal?: AbortSignal,
): Promise<{ provider: string; results: WebSearchResultItem[] }> {
	const client = createWebHttpClient({
		webConfig: context.webConfig,
		securityConfig: context.securityConfig,
		workspaceDir: context.workspaceDir,
		channelId: context.channelId,
	});
	const provider = createSearchProvider(config.provider, { client, config });
	return {
		provider: config.provider,
		results: await provider.search(query, count, signal),
	};
}

export async function runWebSearch(
	context: WebSearchExecutionContext,
	query: string,
	count: number,
	signal?: AbortSignal,
): Promise<WebSearchOutput> {
	const searchConfig = context.webConfig.search;

	try {
		const primary = await executeProviderSearch(searchConfig, context, query, count, signal);
		return {
			content: formatWebSearchText(query, primary.results),
			details: {
				provider: primary.provider,
				query,
				count,
				results: primary.results,
			},
		};
	} catch (error) {
		if (
			searchConfig.provider !== "duckduckgo" &&
			error instanceof WebSearchProviderError &&
			error.kind === "provider"
		) {
			const fallbackConfig: PipiclawWebSearchConfig = {
				...searchConfig,
				provider: "duckduckgo",
			};
			const fallback = await executeProviderSearch(fallbackConfig, context, query, count, signal);
			return {
				content: formatWebSearchText(query, fallback.results),
				details: {
					provider: fallback.provider,
					query,
					count,
					results: fallback.results,
				},
			};
		}
		throw error;
	}
}
