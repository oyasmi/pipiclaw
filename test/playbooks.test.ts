import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PLAYBOOKS_DIR } from "../src/paths.js";
import {
	loadRuntimePlaybookCatalog,
	MAX_PLAYBOOK_DESCRIPTION_CHARS,
	renderPlaybookCatalog,
	selectRuntimePlaybooks,
} from "../src/playbooks/catalog.js";
import { validateScheduledEvent } from "../src/runtime/event-validation.js";
import { parseScheduledEventContent } from "../src/runtime/events.js";
import { DEFAULT_SECURITY_CONFIG } from "../src/security/config.js";
import { guardPath } from "../src/security/path-guard.js";
import { TOOL_NAMES } from "../src/tools/registry.js";
import { useTempDirs } from "./helpers/fixtures.js";

// Derived from the registry (spec 046 D6's fix, generalized): a hand-maintained list drifts
// silently — it previously still listed the retired `skill_manage` and the pre-split
// `task_manage` — and a stale fixture here would make selectRuntimePlaybooks's gating "pass"
// against tool names that no longer exist.
const ALL_TOOLS = Array.from(TOOL_NAMES);
const TASK_TOOLS = ["task_list", "task_create", "task_update", "task_close", "task_log", "task_step_end"];

const makeTempDir = useTempDirs("pipiclaw-playbooks-");

