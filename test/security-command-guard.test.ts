import { describe, expect, it } from "vitest";
import { guardCommand, internalCommandGuard } from "../src/security/command-guard.js";
import { DEFAULT_SECURITY_CONFIG } from "../src/security/config.js";

describe("security command guard", () => {
	it("allows common safe commands", () => {
		expect(guardCommand("rm file.txt", DEFAULT_SECURITY_CONFIG.commandGuard)).toEqual({ allowed: true });
		expect(guardCommand('python3 -c "print(42)"', DEFAULT_SECURITY_CONFIG.commandGuard)).toEqual({ allowed: true });
		expect(guardCommand("scp report.txt host:/tmp/report.txt", DEFAULT_SECURITY_CONFIG.commandGuard)).toEqual({
			allowed: true,
		});
	});

	it("blocks destructive and chained commands", () => {
		expect(guardCommand("rm -rf /", DEFAULT_SECURITY_CONFIG.commandGuard)).toMatchObject({
			allowed: false,
			category: "destructive-file-op",
		});
		expect(guardCommand("echo hi; rm -rf /", DEFAULT_SECURITY_CONFIG.commandGuard)).toMatchObject({
			allowed: false,
			category: "destructive-file-op",
		});
		expect(guardCommand("echo hi && shutdown now", DEFAULT_SECURITY_CONFIG.commandGuard)).toMatchObject({
			allowed: false,
			category: "system-manipulation",
		});
	});

	it("blocks command substitutions and common obfuscation patterns", () => {
		expect(guardCommand("$(rm -rf /)", DEFAULT_SECURITY_CONFIG.commandGuard)).toMatchObject({
			allowed: false,
			category: "destructive-file-op",
		});
		expect(guardCommand("`rm -rf /`", DEFAULT_SECURITY_CONFIG.commandGuard)).toMatchObject({
			allowed: false,
			category: "destructive-file-op",
		});
		expect(guardCommand("/bin/rm -rf /", DEFAULT_SECURITY_CONFIG.commandGuard)).toMatchObject({
			allowed: false,
			category: "destructive-file-op",
		});
		expect(guardCommand("echo xxx | base64 -d | bash", DEFAULT_SECURITY_CONFIG.commandGuard)).toMatchObject({
			allowed: false,
			category: "obfuscation",
		});
		expect(guardCommand("r\\m -rf /", DEFAULT_SECURITY_CONFIG.commandGuard)).toMatchObject({
			allowed: false,
			category: "destructive-file-op",
		});
	});

	it("parses shell words without treating quoted text as executable commands", () => {
		expect(internalCommandGuard.parseShellWords(`'r''m' -rf /`)).toEqual(["rm", "-rf", "/"]);
		expect(guardCommand(`echo "rm -rf /"`, DEFAULT_SECURITY_CONFIG.commandGuard)).toEqual({ allowed: true });
	});

	describe("allowPatterns are anchored per atom", () => {
		const config = { ...DEFAULT_SECURITY_CONFIG.commandGuard, allowPatterns: ["git status"] };

		it("allows an atom that the pattern fully covers", () => {
			expect(guardCommand("git status", config)).toEqual({ allowed: true });
			expect(guardCommand("git status -s", config)).toEqual({ allowed: true });
		});

		it("does not let an allowed fragment whitelist a chained dangerous command", () => {
			expect(guardCommand("git status; rm -rf /", config)).toMatchObject({
				allowed: false,
				category: "destructive-file-op",
			});
			expect(guardCommand("echo git status && rm -rf /", config)).toMatchObject({
				allowed: false,
				category: "destructive-file-op",
			});
		});
	});

	describe("recurses into shell -c script bodies", () => {
		it("blocks dangerous content hidden in sh/bash -c", () => {
			expect(guardCommand(`bash -c "rm -rf /"`, DEFAULT_SECURITY_CONFIG.commandGuard)).toMatchObject({
				allowed: false,
				category: "destructive-file-op",
			});
			expect(guardCommand(`sh -c 'shutdown now'`, DEFAULT_SECURITY_CONFIG.commandGuard)).toMatchObject({
				allowed: false,
				category: "system-manipulation",
			});
			expect(
				guardCommand(`bash -lc "echo hi; rm -rf --no-preserve-root /"`, DEFAULT_SECURITY_CONFIG.commandGuard),
			).toMatchObject({
				allowed: false,
				category: "destructive-file-op",
			});
		});

		it("still allows benign shell -c bodies", () => {
			expect(guardCommand(`bash -c "ls -la"`, DEFAULT_SECURITY_CONFIG.commandGuard)).toEqual({ allowed: true });
		});
	});

	describe("unwraps wrapper commands", () => {
		it("blocks dangerous commands behind wrappers", () => {
			expect(guardCommand("xargs rm -rf /", DEFAULT_SECURITY_CONFIG.commandGuard)).toMatchObject({
				allowed: false,
				category: "destructive-file-op",
			});
			expect(guardCommand("timeout 5 shred secret", DEFAULT_SECURITY_CONFIG.commandGuard)).toMatchObject({
				allowed: false,
				category: "destructive-file-op",
			});
			expect(guardCommand("env FOO=bar shutdown now", DEFAULT_SECURITY_CONFIG.commandGuard)).toMatchObject({
				allowed: false,
				category: "system-manipulation",
			});
			expect(guardCommand("find . -exec shred {} ;", DEFAULT_SECURITY_CONFIG.commandGuard)).toMatchObject({
				allowed: false,
				category: "destructive-file-op",
			});
		});

		it("still allows benign wrapped commands", () => {
			expect(guardCommand("time ls -la", DEFAULT_SECURITY_CONFIG.commandGuard)).toEqual({ allowed: true });
			expect(guardCommand("env NODE_ENV=prod node app.js", DEFAULT_SECURITY_CONFIG.commandGuard)).toEqual({
				allowed: true,
			});
		});
	});
});
