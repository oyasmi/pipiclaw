import { clampInteger } from "../shared/numeric.js";
import type { PipiclawWebFetchConfig, PipiclawWebSearchConfig } from "../tools/config.js";

export interface ResolvedWebSearchRequest {
	query: string;
	count: number;
	timeoutMs: number;
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

export function resolveWebSearchRequest(
	config: PipiclawWebSearchConfig,
	query: string,
	count?: number,
): ResolvedWebSearchRequest {
	return {
		query: query.trim(),
		count: clampInteger(count, config.maxResults, 1, 10),
		timeoutMs: config.timeoutMs,
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
