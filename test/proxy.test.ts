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
	let server: Server;
	let serverUrl: string;
	let receivedUrls: string[];

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

	it("does nothing when no proxy env var is set", () => {
		const result = installLlmProxy();
		expect(result).toEqual({ installed: false, source: "none" });
		expect(getGlobalDispatcher()).toBe(originalDispatcher);
	});

	// The "target" is a loopback port nothing listens on (65533 is outside the
	// fetch spec's forbidden-port list, unlike e.g. port 1). That is fine for a
	// through-proxy request: an HTTP proxy request only opens a TCP connection to
	// the proxy itself and sends the absolute target URI in the request line, so
	// the target never needs to be reachable.
	const unreachableTarget = "http://127.0.0.1:65533/";

	it("actually routes a plain-HTTP fetch through PIPICLAW_PROXY", async () => {
		process.env.PIPICLAW_PROXY = serverUrl;
		installLlmProxy();

		const response = await fetch(unreachableTarget);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("proxied-ok");
		// Confirms the byte stream actually reached the proxy (rather than merely
		// asserting the global dispatcher symbol changed).
		expect(receivedUrls).toEqual([unreachableTarget]);
	});
});
