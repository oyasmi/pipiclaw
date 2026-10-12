import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPipiclawSystemPrompt } from "../src/agent/prompt/builder.js";
import { renderContextReport } from "../src/agent/prompt/manifest.js";
import { renderStatus } from "../src/agent/status-render.js";
import { renderTurnErrorReply } from "../src/agent/turn-error.js";
import type { AgentRunner } from "../src/agent/types.js";
import { BUILT_IN_COMMANDS, formatBusyHint, renderBuiltInHelp, SESSION_COMMANDS } from "../src/commands/catalog.js";
import { handleEventsCommand } from "../src/events/event-commands.js";
import { handleMemoryCommand } from "../src/memory/commands.js";
import { applyMemoryOps } from "../src/memory/store.js";
import { loadRuntimePlaybookCatalog, selectRuntimePlaybooks } from "../src/playbooks/catalog.js";
import { type DurableDispatchRecord, renderDispatchExhaustedNotice } from "../src/runtime/durable-dispatch.js";
import { handleProjectCommand } from "../src/runtime/project-commands.js";
import { handleSkillsCommand } from "../src/runtime/skill-commands.js";
import { handleSubagentsCommand, renderRunNotice } from "../src/runtime/subagent-commands.js";
import { handleTasksCommand } from "../src/runtime/task-commands.js";
import { createTaskDriverEvent, taskStopReceipt } from "../src/runtime/task-driver.js";
import { renderGuardBlockForUser } from "../src/security/block-message.js";
import type { RunRecord, SubAgentRunManager } from "../src/subagents/runs.js";
import { createUsage } from "../src/tasks/budget.js";
import type { TaskLedgerEntry } from "../src/tasks/ledger.js";
import { renderStandardTaskBody, renderTaskDocument } from "../src/tasks/ledger.js";
import { appendTaskLog, resetTaskLogAppenders } from "../src/tasks/log.js";
import { TOOL_NAMES } from "../src/tools/registry.js";
import type { UsageLedger } from "../src/usage/ledger.js";
import { renderUsageReport } from "../src/usage/render.js";
import { useTempDirs } from "./helpers/fixtures.js";

/**
 * Spec 053 D13: the user-copy conventions (AGENTS.md "User-Facing Copy Conventions") pinned as
 * structure, never as wording. Every report handler and runtime push renderer is fed a large
 * fixture; a failure here means a convention was actually broken — a reply over budget with no
 * next step, an indented sub-field DingTalk will flatten, a `#` heading, a prompt tag or a model
 * tool name in the chat — not that someone reworded a sentence.
 */

const tempDir = useTempDirs("pipiclaw-copy-shape-");
afterEach(resetTaskLogAppenders);

/** capReply's budget plus room for its own truncation note. */
const MAX_REPLY_CHARS = 1_500 + 200;

/**
 * Model tools a user cannot call; they must never be the subject of a user-facing sentence.
 * `skill` is left out: it is also the product's own word for the thing `/skills` lists.
 */
const MODEL_TOOL_NAMES = Array.from(TOOL_NAMES)
	.concat("subagent", "subagent_inline")
	.filter((name) => name !== "skill");

/** Content inside fenced code blocks is quoted data (a JSON event, a stderr tail), not copy. */
function withoutFences(text: string): string {
	return text.replace(/^```[\s\S]*?^```/gm, "");
}

