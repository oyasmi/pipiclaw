import { beforeEach, describe, expect, it, vi } from "vitest";

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));

import { DEFAULT_SECURITY_CONFIG } from "../src/security/config.js";
import { NetworkGuardError, validateNetworkTarget, validateRedirectTarget } from "../src/security/network.js";
import type { SecurityConfig } from "../src/security/types.js";

// This is the SSRF guard: it decides whether a web_fetch/web_search request (or
// a redirect it follows) is allowed to reach a given host. It's exercised
// indirectly by web-fetch-security.test.ts through three integration scenarios,
// but that leaves its actual decision surface mostly untested: every IPv6
// private range, most of the IPv4 CIDR list, the allowlist bypasses, and the
// disabled/invalid-input paths. A guard this security-relevant deserves direct,
// exhaustive unit coverage of its own decision logic.
function context(overrides: Partial<SecurityConfig["networkGuard"]> = {}) {
	return {
		config: {
			...DEFAULT_SECURITY_CONFIG,
			networkGuard: { ...DEFAULT_SECURITY_CONFIG.networkGuard, enabled: true, ...overrides },
		},
	};
}

describe("validateNetworkTarget", () => {
	beforeEach(() => {
		lookupMock.mockReset();
	});

	it("allows a public IP literal without a DNS lookup", async () => {
		const result = await validateNetworkTarget("https://93.184.216.34/path", context());
		expect(result.resolvedAddress).toBe("93.184.216.34");
		expect(lookupMock).not.toHaveBeenCalled();
	});

	it.each([
		["loopback", "127.0.0.1"],
		["this-network", "0.5.5.5"],
		["link-local", "169.254.1.1"],
		["private-10", "10.1.2.3"],
		["private-172", "172.20.0.5"],
		["private-192", "192.168.1.1"],
		["cgnat", "100.64.0.1"],
		["benchmark", "198.18.0.1"],
	])("blocks the private IPv4 range %s (%s)", async (_name, ip) => {
		await expect(validateNetworkTarget(`http://${ip}/`, context())).rejects.toMatchObject({
			category: "private-address",
		});
	});

	it.each([
		["loopback", "::1"],
		["unique-local", "fc00::1"],
		["link-local", "fe80::1"],
	])("blocks the private IPv6 range %s (%s)", async (_name, ip) => {
		await expect(validateNetworkTarget(`http://[${ip}]/`, context())).rejects.toMatchObject({
			category: "private-address",
		});
	});

	it("allows a public IPv6 literal", async () => {
		const result = await validateNetworkTarget("http://[2001:4860:4860::8888]/", context());
		expect(result.resolvedAddress).toBe("2001:4860:4860::8888");
	});

	it.each(["localhost", "sub.localhost", "metadata.google.internal", "metadata", "169.254.169.254"])(
		// The AWS/GCP metadata IP is blocked by exact literal match in BLOCKED_HOSTS,
		// ahead of (and regardless of) the IP/private-address branch below it.
		"blocks the named host %s",
		async (host) => {
			await expect(validateNetworkTarget(`http://${host}/`, context())).rejects.toMatchObject({
				category: "blocked-host",
			});
		},
	);

	it("resolves a hostname via DNS and blocks it if it resolves to a private address", async () => {
		lookupMock.mockResolvedValueOnce([{ address: "10.0.0.5", family: 4 }]);
		await expect(validateNetworkTarget("https://internal.example.com/", context())).rejects.toMatchObject({
			category: "private-address",
			resolvedHost: "internal.example.com",
			resolvedAddress: "10.0.0.5",
		});
	});

	it("allows a hostname that resolves to a public address", async () => {
		lookupMock.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]);
		const result = await validateNetworkTarget("https://example.com/", context());
		expect(result.resolvedAddress).toBe("93.184.216.34");
	});

	it("rejects when DNS resolution fails", async () => {
		lookupMock.mockRejectedValueOnce(new Error("ENOTFOUND"));
		await expect(validateNetworkTarget("https://does-not-exist.example/", context())).rejects.toMatchObject({
			category: "dns-failure",
		});
	});

	it("allowedHosts bypasses the guard even for an otherwise-blocked host", async () => {
		lookupMock.mockResolvedValueOnce([{ address: "10.0.0.5", family: 4 }]);
		const result = await validateNetworkTarget(
			"https://internal.example.com/",
			context({ allowedHosts: ["internal.example.com"] }),
		);
		expect(result.hostname).toBe("internal.example.com");
		expect(lookupMock).not.toHaveBeenCalled();
	});

	it("allowedCidrs permits an otherwise-private resolved address", async () => {
		lookupMock.mockResolvedValueOnce([{ address: "10.1.2.3", family: 4 }]);
		const result = await validateNetworkTarget(
			"https://internal.example.com/",
			context({ allowedCidrs: ["10.0.0.0/8"] }),
		);
		expect(result.resolvedAddress).toBe("10.1.2.3");
	});

	it("allowedCidrs permits a private IP literal directly", async () => {
		const result = await validateNetworkTarget("http://10.1.2.3/", context({ allowedCidrs: ["10.0.0.0/8"] }));
		expect(result.resolvedAddress).toBe("10.1.2.3");
		expect(lookupMock).not.toHaveBeenCalled();
	});

	it("does nothing (allows everything, no DNS lookup) when the guard is disabled", async () => {
		const result = await validateNetworkTarget("http://127.0.0.1/admin", {
			config: {
				...DEFAULT_SECURITY_CONFIG,
				networkGuard: { ...DEFAULT_SECURITY_CONFIG.networkGuard, enabled: false },
			},
		});
		expect(result.hostname).toBe("127.0.0.1");
		expect(lookupMock).not.toHaveBeenCalled();
	});

	it("rejects an invalid URL", async () => {
		await expect(validateNetworkTarget("not a url", context())).rejects.toMatchObject({ category: "invalid-url" });
	});

	it("rejects a non-http(s) scheme", async () => {
		await expect(validateNetworkTarget("ftp://example.com/", context())).rejects.toMatchObject({
			category: "unsupported-scheme",
		});
	});

	it("throws NetworkGuardError instances with url/stage on the error object", async () => {
		try {
			await validateNetworkTarget("http://127.0.0.1/", context());
			expect.unreachable("expected validateNetworkTarget to reject");
		} catch (error) {
			expect(error).toBeInstanceOf(NetworkGuardError);
			expect((error as InstanceType<typeof NetworkGuardError>).stage).toBe("request");
			expect((error as InstanceType<typeof NetworkGuardError>).url).toBe("http://127.0.0.1/");
		}
	});
});

describe("validateRedirectTarget", () => {
	beforeEach(() => {
		lookupMock.mockReset();
	});

	it("applies the same guard logic but tags the error stage as redirect", async () => {
		try {
			await validateRedirectTarget("http://127.0.0.1/secret", context());
			expect.unreachable("expected validateRedirectTarget to reject");
		} catch (error) {
			expect((error as InstanceType<typeof NetworkGuardError>).stage).toBe("redirect");
			expect((error as InstanceType<typeof NetworkGuardError>).category).toBe("private-address");
		}
	});

	it("allows a public redirect target", async () => {
		const result = await validateRedirectTarget("https://93.184.216.34/next", context());
		expect(result.resolvedAddress).toBe("93.184.216.34");
	});
});
