import { addAbortListener } from "node:events";
import type { PipiclawWebToolsConfig, WebSearchBackendConfig, WebSearchProvider } from "../config/tools.js";
import * as log from "../log.js";
import type { SecurityConfig } from "../security/types.js";
import { RecoverableToolError } from "../shared/recoverable-error.js";
import { createWebHttpClient } from "./client.js";
import { hasSearchFilters, type ResolvedWebSearchRequest, supportsSearchFilters } from "./config.js";
import { formatWebSearchText, type WebSearchResultItem } from "./format.js";
import { searchByProvider, WebSearchProviderError } from "./search-providers.js";

export interface WebSearchExecutionContext {
	webConfig: PipiclawWebToolsConfig;
	securityConfig: SecurityConfig;
	workspaceDir: string;
	channelId?: string;
}

interface SearchFallback {
	from: WebSearchProvider;
	reason: WebSearchProviderError["kind"];
}

export interface WebSearchOutput {
	content: string;
	details: {
		provider: WebSearchProvider;
		query: string;
		count: number;
		results: WebSearchResultItem[];
		durationMs: number;
		searchId?: string;
		fallback?: SearchFallback;
	};
}

async function runAttempt(
	search: (signal: AbortSignal) => ReturnType<typeof searchByProvider>,
	provider: WebSearchProvider,
	timeoutMs: number,
	callerSignal?: AbortSignal,
): ReturnType<typeof searchByProvider> {
	callerSignal?.throwIfAborted();
	const deadline = new AbortController();
	const signal = callerSignal ? AbortSignal.any([callerSignal, deadline.signal]) : deadline.signal;
	const timer = setTimeout(() => {
		deadline.abort(
			new WebSearchProviderError("timeout", `${provider} search timed out. Retry once or narrow the search.`),
		);
	}, timeoutMs);
	// DNS validation can still be awaiting a lookup while the signal is aborted.
	// Race it here, and pass the same signal down so it cannot start HTTP afterward.
	let listener: ReturnType<typeof addAbortListener> | undefined;
	const aborted = new Promise<never>((_resolve, reject) => {
		listener = addAbortListener(signal, () => reject(signal.reason));
	});
	try {
		return await Promise.race([search(signal), aborted]);
	} finally {
		clearTimeout(timer);
		listener?.[Symbol.dispose]();
	}
}

function canSwitchProvider(error: unknown): error is WebSearchProviderError {
	return error instanceof WebSearchProviderError && error.kind !== "configuration" && error.kind !== "invalid_request";
}

export async function runWebSearch(
	context: WebSearchExecutionContext,
	request: ResolvedWebSearchRequest,
	signal?: AbortSignal,
): Promise<WebSearchOutput> {
	signal?.throwIfAborted();
	const config = context.webConfig.search;
	const filtered = hasSearchFilters(request);
	if (filtered && !supportsSearchFilters(config.provider)) {
		throw new RecoverableToolError(
			"The configured search provider does not support source filters. Omit the filters or ask the operator to use Parallel or Tavily.",
		);
	}
	const fallback =
		config.fallback &&
		config.fallback.provider !== config.provider &&
		(!filtered || supportsSearchFilters(config.fallback.provider))
			? config.fallback
			: null;
	const startedAt = performance.now();
	const client = createWebHttpClient(context);

	async function execute(
		backend: WebSearchBackendConfig,
		timeoutMs: number,
		switched?: SearchFallback,
	): Promise<WebSearchOutput> {
		const attemptStartedAt = performance.now();
		try {
			const { results, searchId } = await runAttempt(
				(attemptSignal) =>
					searchByProvider(
						{ client, backend, parallelMode: config.parallelMode, timeoutMs, signal: attemptSignal },
						request,
					),
				backend.provider,
				timeoutMs,
				signal,
			);
			signal?.throwIfAborted();
			const durationMs = Math.round(performance.now() - startedAt);
			log.logInfoEvent("web.search.completed", "Web search completed", {
				channelId: context.channelId,
				fields: {
					provider: backend.provider,
					durationMs,
					resultCount: results.length,
					fallbackFrom: switched?.from,
				},
			});
			return {
				content: formatWebSearchText(request.query, backend.provider, results, switched?.from),
				details: {
					provider: backend.provider,
					query: request.query,
					count: request.count,
					results,
					durationMs,
					...(searchId ? { searchId } : {}),
					...(switched ? { fallback: switched } : {}),
				},
			};
		} catch (error) {
			signal?.throwIfAborted();
			if (error instanceof WebSearchProviderError) {
				log.logWarn("web.search.failed", "Web search failed", {
					channelId: context.channelId,
					reason: error.kind,
					fields: { provider: backend.provider, durationMs: Math.round(performance.now() - attemptStartedAt) },
				});
			}
			throw error;
		}
	}

	// Leave a third of the total budget for a second provider when one can honor the request.
	const primaryBudget = fallback ? Math.max(1, Math.floor((config.timeoutMs * 2) / 3)) : config.timeoutMs;
	try {
		return await execute(config, primaryBudget);
	} catch (error) {
		signal?.throwIfAborted();
		const remainingMs = Math.floor(config.timeoutMs - (performance.now() - startedAt));
		if (!fallback || !canSwitchProvider(error) || remainingMs < 1) throw error;
		return execute(fallback, remainingMs, { from: config.provider, reason: error.kind });
	}
}