function withoutInlineCode(text: string): string {
	return text.replace(/`[^`\n]*`/g, "");
}

interface ShapeOptions {
	/** `/context detail` *is* the tool inventory, so tool names are its data there. */
	allowToolNames?: boolean;
}

function expectUserCopyShape(label: string, text: string, options: ShapeOptions = {}): void {
	expect(text.length, `${label}: over the reply budget`).toBeLessThanOrEqual(MAX_REPLY_CHARS);
	if (text.includes("内容过长已截断")) {
		// Truncated: the note must hand over a command or a path, not just stop.
		expect(text, `${label}: truncated without a next step`).toMatch(/已截断；[^）]*`\//);
	}
	const prose = withoutFences(text);
	for (const line of prose.split("\n")) {
		expect(line, `${label}: indented continuation line`).not.toMatch(/^ {2,}\S|^\t/);
		expect(line, `${label}: markdown heading`).not.toMatch(/^#/);
	}
	// Usage placeholders (`/tasks show <id>`) live in inline code; a bare `<tag>` in prose is a prompt tag.
	expect(withoutInlineCode(prose), `${label}: prompt tag`).not.toMatch(/<[a-z_]+>/);
	expect(prose, `${label}: call syntax or producer tag`).not.toMatch(/\bop=|TASK_DRIVER|\[REDELIVERY/);
	if (!options.allowToolNames) {
		const words = withoutInlineCode(prose);
		for (const name of MODEL_TOOL_NAMES) {
			expect(words, `${label}: tool name "${name}"`).not.toMatch(new RegExp(`(?<![\\w/.-])${name}(?![\\w/.-])`));
		}
	}
}

async function seedTasks(channelDir: string): Promise<void> {
	const tasksDir = join(channelDir, "tasks");
	await mkdir(join(tasksDir, "archive"), { recursive: true });
	const longGoal = `${"把季度报表的每一张表都核对一遍，并记录差异。".repeat(40)}`;
	const body = renderStandardTaskBody({
		title: "Quarterly",
		goal: longGoal,
		dod: Array.from({ length: 30 }, (_, i) => `- [ ] 第 ${i + 1} 项验收`).join("\n"),
		items: Array.from({ length: 12 }, (_, i) => ({ text: `工作项 ${i + 1}：${"细节".repeat(20)}` })),
	});
	for (let index = 0; index < 50; index++) {
		await writeFile(
			join(tasksDir, `task-${index}.md`),
			renderTaskDocument(
				{
					state: index % 2 ? "parked" : "open",
					usage: { ...createUsage(), steps: index, usd: index / 3 },
					...(index % 2
						? { ticket: { kind: "ask" as const, asked: "要合并到 master 吗？", by: "2099-01-01T00:00:00+08:00" } }
						: {}),
					...(index % 5 === 0
						? { paused: { by: "runtime" as const, reason: "已用满 60 步", at: "2026-10-01T00:00:00+08:00" } }
						: {}),
				},
				body,
			),
		);
	}
	for (let index = 0; index < 30; index++) {
		await appendTaskLog(channelDir, "task-0", {
			kind: "dispatch",
			ref: `run_${index}`,
			item: `W${(index % 12) + 1}`,
			agent: "builder",
			purpose: index % 4 ? "work" : "verify",
		});
		await appendTaskLog(channelDir, "task-0", {
			kind: "settle",
			ref: `run_${index}`,
			item: `W${(index % 12) + 1}`,
			status: index % 3 ? "completed" : "failed",
			verdict: index % 4 ? undefined : "fail",
			exitCode: index % 3 ? 0 : 1,
			output: `/tmp/runs/run_${index}/output.md`,
		});
		await appendTaskLog(channelDir, "task-0", {
			kind: "step",
			seq: index + 1,
			outcome: index % 2 ? "park" : "continue",
			note: `第 ${index + 1} 步：${"检查并记录。".repeat(30)}\n第二行`,
			tools: ["read"],
			report: index % 5 ? undefined : "向用户汇报了进度",
		});
	}
	for (let index = 0; index < 30; index++) {
		await writeFile(
			join(tasksDir, "archive", `old-${index}.md`),
			renderTaskDocument({ state: "done", outcome: "completed", closedAt: "2026-09-01T10:00:00.000+08:00" }, body),
		);
	}
}

function runRecord(index: number): RunRecord {
	return {
		runId: `run_${String(index).padStart(6, "0")}`,
		channelId: "dm_1",
		runtime: "external",
		harness: "claude-code",
		agent: `builder-${index % 3}`,
		label: `修复第 ${index} 个问题，${"并补充测试".repeat(10)}`,
		source: "predefined",
		tools: [],
		purpose: index % 4 ? "work" : "verify",
		taskId: index % 2 ? "task-0" : undefined,
		workingDirectory: "/home/me/project",
		artifactDir: `/tmp/runs/run_${index}`,
		status: index < 5 ? "running" : index % 3 ? "completed" : "failed",
		startedAt: Date.now() - 600_000,
		finishedAt: index < 5 ? undefined : Date.now() - 60_000,
		failureReason: index % 3 ? undefined : `exit 1: ${"stack trace line\n".repeat(30)}`,
		verificationVerdict: index % 4 ? undefined : "fail",
		usage: {
			input: 1000,
			output: 500,
			cacheRead: 0,
			cacheWrite: 0,
			total: 1500,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.12 },
		},
		usageKnown: true,
		costKnown: true,
		argv: ["claude", "-p", "x".repeat(2_000)],
		sessionId: "sess-1",
		invocationWarnings: ["model override ignored"],
		parserVersion: 2,
		cliVersion: "1.2.3",
	} as RunRecord;
}

function fakeRunManager(records: RunRecord[]): SubAgentRunManager {
	return {
		list: () => records,
		resolveRef: (ref: string) => {
			const record = records.find((candidate) => candidate.runId === ref);
			return record ? { kind: "found", record } : { kind: "not_found" };
		},
		cancel: async () => "running",
	} as unknown as SubAgentRunManager;
}

