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
});
