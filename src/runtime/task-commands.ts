import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { renderSubcommandUsage } from "../agent/commands.js";
import { channelJobTaskIds } from "../agent/job-manager.js";
import { capReply } from "../agent/reply-limits.js";
import { formatLocalTime, parseLocalTime, parseWakeInput } from "../shared/local-time.js";
import { errorMessage } from "../shared/text-utils.js";
import { channelDelegationTaskIds } from "../subagents/runs.js";
import { applyTaskControlPatch, createDefaultTaskControl, taskBudgetViolation } from "../tasks/control.js";
import {
	countTaskDodItems,
	extractTaskTitle,
	missingStandardTaskSections,
	normalizeTaskId,
	readActiveTasks,
	recurringTaskMissedOccurrence,
	type TaskLedgerEntry,
} from "../tasks/ledger.js";
import { withTaskMutation } from "../tasks/mutation-lock.js";
import { openRecurringTaskCycle, readStoredTask, taskBodyHash, writeStoredTask } from "../tasks/store.js";
import { parseTaskEventName, taskEventPrefix } from "../tasks/task-events.js";
import { nextTaskWake, validateTaskSchedule } from "../tasks/task-schedule.js";
import { normalizeStoredStatus, resolveTaskTransition } from "../tasks/transitions.js";
import { readVerificationAttestation } from "../tasks/verification.js";
import { parseScheduledEventContent, type ScheduledEvent } from "./events.js";

export interface HandleTasksCommandOptions {
	args: string;
	/** The channel directory; tasks live in `<channelDir>/tasks/`. */
	channelDir: string;
	/** Workspace directory; required for `/tasks doctor` because events are workspace-scoped. */
	workspaceDir?: string;
	channelId?: string;
	/** Optional immediate task wake, available in the long-lived DingTalk runtime. */
	dispatchTask?: (id: string) => Promise<boolean>;
}

/**
 * Fields `/tasks set` can edit directly.
 *
 * Deliberately a small, flat set: the ones a user already knows they want to change (when it
 * should wake, what it should do next, how much rope it has). Everything structural — status
 * transitions and verification — stays with `task_manage`, whose state
 * machine those fields belong to. The value is the rest of the line, so it may contain spaces.
 */
const SETTABLE_TASK_FIELDS = ["wake", "next", "deadline"] as const;

/** `/tasks show <id>` head-snippet cap; the full file is always readable at its own path. */
const TASK_SHOW_MAX_CHARS = 4_000;
type SettableTaskField = (typeof SETTABLE_TASK_FIELDS)[number];

type TasksCommand =
	| { action: "list" }
	| { action: "show"; id: string }
	| { action: "archive" }
	| { action: "doctor" }
	| { action: "pause"; id: string }
	| { action: "resume"; id: string }
	| { action: "run"; id: string }
	| { action: "set"; id: string; field: SettableTaskField; value: string };

// Broadcast (subcommand names, args, descriptions, examples) lives once in commands.ts's
// `BUILT_IN_COMMANDS` entry for "tasks"; this just renders it (review 2026-08-24 §3.1).
function usage(): string {
	return renderSubcommandUsage("tasks");
}