describe("user-facing copy shape (spec 053, D13)", () => {
	it("keeps every /tasks report in shape and inside the budget", async () => {
		const channelDir = tempDir();
		await seedTasks(channelDir);
		for (const args of ["", "show task-0", "log task-0", "archive", "doctor", "show missing", "bogus"]) {
			expectUserCopyShape(`/tasks ${args}`, await handleTasksCommand({ args, channelDir }));
		}
		// Empty state, too.
		expectUserCopyShape("/tasks (empty)", await handleTasksCommand({ args: "", channelDir: tempDir() }));
	});

	it("keeps every /subagents report in shape and inside the budget", async () => {
		const records = Array.from({ length: 200 }, (_, index) => runRecord(index));
		const runManager = fakeRunManager(records);
		const artifactDir = tempDir();
		writeFileSync(join(artifactDir, "stderr.log"), "  indented stderr line\n".repeat(200));
		writeFileSync(join(artifactDir, "output.md"), "# Output\n\n  indented output\n".repeat(400));
		records[9] = { ...runRecord(9), artifactDir };
		for (const args of [
			"",
			"list running",
			"list failed",
			"list all",
			`show ${records[9].runId}`,
			`output ${records[9].runId}`,
			"show run_nope",
			"cancel all",
		]) {
			expectUserCopyShape(
				`/subagents ${args}`,
				await handleSubagentsCommand({ args, runManager, channelId: "dm_1" }),
			);
		}
	});

	it("keeps /memory, /events, /skills and /project in shape", async () => {
		const channelDir = tempDir();
		const workspaceDir = tempDir();
		const appHomeDir = tempDir();
		await applyMemoryOps(
			channelDir,
			Array.from({ length: 60 }, (_, index) => ({
				op: "add" as const,
				name: `fact-${index}`,
				type: "project" as const,
				description: `第 ${index} 条事实：${"背景说明".repeat(10)}`,
				body: "# 细节\n\n  缩进的正文\n- 条目",
				source: "user" as const,
				...(index % 3 ? {} : { expires: "2099-01-01" }),
			})),
		);
		for (const args of ["status", "list", "list project", "show fact-1", "journal", "forget nope", "bogus"]) {
			expectUserCopyShape(`/memory ${args}`, await handleMemoryCommand({ channelId: "dm_1", channelDir, args }));
		}

		mkdirSync(join(workspaceDir, "events"), { recursive: true });
		for (let index = 0; index < 50; index++) {
			const event =
				index % 7 === 0
					? { type: "periodic", channelId: "dm_1", schedule: "* * * * *", text: "too often" }
					: { type: "periodic", channelId: "dm_1", schedule: "0 9 * * 1", text: `周报 ${"内容".repeat(30)}` };
			writeFileSync(join(workspaceDir, "events", `event-${index}.json`), JSON.stringify(event));
		}
		writeFileSync(join(workspaceDir, "events", "broken.json"), "{ not json");
		const historyPath = join(appHomeDir, "history.jsonl");
		writeFileSync(
			historyPath,
			Array.from({ length: 100 }, (_, index) =>
				JSON.stringify({
					ts: "2026-10-11T14:02:00.000+08:00",
					eventName: `event-${index % 50}`,
					eventPath: "/x",
					eventType: "periodic",
					action: "enqueued",
					result: "ok",
					reason: "channel queue full\n  at somewhere",
				}),
			).join("\n"),
		);
		for (const args of ["list", "show event-1", "history", "history event-1", "show nope", "bogus"]) {
			expectUserCopyShape(`/events ${args}`, await handleEventsCommand({ args, workspaceDir, historyPath }));
		}

		for (let index = 0; index < 30; index++) {
			const dir = join(workspaceDir, "skills", `skill-${index}`);
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, "SKILL.md"),
				`---\nname: skill-${index}\ndescription: ${"做一件事".repeat(10)}\n---\n\n# Steps\n\n  1. indented\n${"正文。".repeat(400)}`,
			);
		}
		for (const args of ["", "show skill-1", "show nope"]) {
			expectUserCopyShape(`/skills ${args}`, await handleSkillsCommand({ args, workspaceDir, appHomeDir }));
		}
		expectUserCopyShape(
			"/skills (empty)",
			await handleSkillsCommand({ args: "", workspaceDir: tempDir(), appHomeDir }),
		);

		expectUserCopyShape(
			"/project",
			await handleProjectCommand({
				args: "",
				channelId: "dm_1",
				channelDir,
				appHomeDir,
				actor: "dingtalk-command",
				isBusy: () => false,
				listActiveBlockers: () => [],
			}),
		);
	});

	it("keeps /help, /status, /usage and /context in shape", async () => {
		expectUserCopyShape("/help", renderBuiltInHelp());
		for (const command of [...BUILT_IN_COMMANDS, ...SESSION_COMMANDS]) {
			expectUserCopyShape(`/help ${command.name}`, renderBuiltInHelp(command.name));
		}

		const runner = {
			isBusy: () => true,
			getTurnStatus: () => ({ taskText: "x".repeat(500) }),
			getStatusSnapshot: () => ({
				model: "anthropic/claude",
				thinkingLevel: "medium",
				contextTokens: 120_000,
				contextWindow: 200_000,
				fallback: { primary: "anthropic/claude", cooldownUntilMs: Date.now() + 60_000 },
			}),
		} as unknown as AgentRunner;
		expectUserCopyShape("/status", renderStatus({ runner, version: "1.0.0", uptimeMs: 90_061_000 }));

		const summary = {
			entryCount: 3,
			totalCost: 1.5,
			totalTokens: 12_000,
			byKind: { turn: 1, subagent: 0.5 },
			byModel: { "a/b": 1.5 },
			byChannel: { dm_1: 1.5 },
			unknownCostCount: 1,
			unknownUsageCount: 0,
		};
		const ledger = { summarize: async () => summary } as unknown as UsageLedger;
		for (const mode of ["default", "7d", "month"] as const) {
			expectUserCopyShape(`/usage ${mode}`, await renderUsageReport(ledger, "dm_1", mode, new Date()));
		}

		const toolNames = Array.from(TOOL_NAMES);
		const tools = toolNames.map((name) => ({ name, description: `${name} description` }));
		const build = buildPipiclawSystemPrompt({
			tools,
			playbooks: selectRuntimePlaybooks(loadRuntimePlaybookCatalog(), toolNames),
			subAgents: [],
		});
		const skills = Array.from({ length: 60 }, (_, index) => ({ name: `skill-${index}`, description: "d" }));
		for (const detail of [false, true]) {
			expectUserCopyShape(
				`/context${detail ? " detail" : ""}`,
				renderContextReport({
					build,
					finalPrompt: build.text,
					skills,
					toolNames,
					toolSchemas: { chars: 90_000, units: 9_000 },
					detail,
				}),
				{ allowToolNames: detail },
			);
		}
	});

	it("keeps runtime pushes in shape: receipts, notices, refusals and error bubbles", () => {
		const entry: TaskLedgerEntry = {
			id: "weekly",
			title: "周报",
			fields: { state: "parked", usage: { ...createUsage(), steps: 60 } },
			readable: true,
			legacy: false,
			runnable: true,
			expired: false,
		};
		for (const breach of ["steps", "usd", undefined] as const) {
			expectUserCopyShape(`stop receipt ${breach}`, taskStopReceipt("dm_1", entry, "已用满 60 步", 0, breach).text);
		}
		for (const status of ["completed", "failed", "cancelled", "lost"] as const) {
			expectUserCopyShape(
				`run notice ${status}`,
				renderRunNotice({ kind: "settled", runId: "run_a1", agent: "builder", status, durationMs: 192_000 }) ?? "",
			);
		}
		expectUserCopyShape(
			"run notice stalled",
			renderRunNotice({
				kind: "stalled",
				runId: "run_a1",
				agent: "builder",
				durationMs: 900_000,
				silentMs: 660_000,
			}) ?? "",
		);
		const wake = createTaskDriverEvent("dm_1", entry, 0);
		const record: DurableDispatchRecord = {
			version: 1,
			id: wake.dispatchId as string,
			createdAt: "",
			status: "exhausted",
			event: wake,
			deliveries: 8,
		};
		expectUserCopyShape(
			"dispatch exhausted",
			renderDispatchExhaustedNotice(record, "/home/u/.pipiclaw/state/dispatch"),
		);
		for (const guard of [
			{
				guard: "path" as const,
				category: "outside-allowed-roots",
				target: "/etc/passwd",
				operation: "write" as const,
			},
			{ guard: "command" as const, category: "destructive-file-op", target: `rm -rf /\n${"x".repeat(300)}` },
			{ guard: "network" as const, category: "private-address", target: "http://10.0.0.1/" },
			{ guard: "network" as const, category: "dns-failure", target: "http://nope.invalid/" },
		]) {
			expectUserCopyShape(`guard ${guard.category}`, renderGuardBlockForUser(guard));
		}
		for (const message of ["401 invalid x-api-key", "429 rate_limit_error", "boom\n  at stack", "x".repeat(5_000)]) {
			expectUserCopyShape(
				`turn error ${message.slice(0, 20)}`,
				renderTurnErrorReply({ errorMessage: message, compactionError: "ECONNRESET", fallbackRef: "a/b" }),
			);
		}
		expectUserCopyShape("busy hint", formatBusyHint());
	});
});
