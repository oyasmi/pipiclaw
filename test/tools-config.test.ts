import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_TOOLS_CONFIG, loadToolsConfig } from "../src/tools/config.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("tools config", () => {
	it("returns defaults when tools.json is missing", () => {
		const appHomeDir = mkdtempSync(join(tmpdir(), "pipiclaw-tools-config-"));
		tempDirs.push(appHomeDir);

		expect(loadToolsConfig(appHomeDir)).toEqual(DEFAULT_TOOLS_CONFIG);
	});

	it("merges tools.web overrides", () => {
		const appHomeDir = mkdtempSync(join(tmpdir(), "pipiclaw-tools-config-"));
		tempDirs.push(appHomeDir);
		writeFileSync(
			join(appHomeDir, "tools.json"),
			JSON.stringify({
				tools: {
					web: {
						enable: false,
						proxy: "http://127.0.0.1:7890",
						search: {
							provider: "searxng",
							baseUrl: "https://searx.example",
							maxResults: 9,
						},
						fetch: {
							maxChars: 1200,
							defaultExtractMode: "text",
						},
					},
				},
			}),
			"utf-8",
		);

		expect(loadToolsConfig(appHomeDir)).toEqual({
			tools: {
				web: {
					...DEFAULT_TOOLS_CONFIG.tools.web,
					enable: false,
					proxy: "http://127.0.0.1:7890",
					search: {
						...DEFAULT_TOOLS_CONFIG.tools.web.search,
						provider: "searxng",
						baseUrl: "https://searx.example",
						maxResults: 9,
					},
					fetch: {
						...DEFAULT_TOOLS_CONFIG.tools.web.fetch,
						maxChars: 1200,
						defaultExtractMode: "text",
					},
				},
			},
		});
	});

	it("falls back to defaults for invalid values", () => {
		const appHomeDir = mkdtempSync(join(tmpdir(), "pipiclaw-tools-config-"));
		tempDirs.push(appHomeDir);
		writeFileSync(
			join(appHomeDir, "tools.json"),
			JSON.stringify({
				tools: {
					web: {
						search: {
							provider: "invalid",
							maxResults: 99,
						},
						fetch: {
							maxChars: 10,
							defaultExtractMode: "html",
						},
					},
				},
			}),
			"utf-8",
		);

		expect(loadToolsConfig(appHomeDir)).toEqual(DEFAULT_TOOLS_CONFIG);
	});
});
