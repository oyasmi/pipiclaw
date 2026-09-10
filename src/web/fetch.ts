import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { SecurityConfig } from "../security/types.js";
import { RecoverableToolError } from "../shared/recoverable-error.js";
import type { PipiclawWebToolsConfig } from "../tools/config.js";
import { createWebHttpClient } from "./client.js";
import { extractReadableContent } from "./extract.js";
import { buildFetchedImageContent, buildFetchedTextContent, type FormattedFetchDetails } from "./format.js";

export interface WebFetchExecutionContext {
	webConfig: PipiclawWebToolsConfig;
	securityConfig: SecurityConfig;
	workspaceDir: string;
	channelId?: string;
}

export interface WebFetchOutput {
	content: Array<TextContent | ImageContent>;
	details: FormattedFetchDetails;
}

function trimToMaxChars(text: string, maxChars: number): { text: string; truncated: boolean } {
	if (text.length <= maxChars) {
		return { text, truncated: false };
	}
	return {
		text: text.slice(0, maxChars),
		truncated: true,
	};
}

/** Thrown when a URL serves a binary payload `web_fetch` should not try to render as text. */
export class WebFetchBinaryError extends RecoverableToolError {
	constructor(url: string, contentType: string) {
		super(
			`${url} is a binary download (${contentType.split(";")[0]}), not a readable page. ` +
				"Download it with bash (curl -L -o <file>), then open it with the read tool.",
		);
		this.name = "WebFetchBinaryError";
	}
}

const BINARY_CONTENT_TYPE_HINTS = [
	"application/pdf",
	"application/zip",
	"application/gzip",
	"application/x-tar",
	"application/octet-stream",
	"application/x-7z-compressed",
	"application/vnd.openxmlformats-officedocument",
	"application/msword",
	"application/vnd.ms-excel",
	"audio/",
	"video/",
	"font/",
];

function isBinaryContentType(contentType: string): boolean {
	return BINARY_CONTENT_TYPE_HINTS.some((hint) => contentType.includes(hint));
}

function decodeUtf8(body: Buffer): string {
	return new TextDecoder("utf-8", { fatal: false }).decode(body);
}

function isHtmlContent(contentType: string, body: Buffer): boolean {
	if (contentType.includes("text/html")) {
		return true;
	}
	const head = decodeUtf8(body.subarray(0, Math.min(body.length, 256)))
		.trimStart()
		.toLowerCase();
	return head.startsWith("<!doctype") || head.startsWith("<html");
}

async function tryFetchViaJina(
	context: WebFetchExecutionContext,
	url: string,
	maxChars: number,
	maxResponseBytes: number,
	signal?: AbortSignal,
): Promise<WebFetchOutput | null> {
	const client = createWebHttpClient({
		webConfig: context.webConfig,
		securityConfig: context.securityConfig,
		workspaceDir: context.workspaceDir,
		channelId: context.channelId,
	});
	const headers: Record<string, string> = { Accept: "application/json" };
	if (context.webConfig.search.apiKey && context.webConfig.search.provider === "jina") {
		headers.Authorization = `Bearer ${context.webConfig.search.apiKey}`;
	}
	const { response, data } = await client.requestJson<{
		data?: { url?: string; title?: string; content?: string };
	}>({
		url: `https://r.jina.ai/${url}`,
		headers,
		timeoutMs: context.webConfig.fetch.timeoutMs,
		maxResponseBytes,
		signal,
	});
	if (response.status < 200 || response.status >= 300 || !data.data?.content) {
		return null;
	}

	const title = data.data.title?.trim();
	const body = title ? `# ${title}\n\n${data.data.content}` : data.data.content;
	const trimmed = trimToMaxChars(body, maxChars);
	return {
		content: buildFetchedTextContent(trimmed.text),
		details: {
			url,
			finalUrl: data.data.url?.trim() || response.finalUrl,
			status: response.status,
			extractor: "jina",
			truncated: trimmed.truncated,
			length: trimmed.text.length,
			untrusted: true,
			contentType: "text/markdown",
		},
	};
}

