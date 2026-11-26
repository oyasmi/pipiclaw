import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { PipiclawWebToolsConfig, WebSearchProvider } from "../config/tools.js";
import type { SecurityConfig } from "../security/types.js";
import { RecoverableToolError } from "../shared/recoverable-error.js";
import { resolveWebSearchRequest, supportsSearchFilters, type WebSearchInput } from "../web/config.js";
import { runWebSearch, type WebSearchOutput } from "../web/search.js";
import { WebSearchProviderError } from "../web/search-providers.js";

const basicSearchFields = {
	query: Type.String({ minLength: 1, description: "Search query." }),
	count: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Maximum results to return (1-10)" })),
};

const filterFields = {
	includeDomains: Type.Optional(
		Type.Array(Type.String({ minLength: 1, maxLength: 253 }), {
			maxItems: 20,
			description: "Restrict results to these bare domains, such as nodejs.org.",
		}),
	),
	excludeDomains: Type.Optional(
		Type.Array(Type.String({ minLength: 1, maxLength: 253 }), {
			maxItems: 20,
			description: "Exclude results from these bare domains.",
		}),
	),
	publishedAfter: Type.Optional(
		Type.String({
			pattern: "^\\d{4}-\\d{2}-\\d{2}$",
			description: "Earliest publication date in YYYY-MM-DD format.",
		}),
	),
};

function searchSchema(provider: WebSearchProvider) {
	const options = { additionalProperties: false };
	if (provider === "parallel") {
		return Type.Object(
			{
				...basicSearchFields,
				...filterFields,
				query: Type.String({ minLength: 1, description: "Primary short keyword query." }),
				objective: Type.Optional(
					Type.String({
						minLength: 1,
						maxLength: 4_096,
						description:
							"Standalone goal for the search. Specify the facts and sources needed beyond the keyword query.",
					}),
				),
				queries: Type.Optional(
					Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
						maxItems: 2,
						description: "Up to two additional short keyword queries for the same objective.",
					}),
				),
			},
			options,
		);
	}
	if (supportsSearchFilters(provider)) return Type.Object({ ...basicSearchFields, ...filterFields }, options);
	return Type.Object(basicSearchFields, options);
}

export interface WebSearchToolOptions {
	webConfig: PipiclawWebToolsConfig;
	securityConfig: SecurityConfig;
	workspaceDir: string;
	channelId?: string;
}

export function createWebSearchTool(options: WebSearchToolOptions) {
	const { search } = options.webConfig;
	return {
		name: "web_search",
		label: "web_search",
		description: `Search the public web using ${search.provider}. Returns titles, URLs, excerpts and publication dates when available.`,
		parameters: searchSchema(search.provider),
		execute: async (
			_toolCallId: string,
			input: WebSearchInput,
			signal?: AbortSignal,
		): Promise<AgentToolResult<WebSearchOutput["details"]>> => {
			signal?.throwIfAborted();
			const request = resolveWebSearchRequest(search, input);
			try {
				const result = await runWebSearch(options, request, signal);
				return {
					content: [{ type: "text", text: result.content }],
					details: result.details,
				};
			} catch (error) {
				if (error instanceof WebSearchProviderError && error.kind === "invalid_request") {
					throw new RecoverableToolError(error.message);
				}
				throw error;
			}
		},
	} satisfies AgentTool<ReturnType<typeof searchSchema>>;
}
