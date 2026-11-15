import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SECURITY_CONFIG } from "../src/security/config.js";
import { guardPath } from "../src/security/path-guard.js";
import { useTempDirs } from "./helpers/fixtures.js";

const makeTempDir = useTempDirs("pipiclaw-security-");

describe("security path guard", () => {
	it("allows workspace, home, and temp paths", () => {
		const root = makeTempDir();
		const homeDir = join(root, "home");
		const workspaceDir = join(homeDir, "workspace");
		mkdirSync(workspaceDir, { recursive: true });
		writeFileSync(join(workspaceDir, "file.txt"), "workspace", "utf-8");
		const tempFile = join(root, "scratch.txt");
		writeFileSync(tempFile, "temp", "utf-8");
		const ctx = {
			agentWorkspaceDir: workspaceDir,
			homeDir,
			cwd: workspaceDir,
			config: DEFAULT_SECURITY_CONFIG.pathGuard,
		};

		expect(guardPath("file.txt", "read", ctx)).toMatchObject({ allowed: true });
		expect(guardPath(join(homeDir, "notes", "todo.md"), "write", ctx)).toMatchObject({ allowed: true });
		expect(guardPath(tempFile, "read", ctx)).toMatchObject({ allowed: true });
	});

	it("blocks sensitive reads and writes, symlink traversal, and honors canonicalized deny paths", () => {
		const root = makeTempDir();
		const homeDir = join(root, "home");
		const workspaceDir = join(homeDir, "workspace");
		mkdirSync(workspaceDir, { recursive: true });
		mkdirSync(join(homeDir, ".ssh"), { recursive: true });
		writeFileSync(join(homeDir, ".ssh", "id_rsa"), "private", "utf-8");
		writeFileSync(join(homeDir, ".ssh", "authorized_keys"), "ssh-rsa AAA", "utf-8");
		writeFileSync(join(homeDir, ".bashrc"), "export PATH=...", "utf-8");
		const sshLink = join(workspaceDir, "ssh-link");
		symlinkSync(join(homeDir, ".ssh", "id_rsa"), sshLink);
		const passwdLink = join(workspaceDir, "passwd-link");
		symlinkSync("/etc/passwd", passwdLink);

		const realDeny = join(homeDir, "deny-real");
		const aliasDeny = join(homeDir, "deny-alias");
		mkdirSync(realDeny, { recursive: true });
		symlinkSync(realDeny, aliasDeny, "dir");

		// Custom appHomeDir under temp (mirroring PIPICLAW_HOME / E2E home): its control-plane files and
		// state/ must be blocked for both read and write even when readAllow/writeAllow includes appHomeDir,
		// while workspace/ inside appHomeDir remains accessible.
		const appHomeDir = join(root, "app-home");
		const appWorkspaceDir = join(appHomeDir, "workspace");
		mkdirSync(join(appHomeDir, "state", "webapi"), { recursive: true });
		mkdirSync(appWorkspaceDir, { recursive: true });
		writeFileSync(join(appHomeDir, "auth.json"), '{"key":"secret"}', "utf-8");
		writeFileSync(join(appHomeDir, "security.json"), '{"enabled":true}', "utf-8");
		writeFileSync(join(appHomeDir, "state", "webapi", "keys.json"), "{}", "utf-8");
		writeFileSync(join(appWorkspaceDir, "notes.md"), "ok", "utf-8");
		mkdirSync(join(homeDir, ".claude"), { recursive: true });
		mkdirSync(join(homeDir, ".codex"), { recursive: true });
		writeFileSync(join(homeDir, ".claude", ".credentials.json"), "{}", "utf-8");
		writeFileSync(join(homeDir, ".codex", "auth.json"), "{}", "utf-8");

		const ctx = {
			agentWorkspaceDir: workspaceDir,
			homeDir,
			appHomeDir,
			cwd: workspaceDir,
			config: {
				...DEFAULT_SECURITY_CONFIG.pathGuard,
				readAllow: [appHomeDir],
				writeAllow: [appHomeDir],
				writeDeny: [join(aliasDeny, "canary.txt")],
			},
		};

		expect(guardPath(join(homeDir, ".ssh", "id_rsa"), "read", ctx)).toMatchObject({
			allowed: false,
			category: "sensitive-read-path",
		});
		expect(guardPath(sshLink, "read", ctx)).toMatchObject({ allowed: false, category: "sensitive-read-path" });
		expect(guardPath(join(homeDir, ".ssh", "authorized_keys"), "write", ctx)).toMatchObject({
			allowed: false,
			category: "sensitive-write-path",
		});
		expect(guardPath(join(homeDir, ".bashrc"), "write", ctx)).toMatchObject({
			allowed: false,
			category: "sensitive-write-path",
		});
		expect(guardPath(passwdLink, "write", ctx)).toMatchObject({ allowed: false, category: "symlink-write" });
		// Deny paths are canonicalized the same way as target paths, so an aliased path is denied too.
		expect(guardPath(join(aliasDeny, "canary.txt"), "write", ctx)).toMatchObject({
			allowed: false,
			category: "configured-deny",
		});
		for (const controlPath of [
			join(appHomeDir, "auth.json"),
			join(appHomeDir, "channel.json"),
			join(appHomeDir, "security.json"),
			join(appHomeDir, "models.json"),
			join(appHomeDir, "tools.json"),
			join(appHomeDir, "settings.json"),
			join(appHomeDir, "state", "webapi", "keys.json"),
			join(homeDir, ".pipiclaw", "security.json"),
			join(homeDir, ".pipiclaw", "state", "daemon.lock"),
			join(homeDir, ".claude", ".credentials.json"),
			join(homeDir, ".codex", "auth.json"),
		]) {
			expect(guardPath(controlPath, "read", ctx)).toMatchObject({
				allowed: false,
				category: "sensitive-read-path",
			});
			expect(guardPath(controlPath, "write", ctx)).toMatchObject({
				allowed: false,
				category: "sensitive-write-path",
			});
		}
		expect(guardPath(join(appWorkspaceDir, "notes.md"), "read", ctx)).toMatchObject({ allowed: true });
		expect(guardPath(join(appWorkspaceDir, "notes.md"), "write", ctx)).toMatchObject({ allowed: true });
	});
});
