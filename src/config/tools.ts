/**
 * `tools.json`: the web, rtk, task and inline-delegation tool settings — their types, defaults, the
 * loader with diagnostics, and the path of the file.
 */
import { join } from "node:path";
import { APP_HOME_DIR } from "../paths.js";
import { type ConfigDiagnostic, loadJsonConfig, pushConfigWarning } from "../shared/config-diagnostic.js";
import type { AssertNoMissingKeys } from "../shared/exact-keys.js";
import { clampInteger } from "../shared/format.js";
import { isRecord } from "../shared/type-guards.js";

const WEB_SEARCH_PROVIDERS = ["tavily", "jina", "searxng", "duckduckgo", "parallel"] as const;
export type WebSearchProvider = (typeof WEB_SEARCH_PROVIDERS)[number];

export interface WebSearchBackendConfig {
	provider: WebSearchProvider;
	apiKey: string;
	baseUrl: string;
}

export interface PipiclawWebSearchConfig extends WebSearchBackendConfig {
	fallback: WebSearchBackendConfig | null;
	parallelMode: "fast" | "advanced";
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
		/**
		 * Master switch for the autonomous long-running task mechanism: gates the
		 * task_* tools, the task lane (new steps), and the per-turn task digest
		 * together. Core capabilities (read/bash/edit/write/grep, memory, skills,
		 * events, background jobs) are always on and have no switches.
		 */
		tasks: {
			enabled: boolean;
		};
		bashInterceptor: {
			enabled: boolean;
		};
		rtk: {
			enabled: boolean;
		};
		/** Gates the `subagent_inline` tool (spec 046, D2.3). Default true; the role directory
		 *  covers most delegation, so a deployment can turn this off once it does. */
		subagentInline: {
			enabled: boolean;
		};
	};
}

export interface LoadedToolsConfig {
	config: PipiclawToolsConfig;
	diagnostics: ConfigDiagnostic[];
}

/**
 * Every `tools.<key>` section in `tools.json`. Kept in sync with
 * `PipiclawToolsConfig["tools"]` by `satisfies` (rejects an extra/misspelled entry) and
 * `AssertNoMissingKeys` (rejects a section with no entry here) — both at `npm run typecheck`.
 */
export const TOOLS_CONFIG_SECTION_KEYS = [
	"web",
	"tasks",
	"bashInterceptor",
	"rtk",
	"subagentInline",
] as const satisfies readonly (keyof PipiclawToolsConfig["tools"])[];
const _toolsConfigKeysComplete: AssertNoMissingKeys<PipiclawToolsConfig["tools"], typeof TOOLS_CONFIG_SECTION_KEYS> =
	true;
void _toolsConfigKeysComplete;

const MAX_SEARCH_TIMEOUT_MS = 2_147_483_647;
const DEFAULT_SEARCH_BACKEND: WebSearchBackendConfig = { provider: "duckduckgo", apiKey: "", baseUrl: "" };

