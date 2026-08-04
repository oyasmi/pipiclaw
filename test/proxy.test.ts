import { createServer, type Server } from "node:http";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installLlmProxy } from "../src/runtime/proxy.js";

const ENV_KEYS = [
	"PIPICLAW_PROXY",
	"PIPICLAW_NO_PROXY",
	"HTTP_PROXY",
	"http_proxy",
	"HTTPS_PROXY",
	"https_proxy",
	"NO_PROXY",
	"no_proxy",
] as const;

const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
	(typeof ENV_KEYS)[number],
	string | undefined
>;

function clearProxyEnv(): void {
	for (const key of ENV_KEYS) delete process.env[key];
}

describe("installLlmProxy", () => {
	let originalDispatcher: ReturnType<typeof getGlobalDispatcher>;
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		clearProxyEnv();
		originalDispatcher = getGlobalDispatcher();
		// logWarning/logInfo (src/log.ts) both route through console.log with ANSI styling.
		warnSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			const value = originalEnv[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		setGlobalDispatcher(originalDispatcher);
		vi.restoreAllMocks();
	});

	it("does nothing when no proxy env var is set", () => {
		const result = installLlmProxy();
		expect(result).toEqual({ installed: false, source: "none" });
		expect(getGlobalDispatcher()).toBe(originalDispatcher);
	});

	it("installs a dispatcher from PIPICLAW_PROXY", () => {
		process.env.PIPICLAW_PROXY = "http://127.0.0.1:65535";
		const result = installLlmProxy();
		expect(result).toEqual({ installed: true, source: "PIPICLAW_PROXY" });
		expect(getGlobalDispatcher()).not.toBe(originalDispatcher);
	});

	it("installs a dispatcher from standard HTTPS_PROXY when PIPICLAW_PROXY is unset", () => {
		process.env.HTTPS_PROXY = "http://127.0.0.1:65535";
		const result = installLlmProxy();
		expect(result).toEqual({ installed: true, source: "env" });
		expect(getGlobalDispatcher()).not.toBe(originalDispatcher);
	});

	it("prefers PIPICLAW_PROXY over standard HTTPS_PROXY when both are set", () => {
		process.env.PIPICLAW_PROXY = "http://127.0.0.1:65535";
		process.env.HTTPS_PROXY = "http://127.0.0.1:65533";
		const result = installLlmProxy();
		expect(result.source).toBe("PIPICLAW_PROXY");
	});

	it("rejects a socks5 PIPICLAW_PROXY, warns, and stays direct", () => {
		process.env.PIPICLAW_PROXY = "socks5://127.0.0.1:1080";
		const result = installLlmProxy();
		expect(result).toEqual({ installed: false, source: "none" });
		expect(getGlobalDispatcher()).toBe(originalDispatcher);
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("unsupported protocol"));
	});

	it("rejects an unparseable PIPICLAW_PROXY, warns, and stays direct", () => {
		process.env.PIPICLAW_PROXY = "not-a-url";
		const result = installLlmProxy();
		expect(result).toEqual({ installed: false, source: "none" });
		expect(getGlobalDispatcher()).toBe(originalDispatcher);
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("not a valid URL"));
	});

	it("redacts proxy credentials from the log line", () => {
		process.env.PIPICLAW_PROXY = "http://user:hunter2@127.0.0.1:65535";
		installLlmProxy();
		const logged = warnSpy.mock.calls.map((call) => call.join(" ")).join("\n");
		expect(logged).not.toContain("hunter2");
	});
});

describe("installLlmProxy end-to-end routing", () => {
	let server: Server;
	let serverUrl: string;
	let receivedUrls: string[];
	let originalDispatcher: ReturnType<typeof getGlobalDispatcher>;

	beforeEach(async () => {
		clearProxyEnv();
		receivedUrls = [];
		server = createServer((req, res) => {
			receivedUrls.push(req.url ?? "");
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end("proxied-ok");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("expected an AddressInfo");
		serverUrl = `http://127.0.0.1:${address.port}`;
		originalDispatcher = getGlobalDispatcher();
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(async () => {
		for (const key of ENV_KEYS) {
			const value = originalEnv[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		setGlobalDispatcher(originalDispatcher);
		vi.restoreAllMocks();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	// The "target" is a loopback port nothing listens on (65533 is outside the
	// fetch spec's forbidden-port list, unlike e.g. port 1). That is fine for the
	// through-proxy case: an HTTP proxy request only opens a TCP connection to the
	// proxy itself and sends the absolute target URI in the request line, so the
	// target never needs to be reachable (our fake proxy never forwards). It also
	// keeps the no-proxy case DNS-free and fast: a direct connection attempt to an
	// unbound loopback port fails with an immediate ECONNREFUSED, unlike a fake
	// hostname, which would depend on real (and possibly sandbox-blocked, possibly
	// slow) DNS resolution.
	const unreachableTarget = "http://127.0.0.1:65533/";

	it("actually routes a plain-HTTP fetch through the configured proxy", async () => {
		process.env.PIPICLAW_PROXY = serverUrl;
		installLlmProxy();

		const response = await fetch(unreachableTarget);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("proxied-ok");
		// Confirms the byte stream actually reached the proxy (rather than merely
		// asserting the global dispatcher symbol changed).
		expect(receivedUrls).toEqual([unreachableTarget]);
	});

	it("bypasses the proxy for targets matched by PIPICLAW_NO_PROXY", async () => {
		process.env.PIPICLAW_PROXY = serverUrl;
		process.env.PIPICLAW_NO_PROXY = "127.0.0.1:65533";
		installLlmProxy();

		await expect(fetch(unreachableTarget)).rejects.toThrow();
		expect(receivedUrls).toEqual([]);
	});
});
