import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAppendSystemPrompt } from "../src/agent/prompt-builder.js";
import { PLAYBOOKS_DIR } from "../src/paths.js";
import { loadRuntimePlaybookCatalog, renderRuntimePlaybookIndex } from "../src/playbooks/catalog.js";
import { DEFAULT_SECURITY_CONFIG } from "../src/security/config.js";
import { guardPath } from "../src/security/path-guard.js";
import { useTempDirs } from "./helpers/fixtures.js";

const EXPECTED_PLAYBOOKS = [
	"event-scheduling.md",
	"memory-and-learning.md",
	"runtime-orientation.md",
	"task-closeout.md",
	"task-delegation.md",
	"task-driving.md",
	"task-planning.md",
	"task-recurring.md",
	"task-repair.md",
];

const makeTempDir = useTempDirs("pipiclaw-playbooks-");

describe("runtime playbook catalog", () => {
	it("loads every playbook from its name/description metadata", () => {
		const catalog = loadRuntimePlaybookCatalog();
		expect(catalog.map((item) => item.filename)).toEqual(EXPECTED_PLAYBOOKS);
		for (const item of catalog) {
			expect(item.name).toBe(item.filename.replace(/\.md$/, ""));
			expect(item.description.length).toBeGreaterThan(30);
			expect(readFileSync(item.path, "utf-8")).toContain("# ");
		}
	});

	it("rejects missing or mismatched trigger metadata", () => {
		const dir = makeTempDir();
		writeFileSync(join(dir, "broken.md"), "# no metadata\n");
		expect(() => loadRuntimePlaybookCatalog(dir)).toThrow("has no YAML frontmatter");

		writeFileSync(join(dir, "broken.md"), "---\nname: other\ndescription: a useful trigger\n---\n# Broken\n");
		expect(() => loadRuntimePlaybookCatalog(dir)).toThrow('must be "broken"');
	});

	it("renders a compact index without loading playbook bodies into the prompt", () => {
		const index = renderRuntimePlaybookIndex();
		for (const filename of EXPECTED_PLAYBOOKS) expect(index).toContain(`- ${filename} —`);
		expect(index).not.toContain("## control 决策");

		const prompt = buildAppendSystemPrompt("/workspace/root", "dm_123", {
			tools: [{ name: "task_manage", description: "Manage tasks" }],
		});
		expect(prompt).toContain("## Runtime Playbooks");
		expect(prompt).toContain(PLAYBOOKS_DIR);
		expect(prompt).toContain("task-driving.md");
		expect(prompt).not.toContain("一个周期任务由两份真相组成");
	});

	it("contains no bundled third-party agentmux implementation", () => {
		const catalogText = loadRuntimePlaybookCatalog()
			.map((item) => readFileSync(item.path, "utf-8"))
			.join("\n");
		expect(catalogText).not.toContain("agentmux-idle");
		expect(catalogText).not.toContain("agentmux inspect");
		expect(catalogText).toContain("Pipiclaw 不内置或假设第三方 agent 工具");
	});
});

describe("path guard access to bundled playbooks", () => {
	function createCtx() {
		const root = makeTempDir();
		const homeDir = join(root, "home");
		const workspaceDir = join(homeDir, "workspace");
		mkdirSync(workspaceDir, { recursive: true });
		return { workspaceDir, homeDir, cwd: workspaceDir, config: DEFAULT_SECURITY_CONFIG.pathGuard };
	}

	it("allows reading playbooks outside workspace/home/temp but never writing them", () => {
		const ctx = createCtx();
		const playbookPath = join(PLAYBOOKS_DIR, "task-repair.md");
		expect(guardPath(playbookPath, "read", ctx)).toMatchObject({ allowed: true });
		expect(guardPath(playbookPath, "write", ctx)).toMatchObject({ allowed: false });
		expect(guardPath(join(PLAYBOOKS_DIR, "..", "main.ts"), "read", ctx)).toMatchObject({ allowed: false });
	});
});
