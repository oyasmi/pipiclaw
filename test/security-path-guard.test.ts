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
			projectRoot: workspaceDir,
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
		const ctx = {
			agentWorkspaceDir: workspaceDir,
			homeDir,
			projectRoot: workspaceDir,
			config: { ...DEFAULT_SECURITY_CONFIG.pathGuard, writeDeny: [join(aliasDeny, "canary.txt")] },
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

	function projectCtx(fixture: ReturnType<typeof createProjectFixture>, extra: Record<string, unknown> = {}) {
		return {
			agentWorkspaceDir: fixture.agentWorkspaceDir,
			homeDir: fixture.homeDir,
			projectRoot: fixture.projectRoot,
			boundary: "project" as const,
			config: DEFAULT_SECURITY_CONFIG.pathGuard,
			...extra,
		};
	}

	it("allows projectRoot access, read-only workspace skills/, and the channel tasks/ exception", () => {
		const fixture = createProjectFixture();
		const channelDir = join(fixture.agentWorkspaceDir, "group_demo");
		mkdirSync(join(channelDir, "tasks"), { recursive: true });
		writeFileSync(join(channelDir, "SESSION.md"), "session", "utf-8");
		writeFileSync(join(channelDir, "tasks", "ship-it.md"), "task", "utf-8");

		const ctx = projectCtx(fixture, { channelDir });

		expect(guardPath(join(fixture.projectRoot, "file.txt"), "read", ctx)).toMatchObject({ allowed: true });
		expect(guardPath(join(fixture.projectRoot, "sub", "out.txt"), "write", ctx)).toMatchObject({ allowed: true });
		expect(guardPath(join(fixture.agentWorkspaceDir, "skills", "demo", "SKILL.md"), "read", ctx)).toMatchObject({
			allowed: true,
		});
		// Spec 043 D5/D6.2: the channel directory stays readable (a task wake says
		// "open tasks/<id>.md") and its tasks/ writable, while runtime-maintained
		// memory files stay read-only because writing one races the maintenance queue.
		expect(guardPath(join(channelDir, "SESSION.md"), "read", ctx)).toMatchObject({ allowed: true });
		expect(guardPath(join(channelDir, "tasks", "ship-it.md"), "write", ctx)).toMatchObject({ allowed: true });
		expect(guardPath(join(channelDir, "SESSION.md"), "write", ctx)).toMatchObject({ allowed: false });
	});

	it("blocks everything outside projectRoot: workspace files, home/temp, widened allow-lists", () => {
		const fixture = createProjectFixture();
		const outsideDir = join(fixture.homeDir, "other");
		mkdirSync(outsideDir, { recursive: true });
		writeFileSync(join(outsideDir, "secret.txt"), "x", "utf-8");

		const widened = projectCtx(fixture, {
			config: { ...DEFAULT_SECURITY_CONFIG.pathGuard, readAllow: [outsideDir], writeAllow: [outsideDir] },
		});
		expect(guardPath(join(fixture.agentWorkspaceDir, "MEMORY.md"), "read", widened)).toMatchObject({
			allowed: false,
		});
		expect(guardPath(join(outsideDir, "secret.txt"), "read", widened)).toMatchObject({ allowed: false });
		expect(guardPath(join(outsideDir, "secret.txt"), "write", widened)).toMatchObject({ allowed: false });

		// The channel exception is scoped to callers that actually have a channel directory.
		const noChannel = projectCtx(fixture);
		const channelDir = join(fixture.agentWorkspaceDir, "group_demo");
		mkdirSync(channelDir, { recursive: true });
		expect(guardPath(join(channelDir, "SESSION.md"), "read", noChannel)).toMatchObject({ allowed: false });
	});

	it("names the project root in the refusal, not the roots a project boundary already excluded", () => {
		const fixture = createProjectFixture();
		const ctx = projectCtx(fixture);

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
});
