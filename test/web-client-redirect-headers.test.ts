import { beforeEach, describe, expect, it, vi } from "vitest";

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));

vi.mock("axios", () => ({
	default: {
		request: requestMock,
	},
}));

import { DEFAULT_SECURITY_CONFIG } from "../src/security/config.js";
import { DEFAULT_TOOLS_CONFIG } from "../src/tools/config.js";
import { createWebHttpClient } from "../src/web/client.js";

// R5: a manually-followed redirect (maxRedirects: 0 on the underlying axios call, so this loop's
// header decision is the only one made) must not carry a caller's credential headers — a
// provider's Authorization or X-Subscription-Token key, in the real callers' case — across an
// origin change. Public IP literals are used throughout so the network guard never needs DNS.
describe("WebHttpClient redirect header scoping", () => {
	const context = {
		webConfig: DEFAULT_TOOLS_CONFIG.tools.web,
		securityConfig: DEFAULT_SECURITY_CONFIG,
		workspaceDir: "/workspace",
	};

	beforeEach(() => {
		requestMock.mockReset();
	});

	it("keeps caller headers across a same-origin redirect", async () => {
		requestMock
			.mockResolvedValueOnce({
				status: 302,
				headers: { location: "https://93.184.216.34/next" },
				data: Buffer.alloc(0),
			})
			.mockResolvedValueOnce({ status: 200, headers: {}, data: Buffer.from("ok") });

		const client = createWebHttpClient(context);
		await client.request({
			url: "https://93.184.216.34/start",
			headers: { Authorization: "Bearer secret-token" },
			timeoutMs: 5000,
		});

		expect(requestMock).toHaveBeenCalledTimes(2);
		expect(requestMock.mock.calls[1]?.[0]?.headers?.Authorization).toBe("Bearer secret-token");
	});

	it("strips caller headers across a cross-origin redirect", async () => {
		requestMock
			.mockResolvedValueOnce({
				status: 302,
				headers: { location: "https://203.0.113.20/next" },
				data: Buffer.alloc(0),
			})
			.mockResolvedValueOnce({ status: 200, headers: {}, data: Buffer.from("ok") });

		const client = createWebHttpClient(context);
		await client.request({
			url: "https://93.184.216.34/start",
			headers: { Authorization: "Bearer secret-token", "X-Subscription-Token": "provider-key" },
			timeoutMs: 5000,
		});

		expect(requestMock).toHaveBeenCalledTimes(2);
		const secondCallHeaders = requestMock.mock.calls[1]?.[0]?.headers;
		expect(secondCallHeaders?.Authorization).toBeUndefined();
		expect(secondCallHeaders?.["X-Subscription-Token"]).toBeUndefined();
		// The hardcoded defaults still go out — only the caller-supplied headers are scoped.
		expect(secondCallHeaders?.["User-Agent"]).toBeTruthy();
	});

	it("restores caller headers if a redirect chain returns to the original origin", async () => {
		requestMock
			.mockResolvedValueOnce({
				status: 302,
				headers: { location: "https://203.0.113.20/away" },
				data: Buffer.alloc(0),
			})
			.mockResolvedValueOnce({
				status: 302,
				headers: { location: "https://93.184.216.34/back" },
				data: Buffer.alloc(0),
			})
			.mockResolvedValueOnce({ status: 200, headers: {}, data: Buffer.from("ok") });

		const client = createWebHttpClient(context);
		await client.request({
			url: "https://93.184.216.34/start",
			headers: { Authorization: "Bearer secret-token" },
			timeoutMs: 5000,
		});

		expect(requestMock).toHaveBeenCalledTimes(3);
		expect(requestMock.mock.calls[1]?.[0]?.headers?.Authorization).toBeUndefined();
		expect(requestMock.mock.calls[2]?.[0]?.headers?.Authorization).toBe("Bearer secret-token");
	});
});
