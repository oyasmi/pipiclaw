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

	// Spec 043 D5 keeps the channel's own files in the AgentWorkspace so a channel survives project
	// switches; D6.2's project bound then put them outside every allowed root, which broke the very
	// instruction a task wake gives ("open tasks/<id>.md"). Reads are restored throughout the
	// channel directory; writes only under tasks/, because a task body is the one thing there that
	// `task_manage` cannot rewrite.
	it("keeps the channel directory readable, and its tasks/ writable, under a project boundary", () => {
		const fixture = createProjectFixture();
		const channelDir = join(fixture.agentWorkspaceDir, "group_demo");
		mkdirSync(join(channelDir, "tasks"), { recursive: true });
		writeFileSync(join(channelDir, "SESSION.md"), "session", "utf-8");
		writeFileSync(join(channelDir, "tasks", "ship-it.md"), "task", "utf-8");
		const ctx = {
			agentWorkspaceDir: fixture.agentWorkspaceDir,
			homeDir: fixture.homeDir,
			projectRoot: fixture.projectRoot,
			channelDir,
			boundary: "project" as const,
			config: DEFAULT_SECURITY_CONFIG.pathGuard,
		};

		expect(guardPath(join(channelDir, "SESSION.md"), "read", ctx)).toMatchObject({ allowed: true });
		expect(guardPath(join(channelDir, "tasks", "ship-it.md"), "read", ctx)).toMatchObject({ allowed: true });
		expect(guardPath(join(channelDir, "tasks", "ship-it.md"), "write", ctx)).toMatchObject({ allowed: true });
		// Runtime-maintained memory files stay read-only: writing one races the maintenance queue.
		expect(guardPath(join(channelDir, "SESSION.md"), "write", ctx)).toMatchObject({ allowed: false });
		// The exception is scoped to this channel, not to sibling channels or the workspace root.
		expect(guardPath(join(fixture.agentWorkspaceDir, "group_other", "MEMORY.md"), "read", ctx)).toMatchObject({
			allowed: false,
		});
	});

	it("does not grant the channel exception to a caller with no channel directory", () => {
		const fixture = createProjectFixture();
		const channelDir = join(fixture.agentWorkspaceDir, "group_demo");
		mkdirSync(channelDir, { recursive: true });
		writeFileSync(join(channelDir, "SESSION.md"), "session", "utf-8");
		const ctx = {
			agentWorkspaceDir: fixture.agentWorkspaceDir,
			homeDir: fixture.homeDir,
			projectRoot: fixture.projectRoot,
			boundary: "project" as const,
			config: DEFAULT_SECURITY_CONFIG.pathGuard,
		};

		expect(guardPath(join(channelDir, "SESSION.md"), "read", ctx)).toMatchObject({ allowed: false });
	});

	it("names the project root in the refusal, not the roots a project boundary already excluded", () => {
		const fixture = createProjectFixture();
		const ctx = {
			agentWorkspaceDir: fixture.agentWorkspaceDir,
			homeDir: fixture.homeDir,
			projectRoot: fixture.projectRoot,
			boundary: "project" as const,
			config: DEFAULT_SECURITY_CONFIG.pathGuard,
		};

		const blocked = guardPath(join(fixture.homeDir, "outside-project.txt"), "read", ctx);
		expect(blocked.allowed).toBe(false);
		expect(blocked.reason).toContain("outside the current project root");
		expect(blocked.reason).not.toContain("workspace, home, and temp");

		// `/srv` is neither a denied system prefix nor one of the unbounded roots, so it lands on the
		// same refusal with the wording that boundary actually uses.
		const unbounded = guardPath("/srv/elsewhere/file.txt", "read", { ...ctx, boundary: "unbounded" as const });
		expect(unbounded.allowed).toBe(false);
		expect(unbounded.reason).toContain("workspace, home, and temp");
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
