import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_SECURITY_CONFIG,
	loadSecurityConfig,
	loadSecurityConfigWithDiagnostics,
} from "../src/security/config.js";
import { useTempDirs } from "./helpers/fixtures.js";

const makeTempDir = useTempDirs("pipiclaw-security-config-");

describe("security config", () => {
	it("returns defaults when no app-home config exists", () => {
		const appHomeDir = makeTempDir();
		expect(loadSecurityConfig(appHomeDir)).toEqual(DEFAULT_SECURITY_CONFIG);
	});

	it("merges app-home overrides with defaults", () => {
		const appHomeDir = makeTempDir();
		writeFileSync(
			join(appHomeDir, "security.json"),
			JSON.stringify({
				commandGuard: { allowPatterns: ["sudo apt install"] },
				pathGuard: { writeAllow: ["~/notes/"] },
				networkGuard: { allowedHosts: ["example.com"], maxRedirects: 7 },
				audit: { logBlocked: false },
			}),
			"utf-8",
		);

		expect(loadSecurityConfig(appHomeDir)).toEqual({
			...DEFAULT_SECURITY_CONFIG,
			commandGuard: {
				...DEFAULT_SECURITY_CONFIG.commandGuard,
				allowPatterns: ["sudo apt install"],
			},
			pathGuard: {
				...DEFAULT_SECURITY_CONFIG.pathGuard,
				writeAllow: ["~/notes/"],
			},
			networkGuard: {
				...DEFAULT_SECURITY_CONFIG.networkGuard,
				allowedHosts: ["example.com"],
				maxRedirects: 7,
			},
			audit: {
				...DEFAULT_SECURITY_CONFIG.audit,
				logBlocked: false,
			},
		});
	});

	it("loads generated local security config with network guard disabled", () => {
		const appHomeDir = makeTempDir();
		writeFileSync(
			join(appHomeDir, "security.json"),
			JSON.stringify({
				pathGuard: { enabled: true },
				commandGuard: { enabled: true },
				networkGuard: { enabled: false },
			}),
			"utf-8",
		);

		expect(loadSecurityConfig(appHomeDir)).toEqual({
			...DEFAULT_SECURITY_CONFIG,
			pathGuard: {
				...DEFAULT_SECURITY_CONFIG.pathGuard,
				enabled: true,
			},
			commandGuard: {
				...DEFAULT_SECURITY_CONFIG.commandGuard,
				enabled: true,
			},
			networkGuard: {
				...DEFAULT_SECURITY_CONFIG.networkGuard,
				enabled: false,
			},
		});
	});

	it("reports diagnostics for invalid json and invalid fields", () => {
		const appHomeDir = makeTempDir();
		writeFileSync(
			join(appHomeDir, "security.json"),
			JSON.stringify({
				networkGuard: { maxRedirects: 0 },
			}),
			"utf-8",
		);

		const loaded = loadSecurityConfigWithDiagnostics(appHomeDir);
		expect(loaded.config).toEqual(DEFAULT_SECURITY_CONFIG);
		expect(loaded.diagnostics.map((item) => item.message)).toEqual(
			expect.arrayContaining([expect.stringContaining("networkGuard.maxRedirects: expected a positive integer")]),
		);

		writeFileSync(join(appHomeDir, "security.json"), "{", "utf-8");
		const invalidJson = loadSecurityConfigWithDiagnostics(appHomeDir);
		expect(invalidJson.config).toEqual(DEFAULT_SECURITY_CONFIG);
		expect(invalidJson.diagnostics[0]?.severity).toBe("error");
	});
});
