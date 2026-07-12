import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PLAYBOOKS_DIR } from "../src/paths.js";
import {
	loadRuntimePlaybookCatalog,
	MAX_PLAYBOOK_DESCRIPTION_CHARS,
	renderPlaybookCatalog,
	selectRuntimePlaybooks,
} from "../src/playbooks/catalog.js";
import { DEFAULT_SECURITY_CONFIG } from "../src/security/config.js";
import { guardPath } from "../src/security/path-guard.js";
import { useTempDirs } from "./helpers/fixtures.js";

// Catalog order is priority-then-filename: orientation first, then memory, events, tasks.
const EXPECTED_PLAYBOOKS = [
	"runtime-orientation.md",
	"memory-and-learning.md",
	"event-scheduling.md",
	"task-planning.md",
	"task-driving.md",
	"task-closeout.md",
	"task-recurring.md",
	"task-repair.md",
	"task-delegation.md",
];

const ALL_TOOLS = ["read", "memory_manage", "skill_manage", "event_manage", "task_manage", "subagent"];

const makeTempDir = useTempDirs("pipiclaw-playbooks-");

describe("runtime playbook catalog", () => {
	it("loads every playbook from its name/description metadata", () => {
		const catalog = loadRuntimePlaybookCatalog();
		expect(catalog.map((item) => item.filename)).toEqual(EXPECTED_PLAYBOOKS);
		for (const item of catalog) {
			expect(item.name).toBe(item.filename.replace(/\.md$/, ""));
			expect(item.description.length).toBeGreaterThan(30);
			expect(item.description.length).toBeLessThanOrEqual(MAX_PLAYBOOK_DESCRIPTION_CHARS);
			expect(readFileSync(item.path, "utf-8")).toContain("# ");
		}
	});

	it("offers a playbook only when a tool can reach the mechanism it documents", () => {
		const catalog = loadRuntimePlaybookCatalog();

		const withoutTasks = selectRuntimePlaybooks(
			catalog,
			ALL_TOOLS.filter((tool) => tool !== "task_manage" && tool !== "subagent"),
		).map((item) => item.filename);
		expect(withoutTasks).toContain("runtime-orientation.md");
		expect(withoutTasks).toContain("memory-and-learning.md");
		expect(withoutTasks.filter((name) => name.startsWith("task-"))).toEqual([]);

		// Sub-agents without tasks still need the delegation playbook (any-of, not all-of).
		const subagentOnly = selectRuntimePlaybooks(catalog, ["read", "subagent"]).map((item) => item.filename);
		expect(subagentOnly).toEqual(["runtime-orientation.md", "task-delegation.md"]);

		expect(selectRuntimePlaybooks(catalog, ALL_TOOLS)).toHaveLength(EXPECTED_PLAYBOOKS.length);
	});

	it("rejects authored metadata that names an unknown tool or mode", () => {
		const dir = makeTempDir();
		const frontmatter = (extra: string) =>
			`---\nname: broken\ndescription: a useful trigger for this playbook\n${extra}\n---\n# Broken\n`;

		writeFileSync(join(dir, "broken.md"), frontmatter("requires-tools: task_manag"));
		expect(() => loadRuntimePlaybookCatalog(dir)).toThrow('requires unknown tool "task_manag"');

		writeFileSync(join(dir, "broken.md"), frontmatter("modes: driver"));
		expect(() => loadRuntimePlaybookCatalog(dir)).toThrow('unknown mode "driver"');
	});

	it("rejects missing or mismatched trigger metadata", () => {
		const dir = makeTempDir();
		writeFileSync(join(dir, "broken.md"), "# no metadata\n");
		expect(() => loadRuntimePlaybookCatalog(dir)).toThrow("has no YAML frontmatter");

		writeFileSync(join(dir, "broken.md"), "---\nname: other\ndescription: a useful trigger\n---\n# Broken\n");
		expect(() => loadRuntimePlaybookCatalog(dir)).toThrow('must be "broken"');
	});

	it("renders a compact index without loading playbook bodies into the prompt", () => {
		const index = renderPlaybookCatalog(loadRuntimePlaybookCatalog());
		for (const filename of EXPECTED_PLAYBOOKS) expect(index).toContain(`- ${filename} —`);
		expect(index).not.toContain("## control 决策");
		expect(index).not.toContain("一个周期任务由两份真相组成");
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