/** Exported so `test/commands-subcommands.test.ts` can feed every broadcast example back through it. */
export function parseTasksCommand(args: string): TasksCommand {
	const trimmed = args.trim();
	const parts = trimmed.split(/\s+/).filter(Boolean);
	const action = parts[0];

	if (!action || action === "list") {
		if (parts.length > 1) throw new Error("用法：/tasks list");
		return { action: "list" };
	}
	if (action === "show") {
		const id = parts[1];
		if (!id || parts.length > 2) throw new Error("用法：/tasks show <id>");
		return { action: "show", id };
	}
	if (action === "archive") {
		if (parts.length > 1) throw new Error("用法：/tasks archive");
		return { action: "archive" };
	}
	if (action === "doctor") {
		if (parts.length > 1) throw new Error("用法：/tasks doctor");
		return { action: "doctor" };
	}
	if (action === "pause" || action === "resume") {
		const id = parts[1];
		if (!id || parts.length > 2) throw new Error(`用法：/tasks ${action} <id>`);
		return { action, id };
	}
	if (action === "run") {
		const id = parts[1];
		if (!id || parts.length > 2) throw new Error("用法：/tasks run <id>");
		return { action: "run", id };
	}
	if (action === "set") {
		// Everything after the field name is the value, verbatim — a nextAction is a sentence.
		const match = /^set\s+(\S+)\s+(\S+)\s*([\s\S]*)$/.exec(trimmed);
		const field = match?.[2];
		if (!match || !field || !(SETTABLE_TASK_FIELDS as readonly string[]).includes(field)) {
			throw new Error(`用法：/tasks set <id> <${SETTABLE_TASK_FIELDS.join("|")}> <值>`);
		}
		return {
			action: "set",
			id: match[1],
			field: field as SettableTaskField,
			value: match[3].trim(),
		};
	}
	throw new Error(`未知的 /tasks 动作：${action}`);
}

function tasksDir(channelDir: string): string {
	return join(channelDir, "tasks");
}

/** Resolve `<tasksDir>/[archive/]<id>.md`, rejecting any path that escapes the tasks dir. */
function resolveTaskPath(dir: string, id: string, subdir?: string): string {
	const base = resolve(dir);
	const target = resolve(base, subdir ?? "", `${id}.md`);
	const expected = subdir ? join(base, subdir, `${id}.md`) : join(base, `${id}.md`);
	if (target !== expected || !target.startsWith(`${base}${sep}`)) {
		throw new Error(`Invalid task id: ${id}`);
	}
	return target;
}

function relativeWake(wakeMs: number | undefined, now: number): string {
	if (wakeMs === undefined) return "无唤醒时间";
	const local = formatLocalTime(new Date(wakeMs));
	const diffMs = wakeMs - now;
	if (diffMs <= 0) return `${local}（已到期）`;
	const minutes = Math.round(diffMs / 60000);
	const rel =
		minutes < 60
			? `${minutes}分钟后`
			: minutes < 1440
				? `${Math.round(minutes / 60)}小时后`
				: `${Math.round(minutes / 1440)}天后`;
	return `${local}（${rel}）`;
}

function taskStatusLabel(status: string): string {
	switch (status) {
		case "active":
			return "进行中";
		case "waiting":
			return "等待中";
		case "sleeping":
			return "睡眠中";
		default:
			return status;
	}
}

function verificationStatusLabel(status: string): string {
	switch (status) {
		case "pending":
			return "待验收";
		case "passed":
			return "已通过";
		case "failed":
			return "未通过";
		default:
			return status;
	}
}

interface TaskEventInfo {
	filename: string;
	name: string;
	id?: string;
	use?: string;
	event?: ScheduledEvent;
	error?: string;
}

function eventDir(workspaceDir: string): string {
	return join(workspaceDir, "events");
}

async function readArchivedTaskIds(channelDir: string): Promise<Set<string>> {
	const archiveDir = join(tasksDir(channelDir), "archive");
	const ids = new Set<string>();
	if (!existsSync(archiveDir)) return ids;
	for (const filename of await readdir(archiveDir)) {
		if (filename.endsWith(".md")) ids.add(filename.slice(0, -".md".length));
	}
	return ids;
}

async function readTaskEvents(workspaceDir: string, channelId: string): Promise<TaskEventInfo[]> {
	const dir = eventDir(workspaceDir);
	if (!existsSync(dir)) return [];
	const prefix = taskEventPrefix(channelId);
	const events: TaskEventInfo[] = [];
	for (const filename of (await readdir(dir)).filter((name) => name.endsWith(".json")).sort()) {
		const name = filename.slice(0, -".json".length);
		if (!name.startsWith(prefix)) continue;
		const split = parseTaskEventName(name, channelId);
		const info: TaskEventInfo = { filename, name, ...(split ?? {}) };
		try {
			info.event = parseScheduledEventContent(await readFile(join(dir, filename), "utf-8"), filename);
		} catch (error) {
			info.error = errorMessage(error);
		}
		events.push(info);
	}
	return events;
}

