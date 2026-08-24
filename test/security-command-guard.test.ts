import { describe, expect, it } from "vitest";
import { guardCommand, internalCommandGuard } from "../src/security/command-guard.js";
import { DEFAULT_SECURITY_CONFIG } from "../src/security/config.js";

describe("security command guard", () => {
	it("allows common safe commands, including quoted text and benign wrappers", () => {
		expect(guardCommand("rm file.txt", DEFAULT_SECURITY_CONFIG.commandGuard)).toEqual({ allowed: true });
		expect(guardCommand('python3 -c "print(42)"', DEFAULT_SECURITY_CONFIG.commandGuard)).toEqual({ allowed: true });
		expect(guardCommand(`echo "rm -rf /"`, DEFAULT_SECURITY_CONFIG.commandGuard)).toEqual({ allowed: true });
		expect(guardCommand(`bash -c "ls -la"`, DEFAULT_SECURITY_CONFIG.commandGuard)).toEqual({ allowed: true });
		expect(guardCommand("time ls -la", DEFAULT_SECURITY_CONFIG.commandGuard)).toEqual({ allowed: true });
		expect(guardCommand("env NODE_ENV=prod node app.js", DEFAULT_SECURITY_CONFIG.commandGuard)).toEqual({
			allowed: true,
		});
	});

	it("blocks destructive, chained, substituted, and obfuscated commands", () => {
		for (const cmd of ["rm -rf /", "echo hi; rm -rf /", "$(rm -rf /)", "`rm -rf /`", "/bin/rm -rf /", "r\\m -rf /"]) {
			expect(guardCommand(cmd, DEFAULT_SECURITY_CONFIG.commandGuard)).toMatchObject({
				allowed: false,
				category: "destructive-file-op",
			});
		}
		expect(guardCommand("echo hi && shutdown now", DEFAULT_SECURITY_CONFIG.commandGuard)).toMatchObject({
			allowed: false,
			category: "system-manipulation",
		});
		expect(guardCommand("echo xxx | base64 -d | bash", DEFAULT_SECURITY_CONFIG.commandGuard)).toMatchObject({
			allowed: false,
			category: "obfuscation",
		});
	});

	it("parses shell words without treating quoted text as executable commands", () => {
		expect(internalCommandGuard.parseShellWords(`'r''m' -rf /`)).toEqual(["rm", "-rf", "/"]);
	});

	it("anchors allowPatterns per atom so a fragment cannot whitelist a chained dangerous command", () => {
		const config = { ...DEFAULT_SECURITY_CONFIG.commandGuard, allowPatterns: ["git status"] };
		expect(guardCommand("git status", config)).toEqual({ allowed: true });
		expect(guardCommand("git status -s", config)).toEqual({ allowed: true });
		expect(guardCommand("git status; rm -rf /", config)).toMatchObject({
			allowed: false,
			category: "destructive-file-op",
		});
		expect(guardCommand("echo git status && rm -rf /", config)).toMatchObject({
			allowed: false,
			category: "destructive-file-op",
		});
	});

	it("recurses into shell -c script bodies and unwraps wrapper commands before judging them", () => {
		expect(guardCommand(`bash -c "rm -rf /"`, DEFAULT_SECURITY_CONFIG.commandGuard)).toMatchObject({
			allowed: false,
			category: "destructive-file-op",
		});
		expect(guardCommand(`sh -c 'shutdown now'`, DEFAULT_SECURITY_CONFIG.commandGuard)).toMatchObject({
			allowed: false,
			category: "system-manipulation",
		});
		for (const cmd of ["xargs rm -rf /", "timeout 5 shred secret", "find . -exec shred {} ;"]) {
			expect(guardCommand(cmd, DEFAULT_SECURITY_CONFIG.commandGuard)).toMatchObject({
				allowed: false,
				category: "destructive-file-op",
			});
		}
		expect(guardCommand("env FOO=bar shutdown now", DEFAULT_SECURITY_CONFIG.commandGuard)).toMatchObject({
			allowed: false,
			category: "system-manipulation",
		});
	});
});
