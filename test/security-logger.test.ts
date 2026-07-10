import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SECURITY_CONFIG } from "../src/security/config.js";
import { logSecurityEvent } from "../src/security/logger.js";

// The audit trail for every blocked path/command/network action goes through
// this ~20-line module. It had no test at all, so a silent regression (e.g.
// the logBlocked gate flipping, or the try/catch swallowing real write
// failures) would go unnoticed — exactly the sort of thing you only find out
// about when you actually need the audit log after an incident.
describe("logSecurityEvent", () => {
	let workspaceDir: string;

	beforeEach(() => {
		workspaceDir = mkdtempSync(join(tmpdir(), "security-logger-"));
	});

	afterEach(() => {
		rmSync(workspaceDir, { recursive: true, force: true });
	});

	function defaultLogPath(): string {
		return join(workspaceDir, ".pipiclaw", "security.log");
	}

	it("appends a JSON line to the default log path when logBlocked is enabled", () => {
		const config = { ...DEFAULT_SECURITY_CONFIG, audit: { logBlocked: true } };
		logSecurityEvent(workspaceDir, config, { type: "path", tool: "read", rawPath: "/etc/passwd", operation: "read" });

		expect(existsSync(defaultLogPath())).toBe(true);
		const line = readFileSync(defaultLogPath(), "utf-8").trim();
		const parsed = JSON.parse(line);
		expect(parsed).toMatchObject({ type: "path", tool: "read", rawPath: "/etc/passwd", operation: "read" });
		expect(typeof parsed.date).toBe("string");
	});

	it("does nothing when logBlocked is disabled", () => {
		const config = { ...DEFAULT_SECURITY_CONFIG, audit: { logBlocked: false } };
		logSecurityEvent(workspaceDir, config, { type: "command", tool: "bash", command: "rm -rf /" });
		expect(existsSync(defaultLogPath())).toBe(false);
	});

	it("appends multiple events in order, one JSON object per line", () => {
		const config = { ...DEFAULT_SECURITY_CONFIG, audit: { logBlocked: true } };
		logSecurityEvent(workspaceDir, config, { type: "command", tool: "bash", command: "one" });
		logSecurityEvent(workspaceDir, config, { type: "command", tool: "bash", command: "two" });

		const lines = readFileSync(defaultLogPath(), "utf-8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0] ?? "").command).toBe("one");
		expect(JSON.parse(lines[1] ?? "").command).toBe("two");
	});

	it("honors a custom logFile path and creates its parent directory", () => {
		const customPath = join(workspaceDir, "custom", "nested", "audit.log");
		const config = { ...DEFAULT_SECURITY_CONFIG, audit: { logBlocked: true, logFile: customPath } };
		logSecurityEvent(workspaceDir, config, {
			type: "network",
			tool: "web_fetch",
			url: "http://169.254.169.254/",
			stage: "request",
		});

		expect(existsSync(customPath)).toBe(true);
		expect(existsSync(defaultLogPath())).toBe(false);
	});

	it("never throws even when the log path cannot be written", () => {
		// A file component in the middle of the path makes mkdirSync fail.
		const blockedPath = join(workspaceDir, "not-a-dir", "audit.log");
		writeFileSync(join(workspaceDir, "not-a-dir"), "i am a file, not a directory");
		const config = { ...DEFAULT_SECURITY_CONFIG, audit: { logBlocked: true, logFile: blockedPath } };

		expect(() =>
			logSecurityEvent(workspaceDir, config, { type: "command", tool: "bash", command: "whoami" }),
		).not.toThrow();
	});
});
