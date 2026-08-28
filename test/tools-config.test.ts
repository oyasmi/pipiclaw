import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_TOOLS_CONFIG, loadToolsConfig, loadToolsConfigWithDiagnostics } from "../src/tools/config.js";
import { useTempDirs } from "./helpers/fixtures.js";

const makeTempDir = useTempDirs("pipiclaw-tools-config-");

describe("tools config", () => {
	it("merges tools.web overrides", () => {
		const appHomeDir = makeTempDir();
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
				tasks: DEFAULT_TOOLS_CONFIG.tools.tasks,
				bashInterceptor: DEFAULT_TOOLS_CONFIG.tools.bashInterceptor,
				rtk: DEFAULT_TOOLS_CONFIG.tools.rtk,
				subagentInline: DEFAULT_TOOLS_CONFIG.tools.subagentInline,
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

	it("reports diagnostics for invalid json and invalid fields", () => {
		const appHomeDir = makeTempDir();
		writeFileSync(
			join(appHomeDir, "tools.json"),
			JSON.stringify({
				tools: {
					web: {
						proxy: 42,
						search: {
							provider: "invalid",
							maxResults: 99,
						},
					},
				},
			}),
			"utf-8",
		);

		const loaded = loadToolsConfigWithDiagnostics(appHomeDir);
		expect(loaded.config).toEqual(DEFAULT_TOOLS_CONFIG);
		expect(loaded.diagnostics.map((item) => item.message)).toEqual(
			expect.arrayContaining([
				expect.stringContaining("tools.web.proxy: expected a string or null"),
				expect.stringContaining('tools.web.search.provider: unknown provider "invalid"'),
				expect.stringContaining("tools.web.search.maxResults: expected an integer between 1 and 10"),
			]),
		);

		writeFileSync(join(appHomeDir, "tools.json"), "{", "utf-8");
		const invalidJson = loadToolsConfigWithDiagnostics(appHomeDir);
		expect(invalidJson.config).toEqual(DEFAULT_TOOLS_CONFIG);
		expect(invalidJson.diagnostics[0]?.severity).toBe("error");
	});
});
