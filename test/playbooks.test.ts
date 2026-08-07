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

// Catalog order is priority-then-filename: orientation first, then memory, delivery,
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
		expect(withoutTasks).toContain("memory-and-learning.md");
		expect(withoutTasks.filter((name) => name.startsWith("task-"))).toEqual([]);

		// Agent delegation remains discoverable without task_manage or a built-in subagent;
		// external Agent capabilities may arrive through a user-provided skill.
		const subagentOnly = selectRuntimePlaybooks(catalog, ["read", "subagent"]).map((item) => item.filename);
		expect(subagentOnly).toEqual(["runtime-orientation.md", "agent-delegation.md"]);

		expect(selectRuntimePlaybooks(catalog, ALL_TOOLS)).toHaveLength(EXPECTED_PLAYBOOKS.length);
	});

	it("rejects authored metadata that names an unknown tool", () => {
		const dir = makeTempDir();
		const frontmatter = (extra: string) =>
			`---\nname: broken\ndescription: a useful trigger for this playbook\n${extra}\n---\n# Broken\n`;

		writeFileSync(join(dir, "broken.md"), frontmatter("requires-tools: task_manag"));
		expect(() => loadRuntimePlaybookCatalog(dir)).toThrow('requires unknown tool "task_manag"');
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
		// Body-only strings, one from a task playbook and one from a non-task playbook.
		expect(index).not.toContain("## control 决策");
		expect(index).not.toContain("每个 channel 最多 5 个同时运行的作业");
	});

	// The human-facing guide keeps its own table of playbooks. Nothing generates one from
	// the other, so this reconciles them: a new/renamed/deleted playbook fails here until
	// docs/runtime-playbooks.md is updated, which is how that table stayed stale before.
	it("keeps the docs/runtime-playbooks.md table in sync with the shipped catalog", () => {
		const doc = readFileSync(new URL("../docs/runtime-playbooks.md", import.meta.url), "utf-8");
		const shipped = loadRuntimePlaybookCatalog().map((item) => item.filename);

		for (const filename of shipped) expect(doc).toContain(`\`${filename}\``);

		const namedInDoc = new Set((doc.match(/`[a-z][a-z-]*\.md`/g) ?? []).map((name) => name.slice(1, -1)));
		for (const name of namedInDoc) expect(shipped).toContain(name);
	});

	// Spec 040, D2: a delegation run now wakes its own channel by itself (sync grace window, then
	// async) — the model no longer needs to wrap external waiting in a background job. Delegation
	// used to route this through `bash async`; that routing is gone, and polling via the
	// delegation tool itself is explicitly discouraged in favor of `subagent_manage op=list`.
	it("tells the model a dispatched run wakes itself, rather than routing waiting through bash async", () => {
		const delegation = readFileSync(join(PLAYBOOKS_DIR, "agent-delegation.md"), "utf-8");
		expect(delegation).toContain("subagent_manage");
		expect(delegation).toContain("不要轮询");
		expect(delegation).not.toContain("bash async");
	});

	// "How to wait" was told three different ways across three playbooks, two of them describing a
	// parking mechanism the driver did not implement. The mechanism exists now (waiting with no
	// wake is never dispatched); keep the description in one place and keep the other playbooks
	// pointing at it rather than restating it.
	it("keeps task-driving.md the single source of truth for the two task waiting shapes", () => {
		const driving = readFileSync(join(PLAYBOOKS_DIR, "task-driving.md"), "utf-8");
		expect(driving).toContain("唯一真相源");
		expect(driving).toContain("停泊");
		expect(driving).toContain("agent-delegation.md");
	});

	it("keeps post-creation task verification and closeout in task-driving.md", () => {
		const driving = readFileSync(join(PLAYBOOKS_DIR, "task-driving.md"), "utf-8");
		expect(driving).toContain("request-verification");
		expect(driving).toContain("contract body hash");
		expect(driving).toContain("## complete / skip / cancel");
	});

	it("maps app, workspace, channel, and delegated-tool knowledge in runtime orientation", () => {
		const orientation = readFileSync(join(PLAYBOOKS_DIR, "runtime-orientation.md"), "utf-8");
		expect(orientation).toContain("App home");
		expect(orientation).toContain("channel.json");
		expect(orientation).toContain("SESSION.md");
		expect(orientation).toContain("agent-delegation.md");
	});

	it("contains no bundled third-party agentmux implementation", () => {
		const catalogText = loadRuntimePlaybookCatalog()
			.map((item) => readFileSync(item.path, "utf-8"))
			.join("\n");
		expect(catalogText).not.toContain("agentmux-idle");
		expect(catalogText).not.toContain("agentmux inspect");
		// Spec 040: external delegation is now runtime-driven (role files + subagent tools), not a
		// user-provided skill wrapping a third-party CLI — only non-delegation third-party tool use
		// still routes through skills.
		expect(catalogText).toContain("不通过委派角色调用的第三方工具用法读对应 skill");
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
		const playbookPath = join(PLAYBOOKS_DIR, "task-driving.md");
		expect(guardPath(playbookPath, "read", ctx)).toMatchObject({ allowed: true });
		expect(guardPath(playbookPath, "write", ctx)).toMatchObject({ allowed: false });
		expect(guardPath(join(PLAYBOOKS_DIR, "..", "main.ts"), "read", ctx)).toMatchObject({ allowed: false });
	});
});
