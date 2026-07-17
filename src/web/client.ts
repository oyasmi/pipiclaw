import { Buffer } from "node:buffer";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import axios from "axios";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { getProxyForUrl } from "proxy-from-env";
import { SocksProxyAgent } from "socks-proxy-agent";
import { logSecurityEvent } from "../security/logger.js";
import { NetworkGuardError, validateNetworkTarget, validateRedirectTarget } from "../security/network.js";
import type { SecurityConfig } from "../security/types.js";
import { errorMessage } from "../shared/text-utils.js";
import type { PipiclawWebToolsConfig } from "../tools/config.js";

export const WEB_USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Pipiclaw/0.5";

export interface WebRuntimeContext {
	webConfig: PipiclawWebToolsConfig;
	securityConfig: SecurityConfig;
	workspaceDir: string;
	channelId?: string;
}

export interface WebHttpResponse {
	status: number;
	finalUrl: string;
	headers: Record<string, string>;
	body: Buffer;
}

export interface WebHttpRequestOptions {
	method?: "GET" | "POST";
	url: string;
	headers?: Record<string, string>;
	params?: Record<string, string | number | boolean | undefined>;
	data?: unknown;
	timeoutMs: number;
	signal?: AbortSignal;
	maxRedirects?: number;
	maxResponseBytes?: number;
}

const agentCache = new Map<string, HttpAgent | HttpsAgent>();

function normalizeHeaders(headers: unknown): Record<string, string> {
	if (!headers || typeof headers !== "object") {
		return {};
	}
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (typeof value === "string") {
			result[key.toLowerCase()] = value;
		} else if (Array.isArray(value)) {
			result[key.toLowerCase()] = value.join(", ");
		} else if (value !== undefined && value !== null) {
			result[key.toLowerCase()] = String(value);
		}
	}
	return result;
}

function buildUrlWithParams(
	url: string,
	params: Record<string, string | number | boolean | undefined> | undefined,
): string {
	if (!params) {
		return url;
	}
	const resolved = new URL(url);
	for (const [key, value] of Object.entries(params)) {
		if (value === undefined) {
			continue;
		}
		resolved.searchParams.set(key, String(value));
	}
	return resolved.toString();
}

// Pin the exact IP that the network guard validated so the actual socket connects there,
// closing the DNS-rebinding TOCTOU where axios would otherwise re-resolve the hostname and
// could reach a private address the guard already vetted against. The hostname is still used
// for the Host header and TLS SNI/cert validation — only address resolution is overridden.
function pinnedLookup(address: string): LookupFunction {
	const family = isIP(address);
	return ((_hostname, options, callback) => {
		const cb = (typeof options === "function" ? options : callback) as (
			err: NodeJS.ErrnoException | null,
			address: string | { address: string; family: number }[],
			family?: number,
		) => void;
		const wantsAll = typeof options === "object" && options?.all === true;
		if (wantsAll) {
			cb(null, [{ address, family }]);
		} else {
			cb(null, address, family);
		}
	}) as LookupFunction;
}

function getProxyAgent(requestUrl: string, explicitProxy: string | null): HttpAgent | HttpsAgent | undefined {
	const proxyUrl = explicitProxy?.trim() || getProxyForUrl(requestUrl);
	if (!proxyUrl) {
		return undefined;
	}

	const requestProtocol = new URL(requestUrl).protocol;
	const proxyProtocol = new URL(proxyUrl).protocol;
	const cacheKey = `${requestProtocol}|${proxyUrl}`;
	const cached = agentCache.get(cacheKey);
	if (cached) {
		return cached;
	}

	let agent: HttpAgent | HttpsAgent;
	if (proxyProtocol.startsWith("socks")) {
		agent = new SocksProxyAgent(proxyUrl);
	} else if (requestProtocol === "https:") {
		agent = new HttpsProxyAgent(proxyUrl);
	} else {
		agent = new HttpProxyAgent(proxyUrl);
	}
	agentCache.set(cacheKey, agent);
	return agent;
}

async function logBlockedRequest(context: WebRuntimeContext, error: NetworkGuardError): Promise<void> {
	await logSecurityEvent(context.workspaceDir, context.securityConfig, {
		type: "network",
		tool: "web",
		channelId: context.channelId,
		url: error.url,
		stage: error.stage,
		resolvedHost: error.resolvedHost,
		resolvedAddress: error.resolvedAddress,
		category: error.category,
		reason: error.message,
	});
}

