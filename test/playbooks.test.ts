import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPipiclawSystemPrompt, RUNTIME_PROMPT_TARGET_UNITS } from "../src/agent/prompt/builder.js";
import type { PromptBuildContext } from "../src/agent/prompt/types.js";
import { parseScheduledEventContent } from "../src/events/parse.js";
import { validateScheduledEvent } from "../src/events/validation.js";
import { PLAYBOOKS_DIR } from "../src/paths.js";
import { loadRuntimePlaybookCatalog, renderPlaybookCatalog, selectRuntimePlaybooks } from "../src/playbooks/catalog.js";
import { DEFAULT_SECURITY_CONFIG } from "../src/security/config.js";
import { guardPath } from "../src/security/path-guard.js";
import { countPromptUnits } from "../src/shared/prompt-units.js";
import { TOOL_NAMES } from "../src/tools/registry.js";
import { useTempDirs } from "./helpers/fixtures.js";

// Derived from the registry (spec 046 D6's fix, generalized): a hand-maintained list drifts
// silently — it previously still listed the retired `skill_manage` and the pre-split
// `task_manage` — and a stale fixture here would make selectRuntimePlaybooks's gating "pass"
// against tool names that no longer exist.
const ALL_TOOLS = Array.from(TOOL_NAMES);
const TASK_TOOLS = [
	"task_list",
	"task_create",
	"task_close",
	"task_log",
	"task_message",
	"task_pause",
	"task_resume",
	"task_report",
	"task_ask",
	"task_wait",
];

const makeTempDir = useTempDirs("pipiclaw-playbooks-");

function markdownFiles(directory: string): string[] {
	return readdirSync(directory)
		.filter((file) => file.endsWith(".md"))
		.sort();
}

describe("runtime playbook catalog", () => {
	it("offers a playbook only when a tool can reach the mechanism it documents", () => {
		const catalog = loadRuntimePlaybookCatalog(TOOL_NAMES);
		expect(selectRuntimePlaybooks(catalog, []).map((item) => item.filename)).toContain("runtime-orientation.md");

		const withoutTasks = selectRuntimePlaybooks(
			catalog,
			ALL_TOOLS.filter((tool) => !TASK_TOOLS.includes(tool) && tool !== "subagent" && tool !== "subagent_inline"),
		).map((item) => item.filename);
		expect(withoutTasks).toContain("runtime-orientation.md");
		expect(withoutTasks.filter((name) => name.startsWith("task-"))).toEqual([]);
		expect(withoutTasks).not.toContain("agent-delegation.md");

		expect(selectRuntimePlaybooks(catalog, ALL_TOOLS)).toHaveLength(catalog.length);
		expect(selectRuntimePlaybooks(catalog, ["subagent"]).map((item) => item.filename)).toContain(
			"agent-delegation.md",
		);
		// A chat manager must not pay for the step protocol, or a task for chat-only controls.
		for (const [taskTool, expected] of [
			["task_create", ["task-manage"]],
			["task_report", ["task-lead", "task-verify", "task-recovery"]],
		] as const) {
			const names = selectRuntimePlaybooks(catalog, [taskTool])
				.map((item) => item.name)
				.filter((name) => name.startsWith("task-"));
			expect(names).toEqual(expected);
		}
		const documented = [
			...readFileSync("docs/runtime-playbooks.md", "utf8").matchAll(/^\| `([^`]+\.md)` \| (\d+) \| ([^|]+) \|/gm),
		].map(([, filename, order, tools]) => ({
			filename,
			order: Number(order),
			requiresAnyTool: [...tools!.matchAll(/`([^`]+)`/g)].map((match) => match[1]),
		}));
		expect(documented).toEqual(
			catalog.map(({ filename, order, requiresAnyTool }) => ({ filename, order, requiresAnyTool })),
		);
	});

	it("renders a compact index without loading playbook bodies into the prompt", () => {
		const directory = makeTempDir();
		const body = "UNIQUE_BODY_SENTINEL that must stay on disk";
		writeFileSync(join(directory, "probe.md"), `---\nname: probe\ndescription: a trigger\norder: 10\n---\n${body}`);
		const index = renderPlaybookCatalog(loadRuntimePlaybookCatalog(TOOL_NAMES, directory));
		expect(index).toContain("probe.md");
		expect(index).toContain("a trigger");
		expect(index).not.toContain(body);
		const taskLead = readFileSync(join(PLAYBOOKS_DIR, "task-lead.md"), "utf8");
		expect(countPromptUnits(taskLead)).toBeLessThanOrEqual(800);
		expect(taskLead).toContain("](task-verify.md)");
		// Splitting a guide must not leave an unreadable link to another playbook.
		for (const file of markdownFiles(PLAYBOOKS_DIR)) {
			const text = readFileSync(join(PLAYBOOKS_DIR, file), "utf8");
			for (const [, target] of text.matchAll(/\]\(([^)]+\.md)(?:#[^)]*)?\)/g)) {
				const path = resolve(PLAYBOOKS_DIR, file, "..", target!);
				expect(path.startsWith(`${PLAYBOOKS_DIR}/`), `${file}: ${target}`).toBe(true);
				expect(existsSync(path), `${file}: ${target}`).toBe(true);
			}
		}
	});

	it("removes retired guides from build output while preserving compiled code", () => {
		const output = makeTempDir();
		const directory = join(output, "playbooks");
		mkdirSync(directory);
		writeFileSync(join(directory, "retired-guide.md"), "old guide");
		writeFileSync(join(directory, "runtime-orientation.md"), "old instructions");
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
		for (const file of readdirSync(PLAYBOOKS_DIR).filter((file) => file.endsWith(".md"))) {
			expect(readFileSync(join(directory, file), "utf8")).toBe(readFileSync(join(PLAYBOOKS_DIR, file), "utf8"));
		}
	});

	it("validates the published event examples with the real parser and admission rules", () => {
		const body = markdownFiles(PLAYBOOKS_DIR)
			.filter((file) => basename(file).startsWith("event-"))
			.map((file) => readFileSync(join(PLAYBOOKS_DIR, file), "utf8"))
			.join("\n");
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
			const raw = { channelId: "dingtalk:dm:example", ...parsed };
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
		expect(() => loadRuntimePlaybookCatalog(TOOL_NAMES, directory)).toThrow(error);
	});
});

