import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { SecurityConfig } from "../security/types.js";
import { resolveWebFetchRequest } from "../web/config.js";
import { runWebFetch } from "../web/fetch.js";
import type { PipiclawWebToolsConfig } from "./config.js";

const webFetchSchema = Type.Object({
	label: Type.String({ description: "Brief description of what you're fetching and why (shown to user)" }),
	url: Type.String({ description: "HTTP or HTTPS URL to fetch" }),
	extractMode: Type.Optional(
		Type.Union([Type.Literal("markdown"), Type.Literal("text")], {
			description: "Preferred text extraction format for HTML pages",
		}),
	),
	maxChars: Type.Optional(Type.Number({ description: "Maximum extracted text characters to return" })),
});

export interface WebFetchToolOptions {
	webConfig: PipiclawWebToolsConfig;
	securityConfig: SecurityConfig;
	workspaceDir: string;
	channelId?: string;
}

export function createWebFetchTool(options: WebFetchToolOptions): AgentTool<typeof webFetchSchema> {
	return {
		name: "web_fetch",
		label: "web_fetch",
		description:
			"Fetch a public URL and extract readable content. Returns text for HTML/JSON/text pages and image content blocks for images.",
		parameters: webFetchSchema,
		execute: async (
			_toolCallId: string,
			{
				url,
				extractMode,
				maxChars,
			}: { label: string; url: string; extractMode?: "markdown" | "text"; maxChars?: number },
			signal?: AbortSignal,
		) => {
			const request = resolveWebFetchRequest(options.webConfig.fetch, url, extractMode, maxChars);
			const result = await runWebFetch(
				{
					webConfig: options.webConfig,
					securityConfig: options.securityConfig,
					workspaceDir: options.workspaceDir,
					channelId: options.channelId,
				},
				request,
				signal,
			);
			return result;
		},
	};
}
