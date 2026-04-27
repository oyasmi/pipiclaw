import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import type { SecurityConfig } from "../security/types.js";
import { resolveWebSearchRequest } from "../web/config.js";
import { runWebSearch } from "../web/search.js";
import type { PipiclawWebToolsConfig } from "./config.js";

const webSearchSchema = Type.Object({
	label: Type.String({ description: "Brief description of what you're searching for and why (shown to user)" }),
	query: Type.String({ description: "Search query" }),
	count: Type.Optional(Type.Number({ description: "Maximum number of results to return (1-10)" })),
});

export interface WebSearchToolOptions {
	webConfig: PipiclawWebToolsConfig;
	securityConfig: SecurityConfig;
	workspaceDir: string;
	channelId?: string;
}

export function createWebSearchTool(options: WebSearchToolOptions): AgentTool<typeof webSearchSchema> {
	return {
		name: "web_search",
		label: "web_search",
		description: "Search the public web and return titles, URLs, and snippets from the configured provider.",
		parameters: webSearchSchema,
		execute: async (
			_toolCallId: string,
			{ query, count }: { label: string; query: string; count?: number },
			signal?: AbortSignal,
		) => {
			const request = resolveWebSearchRequest(options.webConfig.search, query, count);
			const result = await runWebSearch(
				{
					webConfig: options.webConfig,
					securityConfig: options.securityConfig,
					workspaceDir: options.workspaceDir,
					channelId: options.channelId,
				},
				request.query,
				request.count,
				signal,
			);
			return {
				content: [{ type: "text", text: result.content }],
				details: result.details,
			};
		},
	};
}
