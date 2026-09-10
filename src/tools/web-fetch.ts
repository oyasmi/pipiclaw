import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { SecurityConfig } from "../security/types.js";
import { RecoverableToolError } from "../shared/recoverable-error.js";
import { resolveWebFetchRequest } from "../web/config.js";
import { runWebFetch } from "../web/fetch.js";
import { formatFetchedText, UNTRUSTED_WEB_CONTENT_BANNER } from "../web/format.js";
import type { PipiclawWebToolsConfig } from "./config.js";
import { clearWebCacheEntry, readWebCache, type WebCacheEntry, webCacheKey, writeWebCache } from "./web-cache.js";

// Large cap used to fetch the full readable body for caching; the displayed window is bounded by the
// configured/requested maxChars. Still smaller than maxResponseBytes so a hostile page can't OOM us.
const FULL_FETCH_MAX_CHARS = 2_000_000;

const webFetchSchema = Type.Object({
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
				"Character offset into the page body to start from. Use the offset the previous call reported to page through a long page — it is served from the cached snapshot with no refetch.",
		}),
	),
	refresh: Type.Optional(
		Type.Boolean({
			description: "Bypass the cached snapshot and fetch the page again. Use when you need current content.",
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

function ageHint(fetchedAt: number): string {
	const seconds = Math.max(0, Math.round((Date.now() - fetchedAt) / 1000));
	if (seconds < 90) return "just now";
	if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
	return `${Math.round(seconds / 3600)}h ago`;
}

function windowResult(
	entry: WebCacheEntry,
	requestedUrl: string,
	offset: number,
	maxChars: number,
	fromCache: boolean,
) {
	const body = entry.body;
	const start = Math.min(offset, body.length);
	const end = Math.min(start + maxChars, body.length);
	const slice = body.slice(start, end);
	let text = formatFetchedText(slice);

	const notes: string[] = [];
	if (entry.finalUrl && entry.finalUrl !== requestedUrl) {
		notes.push(`Final URL after redirects: ${entry.finalUrl}`);
	}
	if (fromCache) {
		notes.push(`Snapshot fetched ${ageHint(entry.fetchedAt)}; pass refresh:true for current content.`);
	}
	// "This page has more to page through" and "the origin gave us a partial page" are different
	// facts and must not be conflated (fix plan §2.7).
	if (end < body.length) {
		notes.push(
			`Showing chars ${start}-${end} of ${body.length} in this snapshot. Re-call with the same url and offset=${end} to continue.`,
		);
	} else if (offset >= body.length && body.length > 0) {
		notes.push(`End of the cached snapshot (${body.length} chars).`);
	}
	if (entry.sourceTruncated) {
		notes.push(
			`The origin returned more than the fetch limit — even at the end of this snapshot you have NOT seen the whole page.`,
		);
	}
	if (notes.length > 0) {
		text += `\n\n[${notes.join(" ")}]`;
	}

	return {
		content: [{ type: "text" as const, text }],
		details: {
			url: requestedUrl,
			finalUrl: entry.finalUrl || requestedUrl,
			status: entry.status,
			extractor: entry.extractor,
			contentType: entry.contentType,
			offset: start,
			shownChars: slice.length,
			totalChars: body.length,
			sourceTruncated: entry.sourceTruncated,
			fetchedAt: entry.fetchedAt,
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
			"blocks for images (binary downloads like PDFs are refused — download then read). Long pages are cached " +
			"per channel as a snapshot; page through with offset (no refetch), or pass refresh:true for current content.",
		parameters: webFetchSchema,
		execute: async (
			_toolCallId: string,
			{
				url,
				extractMode,
				maxChars,
				offset,
				refresh,
			}: {
				url: string;
				extractMode?: "markdown" | "text";
				maxChars?: number;
				offset?: number;
				refresh?: boolean;
			},
			signal?: AbortSignal,
		) => {
			const request = resolveWebFetchRequest(options.webConfig.fetch, url, extractMode, maxChars);
			const displayMaxChars = request.maxChars;
			const startOffset = offset && offset > 0 ? offset : 0;

			// Cache is per-channel; when no channelDir is available (e.g. sub-agent path) fall back to a
			// plain single-shot fetch with the requested maxChars. An `offset` here would otherwise be
			// silently dropped -- the caller gets the first screen back with no way to tell "reached
			// the end" from "pagination just doesn't work here" (fix plan §4.5), and can spin retrying
			// the same offset forever.
			if (!options.channelDir) {
				if (startOffset > 0) {
					throw new RecoverableToolError(
						"This context does not support web_fetch pagination (no per-channel cache available); " +
							"offset is ignored here. Increase maxChars instead, or have the main agent fetch the page.",
					);
				}
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
			if (refresh) {
				await clearWebCacheEntry(options.channelDir, key);
			} else {
				const cached = await readWebCache(options.channelDir, key);
				if (cached) {
					return windowResult(cached, url, startOffset, displayMaxChars, true);
				}
			}

			// Paging into a page whose snapshot has expired (or was never taken) must not silently
			// stitch a window of a *fresh* snapshot onto offsets the model computed against an older
			// one. Make it re-read from the top.
			if (startOffset > 0) {
				throw new RecoverableToolError(
					`The cached snapshot for ${url} is no longer available, so offset=${startOffset} would point into a different version of the page. ` +
						"Re-call web_fetch with offset=0 (optionally refresh:true) to take a fresh snapshot, then page from there.",
				);
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

			const entry: WebCacheEntry = {
				body: stripBanner(textPart.text),
				fetchedAt: Date.now(),
				finalUrl: result.details.finalUrl,
				status: result.details.status,
				extractor: result.details.extractor,
				contentType: result.details.contentType,
				sourceTruncated: result.details.truncated === true,
			};
			await writeWebCache(options.channelDir, key, entry);
			return windowResult(entry, url, startOffset, displayMaxChars, false);
		},
	};
}