function promptContext(names: string[]): PromptBuildContext {
	return {
		tools: names.map((name) => ({ name, description: `${name} description` })),
		playbooks: selectRuntimePlaybooks(loadRuntimePlaybookCatalog(TOOL_NAMES), names),
		subAgents: [
			{ name: "reviewer", description: "Reviews a diff", runtime: "internal", workload: "light", mutates: "read" },
		],
	};
}

describe("system prompt structure", () => {
	it("keeps chat and task instructions within budget and points to guides available in that profile", () => {
		const taskOnly = ["task_report", "task_ask", "task_wait"];
		const chatOnly = [
			"task_create",
			"task_list",
			"task_message",
			"task_pause",
			"task_resume",
			"memory_save",
			"event_manage",
		];
		for (const [names, guide] of [
			[ALL_TOOLS, "task-manage.md"],
			[ALL_TOOLS.filter((name) => !taskOnly.includes(name)), "task-manage.md"],
			[ALL_TOOLS.filter((name) => !chatOnly.includes(name)), "task-lead.md"],
		] as const) {
			const build = buildPipiclawSystemPrompt(promptContext(names));
			const ids = build.sections.map((section) => section.id);
			expect(new Set(ids).size).toBe(ids.length);
			expect(build.runtimeAuthoredUnits).toBeLessThanOrEqual(RUNTIME_PROMPT_TARGET_UNITS);
			expect(build.diagnostics.filter((diagnostic) => diagnostic.level !== "info")).toEqual([]);
			const section = (id: string) => build.sections.find((item) => item.id === id)?.content;
			expect(section("runtime.tasks")).toContain(guide);
			expect(section("playbooks")).toContain(guide);
			expect(section("subagents")).not.toContain("task-lead.md");
			if (guide === "task-lead.md") {
				expect(section("runtime.identity")).toContain("task_report");
				expect(build.text).not.toContain("task-manage.md");
			}
		}
	});

	it("drops a mechanism's whole surface when its tool is off", () => {
		const build = buildPipiclawSystemPrompt(promptContext(["read", "bash", "grep"]));

		expect(build.sections.some((section) => section.id === "runtime.tasks")).toBe(false);
		expect(build.sections.some((section) => section.id === "subagents")).toBe(false);
		expect(build.text).not.toContain("agent-delegation.md");
		expect(build.text).not.toContain("task-lead.md");
		expect(build.text).not.toContain("memory-operations.md");
		// The memory invariant is gated on the tool being registered, like the rest.
		expect(build.text).not.toContain("`memory_save`");
		expect(build.text).toContain("runtime-orientation.md");
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
			cwd: workspaceDir,
			config: DEFAULT_SECURITY_CONFIG.pathGuard,
		};
	}

	it("allows reading playbooks outside workspace/home/temp but never writing them", () => {
		const ctx = createCtx();
		const playbookPath = join(PLAYBOOKS_DIR, "task-lead.md");
		expect(guardPath(playbookPath, "read", ctx)).toMatchObject({ allowed: true });
		expect(guardPath(playbookPath, "write", ctx)).toMatchObject({ allowed: false });
		expect(guardPath(join(PLAYBOOKS_DIR, "..", "main.ts"), "read", ctx)).toMatchObject({ allowed: false });
	});
});
