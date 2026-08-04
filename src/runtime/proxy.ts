import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import * as log from "../log.js";

/**
 * Node's built-in `fetch` (undici under the hood) ignores `*_PROXY` env vars entirely —
 * only a global dispatcher makes it respect a proxy. This is the sole viable injection
 * point for LLM traffic: the Anthropic/OpenAI/Mistral SDKs default to `globalThis.fetch`,
 * and pi-ai's Google adapters throw if handed a custom `fetch` (see google-generative-ai.js),
 * so per-call fetch injection cannot cover every provider. A global dispatcher also
 * transparently covers OAuth token refresh and model-catalog calls this module never sees.
 *
 * axios (DingTalk's HTTP client) and `ws` (its stream connection) are unaffected — axios
 * reads `HTTP(S)_PROXY` itself via a separate code path, and `ws` reads nothing. That is
 * why `PIPICLAW_PROXY` exists as a distinct variable: it lets an operator route only LLM
 * traffic through a proxy without also pulling DingTalk's HTTP calls through it while its
 * ws connection stays direct (a split that is easy to get into by accident with the
 * standard `HTTPS_PROXY` var, since axios and undici don't agree on what it should mean
 * beyond "proxy this http-ish traffic").
 */

export type ProxyInstallSource = "PIPICLAW_PROXY" | "env" | "none";

export interface ProxyInstallResult {
	installed: boolean;
	source: ProxyInstallSource;
}

const SUPPORTED_PROXY_PROTOCOLS = new Set(["http:", "https:"]);

/** Redact credentials from a proxy URL before it ever reaches a log line. */
function redactProxyUrl(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return "[unparseable]";
	}
	if (url.username || url.password) {
		url.username = "***";
		url.password = "";
	}
	return url.toString();
}

function hasStandardProxyEnv(): boolean {
	return Boolean(
		process.env.http_proxy || process.env.HTTP_PROXY || process.env.https_proxy || process.env.HTTPS_PROXY,
	);
}

/**
 * Install a global undici dispatcher that routes outbound `fetch` traffic (LLM API calls,
 * OAuth refresh, model catalog lookups) through an HTTP/HTTPS proxy, if one is configured.
 *
 * Precedence: `PIPICLAW_PROXY` (+ optional `PIPICLAW_NO_PROXY`) wins outright. Otherwise,
 * standard `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` (any case) are honored as-is — matching
 * what axios and the rest of the process already do, so LLM traffic just joins the same
 * behavior instead of being a silent exception to it.
 *
 * Deliberately does nothing when no proxy env var is set at all, rather than always
 * installing an `EnvHttpProxyAgent`: that keeps the default (no proxy configured) path
 * running on undici's plain `Agent` instead of swapping in different connection-pooling
 * behavior for every install, most of which never proxy anything.
 */
export function installLlmProxy(): ProxyInstallResult {
	const explicitProxy = process.env.PIPICLAW_PROXY?.trim();
	if (explicitProxy) {
		let parsed: URL;
		try {
			parsed = new URL(explicitProxy);
		} catch {
			log.logWarning("PIPICLAW_PROXY is not a valid URL; LLM requests will connect directly", explicitProxy);
			return { installed: false, source: "none" };
		}
		if (!SUPPORTED_PROXY_PROTOCOLS.has(parsed.protocol)) {
			log.logWarning(
				`PIPICLAW_PROXY uses unsupported protocol "${parsed.protocol}" (only http:// and https:// proxy URLs are supported, no SOCKS); LLM requests will connect directly`,
				explicitProxy,
			);
			return { installed: false, source: "none" };
		}

		const noProxy = process.env.PIPICLAW_NO_PROXY?.trim();
		setGlobalDispatcher(
			new EnvHttpProxyAgent({
				httpProxy: explicitProxy,
				httpsProxy: explicitProxy,
				// Falling through to undefined (rather than "") lets EnvHttpProxyAgent fall
				// back to reading the standard NO_PROXY/no_proxy env var on its own.
				noProxy: noProxy || undefined,
			}),
		);
		log.logInfo(`LLM requests routed through proxy from PIPICLAW_PROXY (${redactProxyUrl(explicitProxy)})`);
		return { installed: true, source: "PIPICLAW_PROXY" };
	}

	if (hasStandardProxyEnv()) {
		setGlobalDispatcher(new EnvHttpProxyAgent());
		log.logInfo(
			"LLM requests routed through proxy from HTTP(S)_PROXY (note: this also routes DingTalk's HTTP API calls, though not its websocket connection)",
		);
		return { installed: true, source: "env" };
	}

	return { installed: false, source: "none" };
}
