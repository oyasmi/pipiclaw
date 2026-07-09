import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { SecurityConfig } from "../security/types.js";
import { resolveWebFetchRequest } from "../web/config.js";
import { runWebFetch } from "../web/fetch.js";
import { formatFetchedText, UNTRUSTED_WEB_CONTENT_BANNER } from "../web/format.js";
import type { PipiclawWebToolsConfig } from "./config.js";
import { readWebCache, webCacheKey, writeWebCache } from "./web-cache.js";

// Large cap used to fetch the full readable body for caching; the displayed window is bounded by the
// configured/requested maxChars. Still smaller than maxResponseBytes so a hostile page can't OOM us.
const FULL_FETCH_MAX_CHARS = 2_000_000;

const webFetchSchema = Type.Object({
	label: Type.String({ description: "Brief description of what you're fetching and why (shown to user)" }),
	url: Type.String({ description: "HTTP or HTTPS URL to fetch" }),
	extractMode: Type.Optional(
		Type.Union([Type.Literal("markdown"), Type.Literal("text")], {
			description: "Preferred text extraction format for HTML pages",
		}),
	),
	maxChars: Type.Optional(Type.Number({ description: "Maximum extracted text characters to return per call" })),
	offset: Type.Optional(
		Type.Integer({
			minimum: 0,
			description:
				"Character offset into the page body to start from. Use the offset the previous call reported to page through a long page — it is served from cache with no refetch.",
		}),
	),
});

export interface WebFetchToolOptions {
	webConfig: PipiclawWebToolsConfig;
	securityConfig: SecurityConfig;
	workspaceDir: string;
	channelId?: string;
	/** Present on the main path; enables per-channel body caching + offset pagination. */
	channelDir?: string;
}

/** Strip the untrusted-content banner that runWebFetch prepends, so the cached body is clean. */
function stripBanner(text: string): string {
	if (text.startsWith(UNTRUSTED_WEB_CONTENT_BANNER)) {
		return text.slice(UNTRUSTED_WEB_CONTENT_BANNER.length).replace(/^\n+/, "");
	}
	return text;
}

function windowResult(body: string, offset: number, maxChars: number, url: string, fromCache: boolean) {
	const start = Math.min(offset, body.length);
	const end = Math.min(start + maxChars, body.length);
	const slice = body.slice(start, end);
	let text = formatFetchedText(slice);
	if (end < body.length) {
		const cacheNote = fromCache ? " (served from cache, no refetch)" : "";
		text += `\n\n[Showing chars ${start}-${end} of ${body.length}. Re-call web_fetch with the same url and offset=${end} to continue${cacheNote}.]`;
	} else if (offset >= body.length && body.length > 0) {
		text += `\n\n[Reached end of page (${body.length} chars). No more content.]`;
	}
	return {
		content: [{ type: "text" as const, text }],
		details: {
			kind: "web_fetch",
			url,
			offset: start,
			shownChars: slice.length,
			totalChars: body.length,
			fromCache,
			untrusted: true,
		},
	};
}

export function createWebFetchTool(options: WebFetchToolOptions): AgentTool<typeof webFetchSchema> {
	return {
		name: "web_fetch",
		label: "web_fetch",
		description:
			"Fetch a public URL and extract readable content. Returns text for HTML/JSON/text pages and image content " +
			"blocks for images. Long pages are cached per channel; page through them with offset (no refetch).",
		parameters: webFetchSchema,
		execute: async (
			_toolCallId: string,
			{
				url,
				extractMode,
				maxChars,
				offset,
			}: { label: string; url: string; extractMode?: "markdown" | "text"; maxChars?: number; offset?: number },
			signal?: AbortSignal,
		) => {
			const request = resolveWebFetchRequest(options.webConfig.fetch, url, extractMode, maxChars);
			const displayMaxChars = request.maxChars;
			const startOffset = offset && offset > 0 ? offset : 0;

			// Cache is per-channel; when no channelDir is available (e.g. sub-agent path) fall back to a
			// plain single-shot fetch with the requested maxChars.
			if (!options.channelDir) {
				return runWebFetch(
					{
						webConfig: options.webConfig,
						securityConfig: options.securityConfig,
						workspaceDir: options.workspaceDir,
						channelId: options.channelId,
					},
					request,
					signal,
				);
			}

			const key = webCacheKey(url, request.extractMode);
			const cached = await readWebCache(options.channelDir, key);
			if (cached) {
				return windowResult(cached.body, startOffset, displayMaxChars, url, true);
			}

			// Cache miss: fetch the full readable body once, cache it, then serve the window.
			const result = await runWebFetch(
				{
					webConfig: options.webConfig,
					securityConfig: options.securityConfig,
					workspaceDir: options.workspaceDir,
					channelId: options.channelId,
				},
				{ ...request, maxChars: FULL_FETCH_MAX_CHARS },
				signal,
			);

			// Images (and any non-text result) are passed through unchanged — nothing to page or cache.
			const hasImage = result.content.some((part) => part.type === "image");
			const textPart = result.content.find((part) => part.type === "text");
			if (hasImage || !textPart || textPart.type !== "text") {
				return result;
			}

			const body = stripBanner(textPart.text);
			await writeWebCache(options.channelDir, key, body);
			return windowResult(body, startOffset, displayMaxChars, url, false);
		},
	};
}
