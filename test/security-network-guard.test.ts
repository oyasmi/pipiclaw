import { beforeEach, describe, expect, it, vi } from "vitest";

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));

import { DEFAULT_SECURITY_CONFIG } from "../src/security/config.js";
import { NetworkGuardError, validateNetworkTarget, validateRedirectTarget } from "../src/security/network.js";
import type { SecurityConfig } from "../src/security/types.js";

// This is the SSRF guard: it decides whether a web_fetch/web_search request (or
// a redirect it follows) is allowed to reach a given host. Related variants are
// asserted in loops inside single cases so the suite reports one case per rule
// while still covering every range below.
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

	it("allows public IP literals (v4 and v6) without a DNS lookup", async () => {
		const v4 = await validateNetworkTarget("https://93.184.216.34/path", context());
		expect(v4.resolvedAddress).toBe("93.184.216.34");
		const v6 = await validateNetworkTarget("http://[2001:4860:4860::8888]/", context());
		expect(v6.resolvedAddress).toBe("2001:4860:4860::8888");
		expect(lookupMock).not.toHaveBeenCalled();
	});

	it("blocks every private IPv4 range", async () => {
		for (const ip of ["127.0.0.1", "0.5.5.5", "169.254.1.1", "10.1.2.3", "172.20.0.5", "192.168.1.1", "100.64.0.1", "198.18.0.1"]) {
			await expect(validateNetworkTarget(`http://${ip}/`, context())).rejects.toMatchObject({
				category: "private-address",
			});
		}
	});

	it("blocks the private IPv6 ranges (loopback, unique-local, link-local)", async () => {
		for (const ip of ["::1", "fc00::1", "fe80::1"]) {
			await expect(validateNetworkTarget(`http://[${ip}]/`, context())).rejects.toMatchObject({
				category: "private-address",
			});
		}
	});

	it("blocks named cloud-metadata and localhost hosts by exact match, ahead of any DNS branch", async () => {
		for (const host of ["localhost", "sub.localhost", "metadata.google.internal", "metadata", "169.254.169.254"]) {
			await expect(validateNetworkTarget(`http://${host}/`, context())).rejects.toMatchObject({
				category: "blocked-host",
			});
		}
	});

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

	it("allowedHosts bypasses the guard without DNS, and allowedCidrs permits otherwise-private addresses", async () => {
		lookupMock.mockResolvedValue([{ address: "10.1.2.3", family: 4 }]);

		const allowed = await validateNetworkTarget(
			"https://internal.example.com/",
			context({ allowedHosts: ["internal.example.com"] }),
		);
		expect(allowed.hostname).toBe("internal.example.com");

		const cidrResolved = await validateNetworkTarget(
			"https://internal.example.com/",
			context({ allowedCidrs: ["10.0.0.0/8"] }),
		);
		expect(cidrResolved.resolvedAddress).toBe("10.1.2.3");

		const cidrLiteral = await validateNetworkTarget("http://10.1.2.3/", context({ allowedCidrs: ["10.0.0.0/8"] }));
		expect(cidrLiteral.resolvedAddress).toBe("10.1.2.3");
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

	it("rejects invalid URLs and non-http(s) schemes with a typed NetworkGuardError", async () => {
		await expect(validateNetworkTarget("not a url", context())).rejects.toMatchObject({ category: "invalid-url" });
		await expect(validateNetworkTarget("ftp://example.com/", context())).rejects.toMatchObject({
			category: "unsupported-scheme",
		});
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

	it("applies the same guard logic to redirects but tags the error stage as redirect", async () => {
		try {
			await validateRedirectTarget("http://127.0.0.1/secret", context());
			expect.unreachable("expected validateRedirectTarget to reject");
		} catch (error) {
			expect((error as InstanceType<typeof NetworkGuardError>).stage).toBe("redirect");
			expect((error as InstanceType<typeof NetworkGuardError>).category).toBe("private-address");
		}
		const result = await validateRedirectTarget("https://93.184.216.34/next", context());
		expect(result.resolvedAddress).toBe("93.184.216.34");
	});
});