function validWakeMs(entry: TaskLedgerEntry): number | undefined {
	const wake = entry.frontmatter.wake;
	if (!wake) return undefined;
	return parseLocalTime(wake);
}

function issue(problem: string, nextStep: string): string {
	return `- ${problem}（下一步：${nextStep}）`;
}

async function readActiveTaskContent(channelDir: string, id: string): Promise<string | undefined> {
	try {
		return await readFile(join(tasksDir(channelDir), `${id}.md`), "utf-8");
	} catch {
		return undefined;
	}
}

async function listTasks(channelDir: string): Promise<string> {
	const dir = tasksDir(channelDir);
	const now = Date.now();
	const entries = (await readActiveTasks(dir, now)).filter((entry) => !entry.frontmatter.archiveOutcome);
	if (entries.length === 0) {
		return "**任务**\n\n暂无进行中的任务。用 `/tasks archive` 查看已归档任务。";
	}

	const blocks = entries.map((entry) => {
		if (!entry.frontmatter.readable) {
			return `**${entry.id}** — ${entry.title}\n- ⚠ frontmatter 无法读取，status/wake 不可信`;
		}
		const status = entry.frontmatter.status ?? "active";
		const lines = [
			`**${entry.id}** — ${entry.title}`,
			`- 状态：${taskStatusLabel(status)} · 下次唤醒 ${relativeWake(entry.wakeMs, now)}`,
		];
		const control = entry.frontmatter.control;
		if (control) {
			if (control.verification.required)
				lines.push(`- 验收：需要验收，${verificationStatusLabel(control.verification.status)}`);
			if (control.waitingFor) lines.push(`- 等待：${control.waitingFor}`);
			if (control.stop) lines.push(`- 已停用：${control.stop.by} — ${control.stop.reason}`);
			if (control.deadline) lines.push(`- 截止：${control.deadline}`);
			if (control.nextAction) lines.push(`- 下一步：${control.nextAction}`);
			if (control.cycleId) lines.push(`- ${status === "sleeping" ? "上一周期" : "当前周期"}：${control.cycleId}`);
		}
		if (entry.frontmatter.enabled === false) lines.push("- 已停用（enabled: false）");
		if (entry.frontmatter.schedule) {
			lines.push(`- 调度时区：${Intl.DateTimeFormat().resolvedOptions().timeZone}（本机）`);
		}
		return lines.join("\n");
	});
	const footer = "详情 `/tasks show <id>`，体检 `/tasks doctor`";
	const body = `**任务** · ${entries.length} 个进行中\n\n${blocks.join("\n\n")}\n\n${footer}`;
	return capReply(body, { nextStepHint: "用 `/tasks show <id>` 查看单个任务的完整状态" }).text;
}

export async function pauseTask(options: HandleTasksCommandOptions, idInput: string): Promise<string> {
	const id = normalizeTaskId(idInput);
	return withTaskMutation(options.channelDir, id, () => pauseTaskLocked(options, id));
}

async function pauseTaskLocked(options: HandleTasksCommandOptions, id: string): Promise<string> {
	const task = await readStoredTask(options.channelDir, id);
	if (!task) return `找不到任务：${id}`;
	const from = normalizeStoredStatus(task.fields.status);
	try {
		resolveTaskTransition("pause", id, from);
	} catch (error) {
		return errorMessage(error);
	}
	if (task.fields.enabled === false) return `任务 ${id} 已停用。需要继续时用 /tasks resume ${id}。`;
	task.fields.enabled = false;
	const control = task.fields.control ?? createDefaultTaskControl();
	control.stop = { by: "user", reason: "Disabled by /tasks pause.", at: formatLocalTime() };
	task.fields.control = control;
	await writeStoredTask(task);
	return `已停用任务 ${id}。当前阶段与 wake 已保留；需要继续时用 /tasks resume ${id}。`;
}

