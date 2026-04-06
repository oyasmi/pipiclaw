import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_HOME_DIR, TOOLS_CONFIG_PATH } from "../paths.js";
import { isRecord } from "../shared/type-guards.js";

export type WebSearchProvider = "brave" | "tavily" | "jina" | "searxng" | "duckduckgo";

export interface PipiclawWebSearchConfig {
	provider: WebSearchProvider;
	apiKey: string;
	baseUrl: string;
	maxResults: number;
	timeoutMs: number;
}

export interface PipiclawWebFetchConfig {
	maxChars: number;
	timeoutMs: number;
	maxImageBytes: number;
	preferJina: boolean;
	enableJinaFallback: boolean;
	defaultExtractMode: "markdown" | "text";
}

export interface PipiclawWebToolsConfig {
	enable: boolean;
	proxy: string | null;
	search: PipiclawWebSearchConfig;
	fetch: PipiclawWebFetchConfig;
}

export interface PipiclawToolsConfig {
	tools: {
		web: PipiclawWebToolsConfig;
	};
}

const WEB_SEARCH_PROVIDERS: readonly WebSearchProvider[] = ["brave", "tavily", "jina", "searxng", "duckduckgo"];

export const DEFAULT_TOOLS_CONFIG: PipiclawToolsConfig = {
	tools: {
		web: {
			enable: false,
			proxy: null,
			search: {
				provider: "brave",
				apiKey: "",
				baseUrl: "",
				maxResults: 5,
				timeoutMs: 30_000,
			},
			fetch: {
				maxChars: 50_000,
				timeoutMs: 30_000,
				maxImageBytes: 10 * 1024 * 1024,
				preferJina: false,
				enableJinaFallback: false,
				defaultExtractMode: "markdown",
			},
		},
	},
};

function clampInteger(value: unknown, fallback: number, minimum: number, maximum?: number): number {
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

function asTrimmedString(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value.trim() : fallback;
}

function asOptionalProxy(value: unknown): string | null {
	if (value === null || value === undefined) {
		return null;
	}
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function mergeToolsConfig(source: unknown): PipiclawToolsConfig {
	if (!isRecord(source)) {
		return DEFAULT_TOOLS_CONFIG;
	}

	const tools = isRecord(source.tools) ? source.tools : {};
	const web = isRecord(tools.web) ? tools.web : {};
	const search = isRecord(web.search) ? web.search : {};
	const fetch = isRecord(web.fetch) ? web.fetch : {};

	const providerValue = asTrimmedString(search.provider, DEFAULT_TOOLS_CONFIG.tools.web.search.provider).toLowerCase();
	const provider = WEB_SEARCH_PROVIDERS.includes(providerValue as WebSearchProvider)
		? (providerValue as WebSearchProvider)
		: DEFAULT_TOOLS_CONFIG.tools.web.search.provider;
	const defaultExtractMode = asTrimmedString(
		fetch.defaultExtractMode,
		DEFAULT_TOOLS_CONFIG.tools.web.fetch.defaultExtractMode,
	);

	return {
		tools: {
			web: {
				enable: typeof web.enable === "boolean" ? web.enable : DEFAULT_TOOLS_CONFIG.tools.web.enable,
				proxy: asOptionalProxy(web.proxy),
				search: {
					provider,
					apiKey: asTrimmedString(search.apiKey),
					baseUrl: asTrimmedString(search.baseUrl),
					maxResults: clampInteger(search.maxResults, DEFAULT_TOOLS_CONFIG.tools.web.search.maxResults, 1, 10),
					timeoutMs: clampInteger(search.timeoutMs, DEFAULT_TOOLS_CONFIG.tools.web.search.timeoutMs, 1),
				},
				fetch: {
					maxChars: clampInteger(fetch.maxChars, DEFAULT_TOOLS_CONFIG.tools.web.fetch.maxChars, 100),
					timeoutMs: clampInteger(fetch.timeoutMs, DEFAULT_TOOLS_CONFIG.tools.web.fetch.timeoutMs, 1),
					maxImageBytes: clampInteger(fetch.maxImageBytes, DEFAULT_TOOLS_CONFIG.tools.web.fetch.maxImageBytes, 1),
					preferJina:
						typeof fetch.preferJina === "boolean"
							? fetch.preferJina
							: DEFAULT_TOOLS_CONFIG.tools.web.fetch.preferJina,
					enableJinaFallback:
						typeof fetch.enableJinaFallback === "boolean"
							? fetch.enableJinaFallback
							: DEFAULT_TOOLS_CONFIG.tools.web.fetch.enableJinaFallback,
					defaultExtractMode:
						defaultExtractMode === "text" || defaultExtractMode === "markdown"
							? defaultExtractMode
							: DEFAULT_TOOLS_CONFIG.tools.web.fetch.defaultExtractMode,
				},
			},
		},
	};
}

export function getToolsConfigPath(appHomeDir = APP_HOME_DIR): string {
	return appHomeDir === APP_HOME_DIR ? TOOLS_CONFIG_PATH : join(appHomeDir, "tools.json");
}

export function loadToolsConfig(appHomeDir = APP_HOME_DIR): PipiclawToolsConfig {
	const configPath = getToolsConfigPath(appHomeDir);
	if (!existsSync(configPath)) {
		return DEFAULT_TOOLS_CONFIG;
	}

	try {
		const raw = JSON.parse(readFileSync(configPath, "utf-8"));
		return mergeToolsConfig(raw);
	} catch (error) {
		console.warn(`Failed to load tools config from ${configPath}: ${error}`);
		return DEFAULT_TOOLS_CONFIG;
	}
}
