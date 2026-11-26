import type { PipiclawWebFetchConfig, PipiclawWebSearchConfig, WebSearchProvider } from "../config/tools.js";
import { clampInteger } from "../shared/format.js";
import { RecoverableToolError } from "../shared/recoverable-error.js";

export interface WebSearchInput {
	query: string;
	count?: number;
	objective?: string;
	queries?: string[];
	includeDomains?: string[];
	excludeDomains?: string[];
	publishedAfter?: string;
}

export interface ResolvedWebSearchRequest extends WebSearchInput {
	count: number;
	queries: string[];
	includeDomains: string[];
	excludeDomains: string[];
}

export interface ResolvedWebFetchRequest {
	url: string;
	extractMode: "markdown" | "text";
	maxChars: number;
	timeoutMs: number;
	maxImageBytes: number;
	maxResponseBytes: number;
	preferJina: boolean;
	enableJinaFallback: boolean;
}

export function supportsSearchFilters(provider: WebSearchProvider): boolean {
	return provider === "parallel" || provider === "tavily";
}

export function hasSearchFilters(request: ResolvedWebSearchRequest): boolean {
	return (
		request.publishedAfter !== undefined || request.includeDomains.length > 0 || request.excludeDomains.length > 0
	);
}

export function isSearchDate(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const parsed = new Date(value);
	return Number.isFinite(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

function normalizeDomains(values: string[] | undefined): string[] {
	const domains = new Set<string>();
	for (const value of values ?? []) {
		const domain = value.trim().toLowerCase();
		if (
			domain.length > 253 ||
			!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(domain)
		) {
			throw new RecoverableToolError("Use bare domains such as example.org in includeDomains and excludeDomains.");
		}
		domains.add(domain);
	}
	return [...domains];
}

export function resolveWebSearchRequest(
	config: PipiclawWebSearchConfig,
	input: WebSearchInput,
): ResolvedWebSearchRequest {
	const query = input.query.trim();
	if (!query) throw new RecoverableToolError("Enter a non-empty search query.");
	const objective = input.objective?.trim();
	const queries = [...new Set([query, ...(input.queries ?? []).map((value) => value.trim()).filter(Boolean)])];
	const publishedAfter = input.publishedAfter?.trim();
	if (publishedAfter !== undefined && !isSearchDate(publishedAfter)) {
		throw new RecoverableToolError("Enter a valid publication date in YYYY-MM-DD format for publishedAfter.");
	}
	return {
		query,
		count: clampInteger(input.count, config.maxResults, 1, 10),
		objective: objective || undefined,
		queries,
		includeDomains: normalizeDomains(input.includeDomains),
		excludeDomains: normalizeDomains(input.excludeDomains),
		publishedAfter,
	};
}

export function resolveWebFetchRequest(
	config: PipiclawWebFetchConfig,
	url: string,
	extractMode?: "markdown" | "text",
	maxChars?: number,
): ResolvedWebFetchRequest {
	return {
		url: url.trim(),
		extractMode:
			extractMode === "text" ? "text" : extractMode === "markdown" ? "markdown" : config.defaultExtractMode,
		maxChars: clampInteger(maxChars, config.maxChars, 100),
		timeoutMs: config.timeoutMs,
		maxImageBytes: config.maxImageBytes,
		maxResponseBytes: config.maxResponseBytes,
		preferJina: config.preferJina,
		enableJinaFallback: config.enableJinaFallback,
	};
}
