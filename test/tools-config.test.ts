import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_TOOLS_CONFIG, loadToolsConfig, loadToolsConfigWithDiagnostics } from "../src/tools/config.js";

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
				memory: DEFAULT_TOOLS_CONFIG.tools.memory,
				skills: DEFAULT_TOOLS_CONFIG.tools.skills,
				events: DEFAULT_TOOLS_CONFIG.tools.events,
				tasks: DEFAULT_TOOLS_CONFIG.tools.tasks,
				grep: DEFAULT_TOOLS_CONFIG.tools.grep,
				jobs: DEFAULT_TOOLS_CONFIG.tools.jobs,
				bashInterceptor: DEFAULT_TOOLS_CONFIG.tools.bashInterceptor,
				rtk: DEFAULT_TOOLS_CONFIG.tools.rtk,
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

	it("defaults the jobs and bashInterceptor gates to on (explicit values, not circular self-compare)", () => {
		const appHomeDir = mkdtempSync(join(tmpdir(), "pipiclaw-tools-config-"));
		tempDirs.push(appHomeDir);

		const loaded = loadToolsConfig(appHomeDir);
		expect(loaded.tools.jobs.enabled).toBe(true);
		expect(loaded.tools.bashInterceptor.enabled).toBe(true);

		// An explicit opt-out is still honored.
		writeFileSync(
			join(appHomeDir, "tools.json"),
			JSON.stringify({ tools: { jobs: { enabled: false }, bashInterceptor: { enabled: false } } }),
			"utf-8",
		);
		const off = loadToolsConfig(appHomeDir);
		expect(off.tools.jobs.enabled).toBe(false);
		expect(off.tools.bashInterceptor.enabled).toBe(false);
	});

	it("defaults tools.rtk.enabled to false and honors an explicit opt-in", () => {
		const appHomeDir = mkdtempSync(join(tmpdir(), "pipiclaw-tools-config-"));
		tempDirs.push(appHomeDir);

		expect(loadToolsConfig(appHomeDir).tools.rtk.enabled).toBe(false);

		writeFileSync(join(appHomeDir, "tools.json"), JSON.stringify({ tools: { rtk: { enabled: true } } }), "utf-8");
		expect(loadToolsConfig(appHomeDir).tools.rtk.enabled).toBe(true);

		writeFileSync(join(appHomeDir, "tools.json"), JSON.stringify({ tools: { rtk: { enabled: "yes" } } }), "utf-8");
		expect(loadToolsConfig(appHomeDir).tools.rtk.enabled).toBe(false);
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

	it("reports diagnostics for invalid json and invalid fields", () => {
		const appHomeDir = mkdtempSync(join(tmpdir(), "pipiclaw-tools-config-"));
		tempDirs.push(appHomeDir);
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
