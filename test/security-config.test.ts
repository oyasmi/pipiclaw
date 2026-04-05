import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SECURITY_CONFIG, loadSecurityConfig } from "../src/security/config.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("security config", () => {
	it("returns defaults when no app-home config exists", () => {
		const appHomeDir = mkdtempSync(join(tmpdir(), "pipiclaw-security-config-"));
		tempDirs.push(appHomeDir);
		expect(loadSecurityConfig(appHomeDir)).toEqual(DEFAULT_SECURITY_CONFIG);
	});

	it("merges app-home overrides with defaults", () => {
		const appHomeDir = mkdtempSync(join(tmpdir(), "pipiclaw-security-config-"));
		tempDirs.push(appHomeDir);
		writeFileSync(
			join(appHomeDir, "security.json"),
			JSON.stringify({
				commandGuard: { allowPatterns: ["sudo apt install"] },
				pathGuard: { writeAllow: ["~/notes/"] },
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
			audit: {
				...DEFAULT_SECURITY_CONFIG.audit,
				logBlocked: false,
			},
		});
	});
});