export async function resumeTask(options: HandleTasksCommandOptions, idInput: string): Promise<string> {
	const id = normalizeTaskId(idInput);
	const task = await readStoredTask(options.channelDir, id);
	if (!task) return `找不到任务：${id}`;
	const from = normalizeStoredStatus(task.fields.status);
	if (task.fields.enabled !== false) return `任务 ${id} 已启用。`;
	resolveTaskTransition("resume", id, from);
	task.fields.enabled = true;
	if (task.fields.control) {
		task.fields.control.stop = undefined;
	}
	await writeStoredTask(task);
	return `已重新启用任务 ${id}，任务驱动器会按当前阶段与 wake 接上。`;
}

/**
 * Edit one task field directly.
 *
 * The alternative — telling the model "change wake to tomorrow 9am" — costs a whole turn and its
 * tokens to reach the same one-line write. Validation is not re-implemented here: `wake` reuses
 * the shared local-time parser (accepting a local timestamp or a relative offset like `+2h`) and
 * everything else goes through `applyTaskControlPatch`, the same function `task_manage set` uses,
 * so the two entry points cannot drift apart.
 */
async function setTaskField(
	options: HandleTasksCommandOptions,
	idInput: string,
	field: SettableTaskField,
	value: string,
): Promise<string> {
	const id = normalizeTaskId(idInput);
	const task = await readStoredTask(options.channelDir, id);
	if (!task) return `找不到任务：${id}`;

	if (field === "wake") {
		if (!value) {
			task.fields.wake = undefined;
		} else {
			const ms = parseWakeInput(value);
			if (ms === undefined) {
				return `wake "${value}" 不是合法的本地时间（如 2026-07-27T07:30:00+08:00）或相对时长（如 +2h）。`;
			}
			task.fields.wake = formatLocalTime(new Date(ms));
		}
	} else {
		const control = task.fields.control ?? createDefaultTaskControl();
		try {
			task.fields.control = applyTaskControlPatch(
				control,
				field === "next" ? { nextAction: value } : { deadline: value },
			);
		} catch (error) {
			return errorMessage(error);
		}
	}

	await writeStoredTask(task);
	return `已更新任务 ${id}：${field} = ${value || "（已清除）"}`;
}

async function runTask(options: HandleTasksCommandOptions, idInput: string): Promise<string> {
	const id = normalizeTaskId(idInput);
	const task = await readStoredTask(options.channelDir, id);
	if (!task) return `找不到任务：${id}`;
	const from = normalizeStoredStatus(task.fields.status);
	try {
		resolveTaskTransition("run", id, from);
	} catch (error) {
		return errorMessage(error);
	}
	const now = new Date();
	if (from === "sleeping") {
		if (!task.fields.schedule) {
			return `任务 ${id} 没有 schedule，不能从 sleeping 打开周期；如需新工作请创建新的 task id。`;
		}
		const opened = await openRecurringTaskCycle(options.channelDir, id, now, true);
		if (!opened) return `任务 ${id} 无法打开新周期；先用 /tasks doctor 检查任务文件。`;
	} else {
		task.fields.status = "active";
		task.fields.wake = undefined;
		task.fields.enabled = true;
		if (task.fields.control) {
			task.fields.control.stop = undefined;
			task.fields.control.waitingFor = undefined;
		}
		await writeStoredTask(task);
	}
	const enqueued = await options.dispatchTask?.(id);
	return enqueued
		? `已把任务 ${id} 排入一次立即执行。`
		: `任务 ${id} 已就绪。启动钉钉守护进程可自动派发，或在本会话里直接发一条普通消息推进它。`;
}

