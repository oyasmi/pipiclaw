import { mkdirSync, readFileSync } from "node:fs";
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

// Catalog order is the unique frontmatter order: orientation first, then memory, delivery,
// scheduling, background work, and finally the task lifecycle in the order it is walked.
const EXPECTED_PLAYBOOKS = [
	"runtime-orientation.md",
	"memory-and-learning.md",
	"outbound-media.md",
	"event-scheduling.md",
	"background-jobs.md",
	"agent-delegation.md",
	"task-planning.md",
	"task-driving.md",
];

const ALL_TOOLS = [
	"read",
	"memory_manage",
	"skill_manage",
	"send_media",
	"event_manage",
	"job",
	"task_manage",
	"subagent",
];

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
		expect(withoutTasks.filter((name) => name.startsWith("task-"))).toEqual([]);

		expect(selectRuntimePlaybooks(catalog, ALL_TOOLS)).toHaveLength(EXPECTED_PLAYBOOKS.length);
	});

	it("renders a compact index without loading playbook bodies into the prompt", () => {
		const index = renderPlaybookCatalog(loadRuntimePlaybookCatalog());
		for (const filename of EXPECTED_PLAYBOOKS) expect(index).toContain(`- ${filename} —`);
		// Body-only strings, one from a task playbook and one from a non-task playbook.
		expect(index).not.toContain("## control 决策");
	});
});

describe("path guard access to bundled playbooks", () => {
	function createCtx() {
		const root = makeTempDir();
		const homeDir = join(root, "home");
		const workspaceDir = join(homeDir, "workspace");
		mkdirSync(workspaceDir, { recursive: true });
		return {
			agentWorkspaceDir: workspaceDir,
			homeDir,
			projectRoot: workspaceDir,
			config: DEFAULT_SECURITY_CONFIG.pathGuard,
		};
	}

	it("allows reading playbooks outside workspace/home/temp but never writing them", () => {
		const ctx = createCtx();
		const playbookPath = join(PLAYBOOKS_DIR, "task-driving.md");
		expect(guardPath(playbookPath, "read", ctx)).toMatchObject({ allowed: true });
		expect(guardPath(playbookPath, "write", ctx)).toMatchObject({ allowed: false });
		expect(guardPath(join(PLAYBOOKS_DIR, "..", "main.ts"), "read", ctx)).toMatchObject({ allowed: false });
	});
});
