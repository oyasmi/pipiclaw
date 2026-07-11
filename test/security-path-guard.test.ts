import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SECURITY_CONFIG } from "../src/security/config.js";
import { guardPath } from "../src/security/path-guard.js";
import { useTempDirs } from "./helpers/fixtures.js";

const makeTempDir = useTempDirs("pipiclaw-security-");

function createFixture() {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const workspaceDir = join(homeDir, "workspace");
	mkdirSync(workspaceDir, { recursive: true });
	mkdirSync(join(homeDir, "notes"), { recursive: true });
	mkdirSync(join(homeDir, ".ssh"), { recursive: true });
	writeFileSync(join(homeDir, ".ssh", "id_rsa"), "private", "utf-8");
	writeFileSync(join(homeDir, ".ssh", "authorized_keys"), "ssh-rsa AAA", "utf-8");
	writeFileSync(join(homeDir, ".bashrc"), "export PATH=...", "utf-8");
	writeFileSync(join(workspaceDir, "file.txt"), "workspace", "utf-8");
	const tempFile = join(root, "scratch.txt");
	writeFileSync(tempFile, "temp", "utf-8");
	return { root, homeDir, workspaceDir, tempFile };
}

describe("security path guard", () => {
	it("allows workspace, home, and temp paths", () => {
		const fixture = createFixture();
		const ctx = {
			workspaceDir: fixture.workspaceDir,
			homeDir: fixture.homeDir,
			cwd: fixture.workspaceDir,
			config: DEFAULT_SECURITY_CONFIG.pathGuard,
		};

		expect(guardPath("file.txt", "read", ctx)).toMatchObject({ allowed: true });
		expect(guardPath(join(fixture.homeDir, "notes", "todo.md"), "write", ctx)).toMatchObject({ allowed: true });
		expect(guardPath(fixture.tempFile, "read", ctx)).toMatchObject({ allowed: true });
		expect(guardPath(join(fixture.workspaceDir, "subdir", "out.txt"), "write", ctx)).toMatchObject({ allowed: true });
	});

	it("blocks sensitive reads and symlink traversal", () => {
		const fixture = createFixture();
		const linkPath = join(fixture.workspaceDir, "ssh-link");
		symlinkSync(join(fixture.homeDir, ".ssh", "id_rsa"), linkPath);
		const ctx = {
			workspaceDir: fixture.workspaceDir,
			homeDir: fixture.homeDir,
			cwd: fixture.workspaceDir,
			config: DEFAULT_SECURITY_CONFIG.pathGuard,
		};

		expect(guardPath(join(fixture.homeDir, ".ssh", "id_rsa"), "read", ctx)).toMatchObject({
			allowed: false,
			category: "sensitive-read-path",
		});
		expect(guardPath(linkPath, "read", ctx)).toMatchObject({
			allowed: false,
			category: "sensitive-read-path",
		});
	});

	it("blocks sensitive writes and symlink writes", () => {
		const fixture = createFixture();
		const linkPath = join(fixture.workspaceDir, "passwd-link");
		symlinkSync("/etc/passwd", linkPath);
		const ctx = {
			workspaceDir: fixture.workspaceDir,
			homeDir: fixture.homeDir,
			cwd: fixture.workspaceDir,
			config: DEFAULT_SECURITY_CONFIG.pathGuard,
		};

		expect(guardPath(join(fixture.homeDir, ".ssh", "authorized_keys"), "write", ctx)).toMatchObject({
			allowed: false,
			category: "sensitive-write-path",
		});
		expect(guardPath(join(fixture.homeDir, ".bashrc"), "write", ctx)).toMatchObject({
			allowed: false,
			category: "sensitive-write-path",
		});
		expect(guardPath(linkPath, "write", ctx)).toMatchObject({
			allowed: false,
			category: "symlink-write",
		});
	});
});