async function fetchDirect(
	context: WebFetchExecutionContext,
	url: string,
	extractMode: "markdown" | "text",
	maxChars: number,
	maxImageBytes: number,
	maxResponseBytes: number,
	signal?: AbortSignal,
): Promise<WebFetchOutput> {
	const client = createWebHttpClient({
		webConfig: context.webConfig,
		securityConfig: context.securityConfig,
		workspaceDir: context.workspaceDir,
		channelId: context.channelId,
	});
	const response = await client.request({
		url,
		timeoutMs: context.webConfig.fetch.timeoutMs,
		maxResponseBytes,
		signal,
	});
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
	}

	const contentType = response.headers["content-type"]?.toLowerCase() ?? "application/octet-stream";
	if (contentType.startsWith("image/")) {
		if (response.body.length > maxImageBytes) {
			throw new Error(`Fetched image exceeds maxImageBytes (${maxImageBytes} bytes)`);
		}
		return {
			content: buildFetchedImageContent(
				response.body.toString("base64"),
				contentType.split(";")[0],
				response.finalUrl,
			),
			details: {
				url,
				finalUrl: response.finalUrl,
				status: response.status,
				extractor: "direct-image",
				truncated: false,
				length: response.body.length,
				untrusted: true,
				contentType,
			},
		};
	}

	// Non-HTML/JSON binary payloads (PDF, archives, media) would be `decodeUtf8`'d into mojibake and
	// passed off as page text. Refuse them with the right next step (fix plan §2.7). `octet-stream`
	// is also the default when a server sends no content-type, so let a body that sniffs as HTML
	// through rather than rejecting a headerless HTML page.
	if (isBinaryContentType(contentType) && !isHtmlContent(contentType, response.body)) {
		throw new WebFetchBinaryError(url, contentType);
	}

	let text = "";
	let extractor = "raw";
	if (contentType.includes("application/json")) {
		const parsed = JSON.parse(decodeUtf8(response.body));
		text = JSON.stringify(parsed, null, 2);
		extractor = "json";
	} else if (isHtmlContent(contentType, response.body)) {
		const html = decodeUtf8(response.body);
		const article = extractReadableContent(html, response.finalUrl, extractMode);
		text = article.title ? `# ${article.title}\n\n${article.content}` : article.content;
		extractor = article.extractor;
	} else {
		text = decodeUtf8(response.body);
		extractor = "text";
	}

	const trimmed = trimToMaxChars(text.trim(), maxChars);
	return {
		content: buildFetchedTextContent(trimmed.text),
		details: {
			url,
			finalUrl: response.finalUrl,
			status: response.status,
			extractor,
			truncated: trimmed.truncated,
			length: trimmed.text.length,
			untrusted: true,
			contentType,
		},
	};
}

export async function runWebFetch(
	context: WebFetchExecutionContext,
	request: {
		url: string;
		extractMode: "markdown" | "text";
		maxChars: number;
		maxImageBytes: number;
		maxResponseBytes: number;
		preferJina: boolean;
		enableJinaFallback: boolean;
	},
	signal?: AbortSignal,
): Promise<WebFetchOutput> {
	if (request.preferJina) {
		const jinaResult = await tryFetchViaJina(
			context,
			request.url,
			request.maxChars,
			request.maxResponseBytes,
			signal,
		);
		if (jinaResult) {
			return jinaResult;
		}
	}

	try {
		return await fetchDirect(
			context,
			request.url,
			request.extractMode,
			request.maxChars,
			request.maxImageBytes,
			request.maxResponseBytes,
			signal,
		);
	} catch (error) {
		// A binary payload is a definitive answer, not a transient direct-fetch failure — jina would
		// just return the same non-text content.
		if (error instanceof WebFetchBinaryError || !request.enableJinaFallback) {
			throw error;
		}
		const jinaResult = await tryFetchViaJina(
			context,
			request.url,
			request.maxChars,
			request.maxResponseBytes,
			signal,
		);
		if (jinaResult) {
			return jinaResult;
		}
		throw error;
	}
}