async function showTask(channelDir: string, id: string): Promise<string> {
	const dir = tasksDir(channelDir);
	const taskId = normalizeTaskId(id);
	const activePath = resolveTaskPath(dir, taskId);
	const archivePath = resolveTaskPath(dir, taskId, "archive");

	const path = existsSync(activePath) ? activePath : existsSync(archivePath) ? archivePath : undefined;
	if (!path) {
		return `找不到任务：${taskId}`;
	}
	const location = path === archivePath ? "(已归档)" : "";
	const header = `**任务 ${taskId}**${location}`;
	const content = await readFile(path, "utf-8");
	// The file already lives on disk at `path`; a huge task file (long Plan/DoD history) is shown
	// as a head snippet with a pointer to that existing path instead of dumping it whole (review
	// 2026-08-24 §2.4/§3.2) — no separate copy needs to be written.
	if (content.length <= TASK_SHOW_MAX_CHARS) {
		return `${header}\n\n\`\`\`markdown\n${content}\n\`\`\``;
	}
	const lastNewline = content.lastIndexOf("\n", TASK_SHOW_MAX_CHARS);
	const head = content.slice(0, lastNewline > 0 ? lastNewline : TASK_SHOW_MAX_CHARS).trimEnd();
	return `${header}\n\n\`\`\`markdown\n${head}\n\`\`\`\n\n（内容过长已截断；完整内容见 \`${path}\`）`;
}

async function listArchive(channelDir: string): Promise<string> {
	const dir = join(tasksDir(channelDir), "archive");
	if (!existsSync(dir)) {
		return "**已归档任务**\n\n暂无已归档任务。";
	}
	const filenames = (await readdir(dir)).filter((filename) => filename.endsWith(".md")).sort();
	if (filenames.length === 0) {
		return "**已归档任务**\n\n暂无已归档任务。";
	}
	const blocks: string[] = [];
	for (const filename of filenames) {
		const id = filename.slice(0, -".md".length);
		try {
			const content = await readFile(join(dir, filename), "utf-8");
			blocks.push(`- ${id} — ${extractTaskTitle(content, id)}`);
		} catch {
			blocks.push(`- ${id}`);
		}
	}
	const body = `**已归档任务** · ${blocks.length} 个\n\n${blocks.join("\n")}`;
	return capReply(body, { nextStepHint: "用 `/tasks show <id>` 查看单个已归档任务" }).text;
}