export const DEFAULT_TOOLS_CONFIG: PipiclawToolsConfig = {
	tools: {
		web: {
			enable: false,
			proxy: null,
			search: {
				...DEFAULT_SEARCH_BACKEND,
				fallback: DEFAULT_SEARCH_BACKEND,
				parallelMode: "fast",
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
		tasks: {
			enabled: true,
		},
		bashInterceptor: {
			enabled: true,
		},
		rtk: {
			enabled: false,
		},
		subagentInline: {
			enabled: true,
		},
	},
};

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
	pushConfigWarning(diagnostics, "tools", configPath, field, message);
}

function readSearchBackend(value: Record<string, unknown>): WebSearchBackendConfig | null {
	const name = asTrimmedString(value.provider).toLowerCase();
	const provider = WEB_SEARCH_PROVIDERS.find((candidate) => candidate === name);
	return provider
		? { provider, apiKey: asTrimmedString(value.apiKey), baseUrl: asTrimmedString(value.baseUrl) }
		: null;
}

function mergeToolsConfig(source: unknown, configPath: string, diagnostics: ConfigDiagnostic[]): PipiclawToolsConfig {
	if (!isRecord(source)) {
		pushInvalidValueDiagnostic(diagnostics, configPath, "root", "expected a JSON object; using defaults");
		return DEFAULT_TOOLS_CONFIG;
	}

	const tools = isRecord(source.tools) ? source.tools : {};
	const web = isRecord(tools.web) ? tools.web : {};
	const tasks = isRecord(tools.tasks) ? tools.tasks : {};
	const bashInterceptor = isRecord(tools.bashInterceptor) ? tools.bashInterceptor : {};
	const rtk = isRecord(tools.rtk) ? tools.rtk : {};
	const subagentInline = isRecord(tools.subagentInline) ? tools.subagentInline : {};
	const search = isRecord(web.search) ? web.search : {};
	const fetch = isRecord(web.fetch) ? web.fetch : {};

	const backend = readSearchBackend(search);
	if (!backend && search.provider !== undefined) {
		pushInvalidValueDiagnostic(
			diagnostics,
			configPath,
			"tools.web.search.provider",
			`unknown provider "${String(search.provider)}"; using duckduckgo`,
		);
	}
	const fallback =
		search.fallback === undefined
			? DEFAULT_SEARCH_BACKEND
			: isRecord(search.fallback)
				? readSearchBackend(search.fallback)
				: null;
	if (search.fallback != null && !fallback) {
		pushInvalidValueDiagnostic(
			diagnostics,
			configPath,
			"tools.web.search.fallback",
			"expected null or a known provider object; disabling fallback",
		);
	}
	const parallelMode = search.parallelMode === "advanced" ? "advanced" : "fast";
	if (search.parallelMode !== undefined && search.parallelMode !== parallelMode) {
		pushInvalidValueDiagnostic(
			diagnostics,
			configPath,
			"tools.web.search.parallelMode",
			'expected "fast" or "advanced"; using fast',
		);
	}
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
	if (search.timeoutMs !== undefined && clampInteger(search.timeoutMs, -1, 1, MAX_SEARCH_TIMEOUT_MS) === -1) {
		pushInvalidValueDiagnostic(
			diagnostics,
			configPath,
			"tools.web.search.timeoutMs",
			`expected an integer between 1 and ${MAX_SEARCH_TIMEOUT_MS}; using default`,
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
					...(backend ?? DEFAULT_SEARCH_BACKEND),
					fallback,
					parallelMode,
					maxResults: clampInteger(search.maxResults, DEFAULT_TOOLS_CONFIG.tools.web.search.maxResults, 1, 10),
					timeoutMs: clampInteger(
						search.timeoutMs,
						DEFAULT_TOOLS_CONFIG.tools.web.search.timeoutMs,
						1,
						MAX_SEARCH_TIMEOUT_MS,
					),
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
			tasks: {
				enabled: typeof tasks.enabled === "boolean" ? tasks.enabled : DEFAULT_TOOLS_CONFIG.tools.tasks.enabled,
			},
			bashInterceptor: {
				enabled:
					typeof bashInterceptor.enabled === "boolean"
						? bashInterceptor.enabled
						: DEFAULT_TOOLS_CONFIG.tools.bashInterceptor.enabled,
			},
			rtk: {
				enabled: typeof rtk.enabled === "boolean" ? rtk.enabled : DEFAULT_TOOLS_CONFIG.tools.rtk.enabled,
			},
			subagentInline: {
				enabled:
					typeof subagentInline.enabled === "boolean"
						? subagentInline.enabled
						: DEFAULT_TOOLS_CONFIG.tools.subagentInline.enabled,
			},
		},
	};
}

export function getToolsConfigPath(appHomeDir = APP_HOME_DIR): string {
	return join(appHomeDir, "tools.json");
}

export function loadToolsConfigWithDiagnostics(appHomeDir = APP_HOME_DIR): LoadedToolsConfig {
	return loadJsonConfig({
		source: "tools",
		path: getToolsConfigPath(appHomeDir),
		defaults: DEFAULT_TOOLS_CONFIG,
		merge: mergeToolsConfig,
	});
}

export function loadToolsConfig(appHomeDir = APP_HOME_DIR): PipiclawToolsConfig {
	return loadToolsConfigWithDiagnostics(appHomeDir).config;
}
