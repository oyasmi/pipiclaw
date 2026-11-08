import { describe, expect, it } from "vitest";
import { guardCommand, internalCommandGuard } from "../src/security/command-guard.js";
import { DEFAULT_SECURITY_CONFIG } from "../src/security/config.js";

describe("security command guard", () => {
	it("allows common safe commands, including quoted text and benign wrappers", () => {
		expect(guardCommand("rm file.txt", DEFAULT_SECURITY_CONFIG.commandGuard)).toEqual({ allowed: true });
		expect(guardCommand('python3 -c "print(42)"', DEFAULT_SECURITY_CONFIG.commandGuard)).toEqual({ allowed: true });
		expect(guardCommand(`echo "rm -rf /"`, DEFAULT_SECURITY_CONFIG.commandGuard)).toEqual({ allowed: true });
		expect(guardCommand(`bash -c "ls -la"`, DEFAULT_SECURITY_CONFIG.commandGuard)).toEqual({ allowed: true });
		for (const command of [
			"time ls -la",
			"rg '__expansion__' src",
			"cat '__substitution__'",
			"printf ok >'__glob__'",
			"echo foo#bar; printf ok",
			"echo '# rm -rf /'",
			"env printf '%s' 'rm -rf /'",
			"echo ok # rm -rf /\nprintf ok",
			"printf ok 2>&1 | cat",
			"echo ok &>log rm -rf /",
			"printf '%s' '\\x72 rm -rf /'",
			"timeout 5 printf '%s' 'shutdown now'",
			"find . -exec printf '%s' 'shred file' \\;",
			`echo "$(printf '%s' 'rm -rf /')"`,
			"echo $(printf ok)",
			"find . -name -delete",
			"parallel printf '%s' 'rm -rf /' ::: value",
			"timeout 1 ls *.ts",
			"find . -exec printf '%s' -delete sh {} \\;",
		]) {
			expect(guardCommand(command, DEFAULT_SECURITY_CONFIG.commandGuard), command).toEqual({ allowed: true });
		}
		expect(guardCommand("env NODE_ENV=prod node app.js", DEFAULT_SECURITY_CONFIG.commandGuard)).toEqual({
			allowed: true,
		});
	});

	it("blocks destructive, chained, substituted, and obfuscated commands", () => {
		// 2026-11-08: comment-newline and background/subshell/prefix counterexamples were admitted by the old scanner; guard only, never executed.
		for (const cmd of [
			"rm -rf /",
			"echo hi; rm -rf /",
			"$(rm -rf /)",
			"`rm -rf /`",
			"/bin/rm -rf /",
			"r\\m -rf /",
			"echo ok # comment\nrm -rf /",
			"echo ok & rm -rf /",
			"(rm -rf /)",
			">out rm -rf /",
			"X=1 rm -rf /",
			"echo 'x\\' & rm -rf /",
			"printf ok 2>&1 & rm -rf /",
			'echo "$(printf ok # comment\nrm -rf /)"',
			"cat <(rm -rf /)",
			`env ${"A=1 ".repeat(40)}rm -rf /`,
			"bash -cl 'rm -rf /'",
			"for i in 1 2; do rm -rf /; done",
			"find . -exec timeout 1 rm -rf / \\;",
			"find . -exec rm {} \\;",
		]) {
			expect(guardCommand(cmd, DEFAULT_SECURITY_CONFIG.commandGuard), cmd).toMatchObject({
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
		for (const command of [
			"echo 'unclosed",
			"echo $(printf ok",
			"cat <<EOF\nrm -rf /\nEOF",
			"rm -r{,f} /",
			"rm $FLAGS /",
			"echo ok > /dev/tcp/host/1",
			"xargs -I X sh -c X",
			"find . -exec sh -c 'echo {}' \\;",
			"timeout --unknown rm -rf /",
			"echo ok > $TARGET",
			"rm -?f /",
			"parallel 'echo ok; rm -rf /' ::: value",
		]) {
			// Unsupported syntax must be refused, independently of any dangerous text.
			expect(guardCommand(command, DEFAULT_SECURITY_CONFIG.commandGuard).allowed, command).toBe(false);
		}
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
		for (const cmd of ["xargs rm -rf /", "timeout 5 shred secret", "find . -exec shred {} \\;"]) {
			expect(guardCommand(cmd, DEFAULT_SECURITY_CONFIG.commandGuard), cmd).toMatchObject({
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