async function doctor(options: HandleTasksCommandOptions): Promise<string> {
	if (!options.workspaceDir || !options.channelId) {
		return "**任务体检**\n\n不可用：需要 workspaceDir 与 channelId。";
	}

	const now = Date.now();
	const entries = await readActiveTasks(tasksDir(options.channelDir), now);
	const activeIds = new Set(entries.map((entry) => entry.id));
	const archivedIds = await readArchivedTaskIds(options.channelDir);
	const events = await readTaskEvents(options.workspaceDir, options.channelId);
	const runningJobTaskIds = channelJobTaskIds(options.channelId);
	const runningDelegationTaskIds = channelDelegationTaskIds(options.channelId);
	const issues: string[] = [];

	for (const entry of entries) {
		const status = entry.frontmatter.status ?? "active";
		if (!entry.frontmatter.readable) {
			issues.push(
				issue(
					`tasks/${entry.id}.md 的 frontmatter 无法读取，wake/status 不可信`,
					`修复 tasks/${entry.id}.md，让它以可读的 status/wake/schedule frontmatter 开头`,
				),
			);
			continue;
		}
		if (entry.frontmatter.controlReadable === false) {
			issues.push(
				issue(
					`tasks/${entry.id}.md 的 control 元数据无效；治理机制 fail-open，但无法生效`,
					`用 task_manage set 或直接修复那一行 control JSON，然后再允许任务运行`,
				),
			);
			continue;
		}

		const control = entry.frontmatter.control;
		if (!control && entry.frontmatter.enabled === false) {
			issues.push(
				issue(
					`tasks/${entry.id}.md 已停用，但完全没有 control.stop 回执`,
					`用 task_manage set 修复 control 元数据，确认可以继续后再 /tasks resume ${entry.id}`,
				),
			);
		}
		if (control) {
			const storedTask = await readStoredTask(options.channelDir, entry.id);
			const violation = taskBudgetViolation(control, now, status as "active" | "waiting" | "sleeping");
			if (violation) {
				issues.push(
					issue(
						`tasks/${entry.id}.md 超出了它的 control 限额：${violation}`,
						`检查这个任务，明确提高 budget/deadline 或取消它；否则 driver 会升级处理`,
					),
				);
			}
			if (status !== "sleeping" && control.verification.status === "passed") {
				const attestationOk = control.verification.runId
					? await readVerificationAttestation(options.channelDir, control.verification.runId)
							.then(
								(attestation) =>
									attestation.taskId === entry.id &&
									attestation.verdict === "pass" &&
									(!storedTask || attestation.bodyHash === taskBodyHash(storedTask.body)),
							)
							.catch(() => false)
					: false;
				if (!attestationOk) {
					issues.push(
						issue(
							`tasks/${entry.id}.md 记录了一次独立 PASS，但磁盘上没有匹配且新鲜的验证 attestation`,
							`跑一次新的 purpose=verify 子代理，并用 task_manage verify 导入它的 attestation 后再完成`,
						),
					);
				}
			}
			if (entry.frontmatter.enabled === false && !control.stop) {
				issues.push(
					issue(
						`tasks/${entry.id}.md 已停用，但 control 里没有 stop 回执`,
						`先弄清是谁停用的，再 /tasks resume ${entry.id}；或者用 task_manage set 写一条合法的 stop 记录`,
					),
				);
			}
			if (entry.frontmatter.enabled !== false && control.stop) {
				issues.push(
					issue(
						`tasks/${entry.id}.md 有 stop 回执，但 enabled 是 true`,
						`跑 /tasks resume ${entry.id} 清掉过期的 stop 回执，或者显式停用这个任务`,
					),
				);
			}
		}

		const recurring = Boolean(entry.frontmatter.schedule);
		if (status === "sleeping" && !recurring) {
			issues.push(
				issue(
					`tasks/${entry.id}.md 处于 sleeping，但没有 recurring schedule`,
					`一次性任务用 task_manage complete/cancel 结束；要保留 sleeping 需要先加一个合法的 schedule`,
				),
			);
		}
		if (recurring) {
			try {
				validateTaskSchedule(entry.frontmatter.schedule!);
			} catch (error) {
				issues.push(
					issue(
						`tasks/${entry.id}.md 的 schedule 无效：${errorMessage(error)}`,
						`修复或清空 ${entry.id} 的 schedule；修复前 driver 会让这个任务保持停用`,
					),
				);
			}
			if (status === "sleeping" && !entry.frontmatter.wake) {
				issues.push(
					issue(
						`tasks/${entry.id}.md 处于 sleeping，但没有 wake`,
						`修复 schedule 和 wake，确认无误后 /tasks resume ${entry.id}`,
					),
				);
			}
		}
		if (
			status === "active" &&
			entry.frontmatter.wake &&
			validWakeMs(entry) !== undefined &&
			validWakeMs(entry)! > now
		) {
			issues.push(
				issue(
					`tasks/${entry.id}.md 处于 active，但它的 wake 在未来`,
					`用 task_manage set/progress 把它改成 waiting 且 waitingFor=time，或者清空 wake 让它现在继续`,
				),
			);
		}
		if (recurringTaskMissedOccurrence({ status, schedule: entry.frontmatter.schedule, control }, new Date(now))) {
			issues.push(
				issue(
					`tasks/${entry.id}.md 有一个已过下次 recurring 时点、仍处于 ${status} 的周期，且没有并行开启新周期`,
					`完成、跳过或取消 ${entry.id} 当前周期，之后让 driver 计算下一次时点`,
				),
			);
		}

		const content = await readActiveTaskContent(options.channelDir, entry.id);
		if (content === undefined) {
			issues.push(
				issue(`tasks/${entry.id}.md 在体检时读取失败`, `手动打开 tasks/${entry.id}.md，修复权限或文件内容`),
			);
		} else {
			const missing = missingStandardTaskSections(content);
			if (missing.length > 0) {
				issues.push(
					issue(
						`tasks/${entry.id}.md 缺少标准分节：${missing.join(", ")}`,
						`让 agent 把 tasks/${entry.id}.md 规范化成标准任务骨架`,
					),
				);
			}

			// spec 037, D4: two deterministic, zero-LLM-cost drift checks between a Plan and its
			// DoD — the first real consumer of "is the plan still pointed at the goal?".
			if (entry.plan) {
				const dodCount = countTaskDodItems(content);
				const invalidRefs = entry.plan.steps.flatMap((step) =>
					step.dodRefs.filter((ref) => ref < 1 || ref > dodCount).map((ref) => `${step.id}→dod:${ref}`),
				);
				if (invalidRefs.length > 0) {
					issues.push(
						issue(
							`tasks/${entry.id}.md 的 Plan 引用了不存在的 DoD 项：${invalidRefs.join(", ")}`,
							`修正 Plan 里的 "→ dod:N" 引用；如果 DoD 列表变了就重新编号`,
						),
					);
				}
				const covered = new Set(
					entry.plan.steps.filter((step) => step.status !== "dropped").flatMap((step) => step.dodRefs),
				);
				const uncovered = Array.from({ length: dodCount }, (_, index) => index + 1).filter(
					(dodIndex) => !covered.has(dodIndex),
				);
				if (dodCount > 0 && uncovered.length > 0) {
					issues.push(
						issue(
							`tasks/${entry.id}.md 有 DoD 项没有 Plan 步骤覆盖：dod:${uncovered.join(",")}`,
							`给某个 Plan 步骤加上或更新 "→ dod:${uncovered[0]}" 引用，或者确认这些 DoD 项确实不需要专门的步骤`,
						),
					);
				}
			}
		}

		// A waiting task resumes only via a real durable source: a valid wake (the driver's timed
		// reactivation) or an actually-running background job/delegation recorded against this
		// id — never by what `waitingFor` merely claims, which is model-written display text and
		// no longer gates anything. With neither, resumption is entirely up to the user —
		// legitimate when waiting on an answer, and indistinguishable, on disk, from a task
		// everyone has forgotten. Report the fact and name every way out.
		if (status === "waiting") {
			const hasDurableWake = Boolean(entry.frontmatter.wake) && validWakeMs(entry) !== undefined;
			const hasRunningSource = runningJobTaskIds.has(entry.id) || runningDelegationTaskIds.has(entry.id);
			if (!hasDurableWake && !hasRunningSource) {
				issues.push(
					issue(
						`tasks/${entry.id}.md 处于 waiting，且没有可靠的恢复方式（没有合法 wake，也没有记录在案的运行中 job/委派）`,
						`它只能靠你回复、跑 /tasks run ${entry.id}，或者用 /tasks set ${entry.id} wake <本地时间或 +2h> 给它一个 wake 才能恢复；如果等待的东西已经不存在了就取消它`,
					),
				);
			}
		}

		if (entry.frontmatter.wake && validWakeMs(entry) === undefined) {
			issues.push(
				issue(
					`tasks/${entry.id}.md 的 wake 值无效（${entry.frontmatter.wake}）；原生 driver 会把它当成已到期处理`,
					`用 task_manage set 或 progress 把 wake 换成合法本地时间，或者清空它让任务直接继续`,
				),
			);
		}

		// A recurring task's wake should always be an occurrence of its own schedule. A wake that
		// isn't — a stale value left over from a since-changed cron, or a hand-typed local↔UTC
		// slip — silently misses the intended cadence: this is exactly how a production wake got
		// left pointing at a day the cron never fires on (spec 037).
		const schedule = entry.frontmatter.schedule;
		if (recurring && schedule && entry.frontmatter.wake) {
			const wakeMs = validWakeMs(entry);
			if (wakeMs !== undefined) {
				const priorOccurrence = nextTaskWake(schedule, new Date(wakeMs - 1));
				if (priorOccurrence?.getTime() !== wakeMs) {
					issues.push(
						issue(
							`tasks/${entry.id}.md 的 wake（${formatLocalTime(new Date(wakeMs))}）不是它 schedule "${schedule}" 的一个合法时点`,
							`跑 task_manage set schedule="${schedule}"（不变）用 cron 重新计算 wake，或者手动明确设置 wake`,
						),
					);
				}
			}
		}
	}

	for (const event of events) {
		if (!event.id || !event.use) {
			issues.push(
				issue(
					`events/${event.filename} 不符合 task.<channelId>.<taskId>.<use>.json 命名`,
					"把这个事件改名为任务专用命名约定，或者当作普通事件管理",
				),
			);
			continue;
		}
		if (event.error) {
			issues.push(
				issue(
					`events/${event.filename} 无法解析：${event.error}`,
					`修复或删除 events/${event.filename}；无效的任务专属事件不可信`,
				),
			);
			continue;
		}
		if (!activeIds.has(event.id) && !archivedIds.has(event.id)) {
			issues.push(
				issue(
					`events/${event.filename} 指向了不存在的任务 ${event.id}`,
					`删除 events/${event.filename}；如果那个任务在概念上还存在，就重新创建 tasks/${event.id}.md`,
				),
			);
			continue;
		}
		if (archivedIds.has(event.id)) {
			issues.push(
				issue(
					`events/${event.filename} 指向了已归档任务 ${event.id}；已关闭的任务不应该还有存活的事件`,
					`删除 events/${event.filename}；已归档任务不应该唤醒 agent`,
				),
			);
		}
	}

	if (issues.length === 0) {
		return "**任务体检**\n\n未发现任务台账问题。";
	}
	const body = `**任务体检** · 发现 ${issues.length} 个问题\n\n${issues.join("\n")}`;
	return capReply(body, { nextStepHint: "先处理靠前的问题，再重新运行 `/tasks doctor`" }).text;
}

export async function handleTasksCommand(options: HandleTasksCommandOptions): Promise<string> {
	let command: TasksCommand;
	try {
		command = parseTasksCommand(options.args);
	} catch (error) {
		const message = errorMessage(error);
		return `${message}\n\n${usage()}`;
	}

	try {
		if ("id" in command && command.id && command.action !== "show") {
			return await withTaskMutation(options.channelDir, command.id, () => dispatchTasksCommand(options, command));
		}
		return await dispatchTasksCommand(options, command);
	} catch (error) {
		const message = errorMessage(error);
		return `执行 /tasks ${command.action} 失败：${message}`;
	}
}

async function dispatchTasksCommand(options: HandleTasksCommandOptions, command: TasksCommand): Promise<string> {
	switch (command.action) {
		case "list":
			return await listTasks(options.channelDir);
		case "show":
			return await showTask(options.channelDir, command.id);
		case "archive":
			return await listArchive(options.channelDir);
		case "pause":
			return await pauseTask(options, command.id);
		case "resume":
			return await resumeTask(options, command.id);
		case "run":
			return await runTask(options, command.id);
		case "set":
			return await setTaskField(options, command.id, command.field, command.value);
		case "doctor":
			return await doctor(options);
	}
}
