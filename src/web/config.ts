import type { PipiclawWebFetchConfig, PipiclawWebSearchConfig, PipiclawWebToolsConfig } from "../tools/config.js";

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
		count: clamp(count, config.maxResults, 1, 10),
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
		maxChars: clamp(maxChars, config.maxChars, 100),
		timeoutMs: config.timeoutMs,
		maxImageBytes: config.maxImageBytes,
		maxResponseBytes: config.maxResponseBytes,
		preferJina: config.preferJina,
		enableJinaFallback: config.enableJinaFallback,
	};
}

export function isWebToolsEnabled(config: PipiclawWebToolsConfig): boolean {
	return config.enable !== false;
}

function clamp(value: number | undefined, fallback: number, minimum: number, maximum?: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return fallback;
	}
	const normalized = Math.floor(value);
	if (normalized < minimum) {
		return fallback;
	}
	if (maximum !== undefined && normalized > maximum) {
		return fallback;
	}
	return normalized;
}
