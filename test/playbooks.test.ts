import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAppendSystemPrompt } from "../src/agent/prompt-builder.js";
import { PLAYBOOKS_DIR } from "../src/paths.js";
import { DEFAULT_SECURITY_CONFIG } from "../src/security/config.js";
import { guardPath } from "../src/security/path-guard.js";

const EXPECTED_PLAYBOOKS = ["task-closeout.md", "task-delegation.md", "task-recurring.md", "task-repair.md"];

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("bundled playbooks payload", () => {
	it("ships the task playbooks and the agentmux idle sensor", () => {
		const files = readdirSync(PLAYBOOKS_DIR).filter((name) => name.endsWith(".md"));
		expect(files.sort()).toEqual(EXPECTED_PLAYBOOKS);
		expect(readFileSync(join(PLAYBOOKS_DIR, "scripts", "agentmux-idle.mjs"), "utf-8")).toContain(
			'process.exit(status === "busy" ? 1 : 0)',
		);
	});

	it.each(EXPECTED_PLAYBOOKS)("%s is a titled read-only runtime manual", (name) => {
		const content = readFileSync(join(PLAYBOOKS_DIR, name), "utf-8");
		expect(content.startsWith("# ")).toBe(true);
		expect(content).toContain("内置手册");
	});
});

describe("playbook index in the system prompt", () => {
	it("routes to the playbooks only when task_manage is present", () => {
		const withTasks = buildAppendSystemPrompt("/workspace/root", "dm_123", {
			tools: [{ name: "task_manage", description: "Manage tasks" }],
		});
		expect(withTasks).toContain("### Task Playbooks");
		expect(withTasks).toContain(PLAYBOOKS_DIR);
		for (const name of EXPECTED_PLAYBOOKS) {
			expect(withTasks).toContain(name);
		}

		const withoutTasks = buildAppendSystemPrompt("/workspace/root", "dm_123", {
			tools: [{ name: "read", description: "Read files" }],
		});
		expect(withoutTasks).not.toContain("### Task Playbooks");
	});
});

describe("path guard access to bundled playbooks", () => {
	function createCtx() {
		const root = mkdtempSync(join(tmpdir(), "pipiclaw-playbooks-guard-"));
		tempDirs.push(root);
		const homeDir = join(root, "home");
		const workspaceDir = join(homeDir, "workspace");
		mkdirSync(workspaceDir, { recursive: true });
		return {
			workspaceDir,
			homeDir,
			cwd: workspaceDir,
			config: DEFAULT_SECURITY_CONFIG.pathGuard,
		};
	}

	it("allows reading playbooks outside workspace/home/temp but never writing them", () => {
		const ctx = createCtx();
		const playbookPath = join(PLAYBOOKS_DIR, "task-repair.md");

		expect(guardPath(playbookPath, "read", ctx)).toMatchObject({ allowed: true });
		expect(guardPath(playbookPath, "write", ctx)).toMatchObject({ allowed: false });
		// The allowance is scoped to the playbooks dir, not its parent tree.
		expect(guardPath(join(PLAYBOOKS_DIR, "..", "main.ts"), "read", ctx)).toMatchObject({ allowed: false });
	});
});