describe("runtime playbook catalog", () => {
	it("loads every playbook from its name/description metadata", () => {
		const catalog = loadRuntimePlaybookCatalog();
		expect(catalog.map((item) => item.filename).sort()).toEqual(
			readdirSync(PLAYBOOKS_DIR)
				.filter((filename) => filename.endsWith(".md"))
				.sort(),
		);
		for (const item of catalog) {
			expect(item.name).toBe(item.filename.replace(/\.md$/, ""));
			expect(item.description.length).toBeGreaterThan(0);
			expect(item.description.length).toBeLessThanOrEqual(MAX_PLAYBOOK_DESCRIPTION_CHARS);
			expect(readFileSync(item.path, "utf-8")).toContain("# ");
		}
	});

	it("offers a playbook only when a tool can reach the mechanism it documents", () => {
		const catalog = loadRuntimePlaybookCatalog();

		const withoutTasks = selectRuntimePlaybooks(
			catalog,
			ALL_TOOLS.filter((tool) => !TASK_TOOLS.includes(tool) && tool !== "subagent" && tool !== "subagent_inline"),
		).map((item) => item.filename);
		expect(withoutTasks).toContain("runtime-orientation.md");
		expect(withoutTasks.filter((name) => name.startsWith("task-"))).toEqual([]);

		expect(selectRuntimePlaybooks(catalog, ALL_TOOLS)).toHaveLength(catalog.length);
		// Chat and task steps expose different halves of this any-of gate.
		for (const taskTool of ["task_create", "task_step_end"]) {
			expect(selectRuntimePlaybooks(catalog, [taskTool]).map((item) => item.name)).toContain("task-loop");
		}
	});

	it("renders a compact index without loading playbook bodies into the prompt", () => {
		const directory = makeTempDir();
		const body = "UNIQUE_BODY_SENTINEL that must stay on disk";
		writeFileSync(join(directory, "probe.md"), `---\nname: probe\ndescription: a trigger\norder: 10\n---\n${body}`);
		const index = renderPlaybookCatalog(loadRuntimePlaybookCatalog(directory));
		expect(index).toContain("probe.md");
		expect(index).toContain("a trigger");
		expect(index).not.toContain(body);
	});

	it("keeps the documented catalog and runtime-guide references reachable", () => {
		const catalog = loadRuntimePlaybookCatalog();
		const docs = readFileSync(new URL("../docs/runtime-playbooks.md", import.meta.url), "utf-8");
		const rows = [...docs.matchAll(/^\| `([^`]+\.md)` \| (\d+) \| ([^|]+) \|/gm)].map((match) => ({
			filename: match[1],
			order: Number(match[2]),
			requiresAnyTool: [...match[3]!.matchAll(/`([^`]+)`/g)].map((tool) => tool[1]),
		}));
		expect(rows).toEqual(
			catalog.map(({ filename, order, requiresAnyTool }) => ({ filename, order, requiresAnyTool })),
		);
		for (const item of catalog) {
			const body = readFileSync(item.path, "utf-8");
			// Runtime guides use hyphenated names; data files such as output.md are not guides.
			for (const match of body.matchAll(/`([a-z]+(?:-[a-z]+)+\.md)`/g)) {
				expect(existsSync(join(PLAYBOOKS_DIR, match[1]!)), `${item.filename} → ${match[1]}`).toBe(true);
			}
		}
	});

	it("removes retired guides from build output while preserving compiled code", () => {
		const output = makeTempDir();
		const directory = join(output, "playbooks");
		mkdirSync(directory);
		writeFileSync(join(directory, "retired-guide.md"), "old guide");
		writeFileSync(join(directory, "catalog.js"), "compiled code");
		execFileSync(process.execPath, ["scripts/copy-md-assets.mjs", output]);
		expect(
			readdirSync(directory)
				.filter((file) => file.endsWith(".md"))
				.sort(),
		).toEqual(
			readdirSync(PLAYBOOKS_DIR)
				.filter((file) => file.endsWith(".md"))
				.sort(),
		);
		expect(readFileSync(join(directory, "catalog.js"), "utf8")).toBe("compiled code");
	});

	it("validates the published event examples with the real parser and admission rules", () => {
		const body = readFileSync(join(PLAYBOOKS_DIR, "event-scheduling.md"), "utf-8");
		const examples = [...body.matchAll(/```json\n([\s\S]*?)\n```/g)];
		expect(examples.length).toBeGreaterThan(0);
		for (const example of examples) {
			// event_manage supplies channelId and maps the schema's `timeoutMs` onto the on-disk
			// `preAction.timeout` (ms); one-shot timestamps are examples relative to their stated
			// date, not a reason for the test to expire with the wall clock.
			const parsed = JSON.parse(example[1]!) as Record<string, unknown>;
			if (parsed.preAction && typeof parsed.preAction === "object") {
				const pre = parsed.preAction as Record<string, unknown>;
				if (pre.timeoutMs !== undefined) {
					pre.timeout = pre.timeoutMs;
					delete pre.timeoutMs;
				}
			}
			const raw = { channelId: "dm_example", ...parsed };
			const event = parseScheduledEventContent(JSON.stringify(raw), "example.json");
			validateScheduledEvent(event, {
				now: event.type === "one-shot" ? new Date(event.at).getTime() - 600_000 : Date.now(),
				commandGuardConfig: DEFAULT_SECURITY_CONFIG.commandGuard,
			});
		}
	});

	it.each([
		["name: wrong\ndescription: trigger", /metadata name/],
		["name: probe\ndescription: trigger\nrequires-tools: unknown_tool", /unknown tool/],
		["name: probe\ndescription: trigger\norder: -1", /non-negative integer/],
	])("rejects invalid authored metadata: %s", (fields, error) => {
		const directory = makeTempDir();
		writeFileSync(join(directory, "probe.md"), `---\n${fields}\n---\nbody`);
		expect(() => loadRuntimePlaybookCatalog(directory)).toThrow(error);
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
		const playbookPath = join(PLAYBOOKS_DIR, "task-loop.md");
		expect(guardPath(playbookPath, "read", ctx)).toMatchObject({ allowed: true });
		expect(guardPath(playbookPath, "write", ctx)).toMatchObject({ allowed: false });
		expect(guardPath(join(PLAYBOOKS_DIR, "..", "main.ts"), "read", ctx)).toMatchObject({ allowed: false });
	});
});
