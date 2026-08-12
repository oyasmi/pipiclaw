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
			agentWorkspaceDir: fixture.workspaceDir,
			homeDir: fixture.homeDir,
			projectRoot: fixture.workspaceDir,
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
			agentWorkspaceDir: fixture.workspaceDir,
			homeDir: fixture.homeDir,
			projectRoot: fixture.workspaceDir,
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
			agentWorkspaceDir: fixture.workspaceDir,
			homeDir: fixture.homeDir,
			projectRoot: fixture.workspaceDir,
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

	it("canonicalizes configured deny paths the same way as target paths", () => {
		const fixture = createFixture();
		const realRoot = join(fixture.homeDir, "deny-real");
		const aliasRoot = join(fixture.homeDir, "deny-alias");
		mkdirSync(realRoot, { recursive: true });
		symlinkSync(realRoot, aliasRoot, "dir");
		const aliasedTarget = join(aliasRoot, "canary.txt");
		const ctx = {
			agentWorkspaceDir: fixture.workspaceDir,
			homeDir: fixture.homeDir,
			projectRoot: fixture.workspaceDir,
			config: { ...DEFAULT_SECURITY_CONFIG.pathGuard, writeDeny: [aliasedTarget] },
		};

		expect(guardPath(aliasedTarget, "write", ctx)).toMatchObject({
			allowed: false,
			category: "configured-deny",
		});
	});
});

describe('security path guard: boundary="project"', () => {
	function createProjectFixture() {
		const root = makeTempDir();
		const homeDir = join(root, "home");
		const agentWorkspaceDir = join(homeDir, "agent-workspace");
		mkdirSync(join(agentWorkspaceDir, "skills", "demo"), { recursive: true });
		writeFileSync(join(agentWorkspaceDir, "skills", "demo", "SKILL.md"), "skill", "utf-8");
		writeFileSync(join(agentWorkspaceDir, "MEMORY.md"), "memory", "utf-8");
		const projectRoot = join(homeDir, "project");
		mkdirSync(projectRoot, { recursive: true });
		writeFileSync(join(projectRoot, "file.txt"), "project", "utf-8");
		return { root, homeDir, agentWorkspaceDir, projectRoot };
	}

	it("allows reads/writes within projectRoot", () => {
		const fixture = createProjectFixture();
		const ctx = {
			agentWorkspaceDir: fixture.agentWorkspaceDir,
			homeDir: fixture.homeDir,
			projectRoot: fixture.projectRoot,
			boundary: "project" as const,
			config: DEFAULT_SECURITY_CONFIG.pathGuard,
		};

		expect(guardPath(join(fixture.projectRoot, "file.txt"), "read", ctx)).toMatchObject({ allowed: true });
		expect(guardPath(join(fixture.projectRoot, "sub", "out.txt"), "write", ctx)).toMatchObject({ allowed: true });
	});

	it("blocks reads/writes to the AgentWorkspace outside projectRoot", () => {
		const fixture = createProjectFixture();
		const ctx = {
			agentWorkspaceDir: fixture.agentWorkspaceDir,
			homeDir: fixture.homeDir,
			projectRoot: fixture.projectRoot,
			boundary: "project" as const,
			config: DEFAULT_SECURITY_CONFIG.pathGuard,
		};

		expect(guardPath(join(fixture.agentWorkspaceDir, "MEMORY.md"), "read", ctx)).toMatchObject({ allowed: false });
		expect(guardPath(join(fixture.agentWorkspaceDir, "MEMORY.md"), "write", ctx)).toMatchObject({ allowed: false });
	});

	it("still allows read-only access to AgentWorkspace skills/", () => {
		const fixture = createProjectFixture();
		const ctx = {
			agentWorkspaceDir: fixture.agentWorkspaceDir,
			homeDir: fixture.homeDir,
			projectRoot: fixture.projectRoot,
			boundary: "project" as const,
			config: DEFAULT_SECURITY_CONFIG.pathGuard,
		};

		expect(guardPath(join(fixture.agentWorkspaceDir, "skills", "demo", "SKILL.md"), "read", ctx)).toMatchObject({
			allowed: true,
		});
		expect(guardPath(join(fixture.agentWorkspaceDir, "skills", "demo", "SKILL.md"), "write", ctx)).toMatchObject({
			allowed: false,
		});
	});

	it("does not let a configured readAllow/writeAllow entry widen past projectRoot", () => {
		const fixture = createProjectFixture();
		const outsideDir = join(fixture.homeDir, "other");
		mkdirSync(outsideDir, { recursive: true });
		writeFileSync(join(outsideDir, "secret.txt"), "x", "utf-8");
		const ctx = {
			agentWorkspaceDir: fixture.agentWorkspaceDir,
			homeDir: fixture.homeDir,
			projectRoot: fixture.projectRoot,
			boundary: "project" as const,
			config: { ...DEFAULT_SECURITY_CONFIG.pathGuard, readAllow: [outsideDir], writeAllow: [outsideDir] },
		};

		expect(guardPath(join(outsideDir, "secret.txt"), "read", ctx)).toMatchObject({ allowed: false });
		expect(guardPath(join(outsideDir, "secret.txt"), "write", ctx)).toMatchObject({ allowed: false });
	});

	it('blocks home and temp paths that boundary="unbounded" would allow', () => {
		const fixture = createProjectFixture();
		const ctx = {
			agentWorkspaceDir: fixture.agentWorkspaceDir,
			homeDir: fixture.homeDir,
			projectRoot: fixture.projectRoot,
			boundary: "project" as const,
			config: DEFAULT_SECURITY_CONFIG.pathGuard,
		};

		expect(guardPath(join(fixture.homeDir, "outside-project.txt"), "write", ctx)).toMatchObject({
			allowed: false,
		});
	});
});