function decodeBody(body: Buffer): string {
	return new TextDecoder("utf-8", { fatal: false }).decode(body);
}

function isRedirectStatus(status: number): boolean {
	return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

export class WebHttpClient {
	private readonly context: WebRuntimeContext;

	constructor(context: WebRuntimeContext) {
		this.context = context;
	}

	async request(options: WebHttpRequestOptions): Promise<WebHttpResponse> {
		const maxRedirects = options.maxRedirects ?? this.context.securityConfig.networkGuard.maxRedirects;
		let currentUrl = buildUrlWithParams(options.url, options.params);
		let method = options.method ?? "GET";
		let data = options.data;

		for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
			let validatedAddress: string | undefined;
			try {
				const validated =
					redirectCount === 0
						? await validateNetworkTarget(currentUrl, { config: this.context.securityConfig })
						: await validateRedirectTarget(currentUrl, { config: this.context.securityConfig });
				validatedAddress = validated.resolvedAddress;
			} catch (error) {
				if (error instanceof NetworkGuardError) {
					await logBlockedRequest(this.context, error);
				}
				throw error;
			}

			const proxyAgent = getProxyAgent(currentUrl, this.context.webConfig.proxy);
			// Without a proxy, pin the socket to the guard-validated IP. With a proxy, the proxy
			// resolves DNS itself, so client-side pinning does not apply.
			const isHttps = new URL(currentUrl).protocol === "https:";
			let httpAgent = proxyAgent;
			let httpsAgent = proxyAgent;
			if (!proxyAgent && validatedAddress) {
				const pinned = isHttps
					? new HttpsAgent({ lookup: pinnedLookup(validatedAddress) })
					: new HttpAgent({ lookup: pinnedLookup(validatedAddress) });
				if (isHttps) {
					httpsAgent = pinned;
				} else {
					httpAgent = pinned;
				}
			}
			let response: Awaited<ReturnType<typeof axios.request<ArrayBuffer>>>;
			try {
				response = await axios.request<ArrayBuffer>({
					method,
					url: currentUrl,
					data,
					headers: {
						"User-Agent": WEB_USER_AGENT,
						Accept: "*/*",
						...options.headers,
					},
					responseType: "arraybuffer",
					validateStatus: () => true,
					timeout: options.timeoutMs,
					signal: options.signal,
					maxRedirects: 0,
					maxContentLength: options.maxResponseBytes ?? Number.POSITIVE_INFINITY,
					proxy: false,
					httpAgent,
					httpsAgent,
				});
			} catch (error) {
				if (
					options.maxResponseBytes &&
					typeof (error as { message?: unknown })?.message === "string" &&
					(error as { message: string }).message.includes("maxContentLength")
				) {
					throw new Error(`Response exceeds maxResponseBytes (${options.maxResponseBytes} bytes)`);
				}
				throw error;
			}
			const headers = normalizeHeaders(response.headers);
			const body = Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data);

			if (isRedirectStatus(response.status) && headers.location) {
				if (redirectCount === maxRedirects) {
					throw new Error(`Too many redirects while fetching ${options.url}`);
				}
				currentUrl = new URL(headers.location, currentUrl).toString();
				if (
					response.status === 303 ||
					((response.status === 301 || response.status === 302) && method === "POST")
				) {
					method = "GET";
					data = undefined;
				}
				continue;
			}

			return {
				status: response.status,
				finalUrl: currentUrl,
				headers,
				body,
			};
		}

		throw new Error(`Too many redirects while fetching ${options.url}`);
	}

	async requestJson<T>(options: WebHttpRequestOptions): Promise<{ response: WebHttpResponse; data: T }> {
		const response = await this.request({
			...options,
			headers: {
				Accept: "application/json",
				...options.headers,
			},
		});
		const text = decodeBody(response.body);
		try {
			return {
				response,
				data: JSON.parse(text) as T,
			};
		} catch (error) {
			throw new Error(`Expected JSON response from ${options.url}, got invalid JSON: ${errorMessage(error)}`);
		}
	}

	async requestText(options: WebHttpRequestOptions): Promise<{ response: WebHttpResponse; text: string }> {
		const response = await this.request(options);
		return {
			response,
			text: decodeBody(response.body),
		};
	}
}

export function createWebHttpClient(context: WebRuntimeContext): WebHttpClient {
	return new WebHttpClient(context);
}
