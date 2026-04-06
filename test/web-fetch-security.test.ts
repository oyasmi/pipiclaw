import { beforeEach, describe, expect, it, vi } from "vitest";

const { requestMock, lookupMock } = vi.hoisted(() => ({
	requestMock: vi.fn(),
	lookupMock: vi.fn(),
}));

vi.mock("axios", () => ({
	default: {
		request: requestMock,
	},
}));

vi.mock("node:dns/promises", () => ({
	lookup: lookupMock,
}));

import { DEFAULT_SECURITY_CONFIG } from "../src/security/config.js";
import { DEFAULT_TOOLS_CONFIG } from "../src/tools/config.js";
import { runWebFetch } from "../src/web/fetch.js";

const context = {
	webConfig: DEFAULT_TOOLS_CONFIG.tools.web,
	securityConfig: DEFAULT_SECURITY_CONFIG,
	workspaceDir: "/workspace",
	channelId: "dm_test",
};

describe("web fetch security", () => {
	beforeEach(() => {
		requestMock.mockReset();
		lookupMock.mockReset();
	});

	it("blocks private resolved addresses", async () => {
		lookupMock.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);

		await expect(
			runWebFetch(context, {
				url: "https://metadata.example/internal",
				extractMode: "text",
				maxChars: 5000,
				maxImageBytes: context.webConfig.fetch.maxImageBytes,
				preferJina: false,
				enableJinaFallback: false,
			}),
		).rejects.toThrow(/private network address/i);
		expect(requestMock).not.toHaveBeenCalled();
	});

	it("blocks localhost before making a request", async () => {
		await expect(
			runWebFetch(context, {
				url: "http://localhost/admin",
				extractMode: "text",
				maxChars: 5000,
				maxImageBytes: context.webConfig.fetch.maxImageBytes,
				preferJina: false,
				enableJinaFallback: false,
			}),
		).rejects.toThrow(/blocked host/i);
		expect(requestMock).not.toHaveBeenCalled();
	});

	it("blocks redirects to private targets", async () => {
		lookupMock
			.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
			.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
		requestMock.mockResolvedValueOnce({
			status: 302,
			headers: { location: "http://127.0.0.1/secret" },
			data: Buffer.alloc(0),
		});

		await expect(
			runWebFetch(context, {
				url: "https://example.com/redirect",
				extractMode: "text",
				maxChars: 5000,
				maxImageBytes: context.webConfig.fetch.maxImageBytes,
				preferJina: false,
				enableJinaFallback: false,
			}),
		).rejects.toThrow(/private network address|blocked host/i);
	});
});
