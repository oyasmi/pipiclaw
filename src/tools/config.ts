import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_HOME_DIR, TOOLS_CONFIG_PATH } from "../paths.js";
import type { ConfigDiagnostic } from "../shared/config-diagnostics.js";
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
	maxResponseBytes: number;
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
		memory: {
			sessionSearch: {
				enabled: boolean;
			};
		};
		skills: {
			manage: {
				enabled: boolean;
			};
		};
	};
}

export interface LoadedToolsConfig {
	config: PipiclawToolsConfig;
	diagnostics: ConfigDiagnostic[];
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
				maxResponseBytes: 5 * 1024 * 1024,
				preferJina: false,
				enableJinaFallback: false,
				defaultExtractMode: "markdown",
			},
		},
		memory: {
			sessionSearch: {
				enabled: true,
			},
		},
		skills: {
			manage: {
				enabled: true,
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

function pushInvalidValueDiagnostic(
	diagnostics: ConfigDiagnostic[],
	configPath: string,
	field: string,
	message: string,
): void {
	diagnostics.push({
		source: "tools",
		path: configPath,
		severity: "warning",
		message: `${field}: ${message}`,
	});
}

function mergeToolsConfig(source: unknown, configPath: string, diagnostics: ConfigDiagnostic[]): PipiclawToolsConfig {
	if (!isRecord(source)) {
		pushInvalidValueDiagnostic(diagnostics, configPath, "root", "expected a JSON object; using defaults");
		return DEFAULT_TOOLS_CONFIG;
	}

	const tools = isRecord(source.tools) ? source.tools : {};
	const web = isRecord(tools.web) ? tools.web : {};
	const memory = isRecord(tools.memory) ? tools.memory : {};
	const sessionSearch = isRecord(memory.sessionSearch) ? memory.sessionSearch : {};
	const skills = isRecord(tools.skills) ? tools.skills : {};
	const manage = isRecord(skills.manage) ? skills.manage : {};
	const search = isRecord(web.search) ? web.search : {};
	const fetch = isRecord(web.fetch) ? web.fetch : {};

	const providerValue = asTrimmedString(search.provider, DEFAULT_TOOLS_CONFIG.tools.web.search.provider).toLowerCase();
	const provider = WEB_SEARCH_PROVIDERS.includes(providerValue as WebSearchProvider)
		? (providerValue as WebSearchProvider)
		: (() => {
				if (search.provider !== undefined) {
					pushInvalidValueDiagnostic(
						diagnostics,
						configPath,
						"tools.web.search.provider",
						`unknown provider "${String(search.provider)}"; using ${DEFAULT_TOOLS_CONFIG.tools.web.search.provider}`,
					);
				}
				return DEFAULT_TOOLS_CONFIG.tools.web.search.provider;
			})();
	const defaultExtractMode = asTrimmedString(
		fetch.defaultExtractMode,
		DEFAULT_TOOLS_CONFIG.tools.web.fetch.defaultExtractMode,
	);
	if (web.proxy !== undefined && web.proxy !== null && typeof web.proxy !== "string") {
		pushInvalidValueDiagnostic(diagnostics, configPath, "tools.web.proxy", "expected a string or null; using null");
	}
	if (search.maxResults !== undefined && clampInteger(search.maxResults, -1, 1, 10) === -1) {
		pushInvalidValueDiagnostic(
			diagnostics,
			configPath,
			"tools.web.search.maxResults",
			"expected an integer between 1 and 10; using default",
		);
	}
	if (search.timeoutMs !== undefined && clampInteger(search.timeoutMs, -1, 1) === -1) {
		pushInvalidValueDiagnostic(
			diagnostics,
			configPath,
			"tools.web.search.timeoutMs",
			"expected a positive integer; using default",
		);
	}
	if (fetch.maxChars !== undefined && clampInteger(fetch.maxChars, -1, 100) === -1) {
		pushInvalidValueDiagnostic(
			diagnostics,
			configPath,
			"tools.web.fetch.maxChars",
			"expected an integer >= 100; using default",
		);
	}
	if (fetch.timeoutMs !== undefined && clampInteger(fetch.timeoutMs, -1, 1) === -1) {
		pushInvalidValueDiagnostic(
			diagnostics,
			configPath,
			"tools.web.fetch.timeoutMs",
			"expected a positive integer; using default",
		);
	}
	if (fetch.maxImageBytes !== undefined && clampInteger(fetch.maxImageBytes, -1, 1) === -1) {
		pushInvalidValueDiagnostic(
			diagnostics,
			configPath,
			"tools.web.fetch.maxImageBytes",
			"expected a positive integer; using default",
		);
	}
	if (fetch.maxResponseBytes !== undefined && clampInteger(fetch.maxResponseBytes, -1, 1) === -1) {
		pushInvalidValueDiagnostic(
			diagnostics,
			configPath,
			"tools.web.fetch.maxResponseBytes",
			"expected a positive integer; using default",
		);
	}
	if (fetch.defaultExtractMode !== undefined && defaultExtractMode !== "text" && defaultExtractMode !== "markdown") {
		pushInvalidValueDiagnostic(
			diagnostics,
			configPath,
			"tools.web.fetch.defaultExtractMode",
			`expected "markdown" or "text"; using ${DEFAULT_TOOLS_CONFIG.tools.web.fetch.defaultExtractMode}`,
		);
	}

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
					maxResponseBytes: clampInteger(
						fetch.maxResponseBytes,
						DEFAULT_TOOLS_CONFIG.tools.web.fetch.maxResponseBytes,
						1,
					),
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
			memory: {
				sessionSearch: {
					enabled:
						typeof sessionSearch.enabled === "boolean"
							? sessionSearch.enabled
							: DEFAULT_TOOLS_CONFIG.tools.memory.sessionSearch.enabled,
				},
			},
			skills: {
				manage: {
					enabled:
						typeof manage.enabled === "boolean"
							? manage.enabled
							: DEFAULT_TOOLS_CONFIG.tools.skills.manage.enabled,
				},
			},
		},
	};
}

export function getToolsConfigPath(appHomeDir = APP_HOME_DIR): string {
	return appHomeDir === APP_HOME_DIR ? TOOLS_CONFIG_PATH : join(appHomeDir, "tools.json");
}

export function loadToolsConfigWithDiagnostics(appHomeDir = APP_HOME_DIR): LoadedToolsConfig {
	const configPath = getToolsConfigPath(appHomeDir);
	if (!existsSync(configPath)) {
		return { config: DEFAULT_TOOLS_CONFIG, diagnostics: [] };
	}

	try {
		const raw = JSON.parse(readFileSync(configPath, "utf-8"));
		const diagnostics: ConfigDiagnostic[] = [];
		return {
			config: mergeToolsConfig(raw, configPath, diagnostics),
			diagnostics,
		};
	} catch (error) {
		return {
			config: DEFAULT_TOOLS_CONFIG,
			diagnostics: [
				{
					source: "tools",
					path: configPath,
					severity: "error",
					message: error instanceof Error ? error.message : String(error),
				},
			],
		};
	}
}

export function loadToolsConfig(appHomeDir = APP_HOME_DIR): PipiclawToolsConfig {
	return loadToolsConfigWithDiagnostics(appHomeDir).config;
}
