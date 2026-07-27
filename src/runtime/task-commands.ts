import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { channelJobTaskIds } from "../agent/job-manager.js";
import { parseTaskEventName, taskEventPrefix } from "../shared/task-events.js";
import {
	extractTaskTitle,
	isTaskParked,
	missingStandardTaskSections,
	normalizeTaskId,
	readActiveTasks,
	type TaskLedgerEntry,
} from "../shared/task-ledger.js";
import { errorMessage } from "../shared/text-utils.js";
import { isRecord } from "../shared/type-guards.js";
import {
	applyTaskControlPatch,
	createDefaultTaskControl,
	retiredTaskControlKeys,
	TASK_PRIORITIES,
	type TaskControl,
	type TaskPriority,
	taskBudgetViolation,
} from "../tasks/control.js";
import {
	claimTaskAttempt,
	readStoredTask,
	releaseTaskAttemptClaim,
	taskBodyHash,
	writeStoredTask,
} from "../tasks/store.js";
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
	/** Direct command issuer; used to create an auditable external-action approval. */
	approver?: string;
	/** Optional immediate task wake, available in the long-lived DingTalk runtime. */
	dispatchTask?: (id: string) => Promise<boolean>;
}

/**
 * Fields `/tasks set` can edit directly.
 *
 * Deliberately a small, flat set: the ones a user already knows they want to change (when it
 * should wake, what it should do next, how much rope it has). Everything structural — status
 * transitions, verification, approval, side effects — stays with `task_manage`, whose state
 * machine those fields belong to. The value is the rest of the line, so it may contain spaces.
 */
const SETTABLE_TASK_FIELDS = ["wake", "next", "priority", "attempts", "deadline"] as const;
type SettableTaskField = (typeof SETTABLE_TASK_FIELDS)[number];

type TasksCommand =
	| { action: "list" }
	| { action: "show"; id: string }
	| { action: "archive" }
	| { action: "doctor" }
	| { action: "approve"; id: string }
	| { action: "pause"; id: string }
	| { action: "resume"; id: string }
	| { action: "run"; id: string }
	| { action: "set"; id: string; field: SettableTaskField; value: string }
	| { action: "stats"; id?: string };

function usage(): string {
	return `# 任务

用法：

- \`/tasks\` — 列出本频道进行中的任务
- \`/tasks show <id>\` — 查看单个任务文件（进行中或已归档）
- \`/tasks archive\` — 列出已归档（已关闭）的任务
- \`/tasks approve <id>\` — 显式批准该任务的外部副作用
- \`/tasks pause <id>\` — 停止该任务的自动唤醒
- \`/tasks resume <id>\` — 让暂停的任务在下一轮扫描中恢复
- \`/tasks run <id>\` — 恢复并立即排入一次执行（需要运行时可用）
- \`/tasks set <id> <${SETTABLE_TASK_FIELDS.join("|")}> <值>\` — 直接改一个字段，不花一个 LLM 回合
- \`/tasks stats [id]\` — 查看任务级的尝试次数、token、花费与验收结果
- \`/tasks doctor\` — 只读检查任务/事件一致性`;
}

function parseTasksCommand(args: string): TasksCommand {
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
	if (action === "approve") {
		const id = parts[1];
		if (!id || parts.length > 2) throw new Error("用法：/tasks approve <id>");
		return { action: "approve", id };
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
		return { action: "set", id: match[1], field: field as SettableTaskField, value: match[3].trim() };
	}
	if (action === "stats") {
		const id = parts[1];
		if (parts.length > 2) throw new Error("用法：/tasks stats [id]");
		return { action: "stats", id };
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
	if (wakeMs === undefined) return "—";
	const iso = new Date(wakeMs).toISOString();
	const diffMs = wakeMs - now;
	if (diffMs <= 0) return `${iso} (due)`;
	const minutes = Math.round(diffMs / 60000);
	const rel =
		minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1440)}d`;
	return `${iso} (${rel})`;
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
	const ms = new Date(wake).getTime();
	return Number.isFinite(ms) ? ms : undefined;
}

function issue(problem: string, nextStep: string): string {
	return `- ${problem}\n  Next step: ${nextStep}`;
}

/**
 * Render the ordering edges a stored task still declares, e.g. `child → parent, a → b`.
 * Empty when the task carries no retired relation keys (spec 036, D8).
 */
function describeDroppedTaskRelations(id: string, rawControl: unknown): string {
	if (!isRecord(rawControl)) return "";
	const edges: string[] = [];
	const parent = rawControl.parent;
	if (typeof parent === "string" && parent.trim()) edges.push(`${id} → ${parent.trim()}`);
	const dependsOn = rawControl.dependsOn;
	if (Array.isArray(dependsOn)) {
		for (const dependency of dependsOn) {
			if (typeof dependency === "string" && dependency.trim()) edges.push(`${id} → ${dependency.trim()}`);
		}
	}
	return edges.join(", ");
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
	const entries = await readActiveTasks(dir, now);
	if (entries.length === 0) {
		return "# 任务\n\n当前没有进行中的任务。";
	}

	const blocks = entries.map((entry) => {
		const status = entry.frontmatter.readable ? (entry.frontmatter.status ?? "active") : "⚠ unreadable frontmatter";
		const detail = [`  status: ${status}`, `next wake: ${relativeWake(entry.wakeMs, now)}`];
		const control = entry.frontmatter.control;
		if (control) {
			detail.push(`priority: ${control.priority}`);
			detail.push(`attempts: ${control.usage.attempts}/${control.budget.maxAttempts}`);
			if (control.verification.required) detail.push(`verify: required/${control.verification.status}`);
			if (control.sideEffects !== "workspace") {
				detail.push(`effects: ${control.sideEffects}/${control.externalApproval}`);
			}
			if (control.deadline) detail.push(`deadline: ${control.deadline}`);
			if (control.nextAction) detail.push(`next: ${control.nextAction}`);
			if (control.cycleId) {
				detail.push(`${status === "done" ? "last" : "current"} cycle: ${control.cycleId}`);
			}
		}
		if (entry.frontmatter.recurrence) detail.push(`recurrence: ${entry.frontmatter.recurrence}`);
		if (entry.frontmatter.schedule) {
			detail.push(`schedule timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone} (host)`);
		}
		return `- ${entry.id} — ${entry.title}\n${detail.join("   ")}`;
	});
	return `# 任务：${entries.length} 个进行中\n\n${blocks.join("\n")}`;
}

async function approveTask(options: HandleTasksCommandOptions, idInput: string): Promise<string> {
	const id = normalizeTaskId(idInput);
	const task = await readStoredTask(options.channelDir, id);
	if (!task) return `找不到任务：${id}`;
	const control = task.fields.control;
	if (!control) return `任务 ${id} 没有受治理的 control 元数据，先让 agent 规范化后再审批。`;
	if (task.fields.status === "done" || task.fields.status === "cancelled") {
		return `任务 ${id} 已是 ${task.fields.status}，不能再授予外部动作审批。`;
	}
	if (control.sideEffects !== "external") {
		return `任务 ${id} 未标记为外部副作用，无需审批。`;
	}
	if (control.externalApproval === "granted") {
		return `任务 ${id} 已由 ${control.approvalBy ?? "某位用户"} 于 ${control.approvedAt ?? "未知时间"} 批准过。`;
	}
	control.externalApproval = "granted";
	control.approvalBy = options.approver?.trim() || "unknown-user";
	control.approvedAt = new Date().toISOString();
	control.approvalBodyHash = taskBodyHash(task.body);
	await writeStoredTask(task);
	return `已批准任务 ${id} 的外部副作用，审批人记为 ${control.approvalBy}。`;
}

export async function pauseTask(options: HandleTasksCommandOptions, idInput: string): Promise<string> {
	const id = normalizeTaskId(idInput);
	const task = await readStoredTask(options.channelDir, id);
	if (!task) return `找不到任务：${id}`;
	const from = normalizeStoredStatus(task.fields.status);
	if (from === "paused") return `任务 ${id} 已经是暂停状态。`;
	try {
		resolveTaskTransition("pause", id, from);
	} catch (error) {
		return errorMessage(error);
	}
	task.fields.status = "paused";
	task.fields.wake = undefined;
	if (task.fields.control) {
		task.fields.control.pausedBy = "user";
		task.fields.control.blockedReason = `Paused by ${options.approver?.trim() || "a user"}.`;
	}
	await writeStoredTask(task);
	return `已暂停任务 ${id}。需要继续时用 /tasks resume ${id}。`;
}

/**
 * Why restarting this task would immediately stop it again, or `undefined` when it is free to run.
 *
 * The governor pauses on the same condition it re-checks on the next scan, so a plain resume of a
 * budget/deadline-exhausted task looked like it worked, cost one escalation turn, and landed back
 * in `paused` minutes later — while three separate places (the `/stop` receipt, `/tasks` usage,
 * the driving playbook) told the user resume was the fix. Refuse instead, and name the command
 * that actually unblocks it.
 */
function restartBlockedMessage(id: string, control: TaskControl | undefined): string | undefined {
	if (!control) return undefined;
	const violation = taskBudgetViolation(control, Date.now());
	if (!violation) return undefined;
	return [
		`任务 ${id} 仍然超出治理限额：${violation}。`,
		"直接恢复只会在下一轮扫描中被治理器再次暂停，并白白多花一个回合。",
		`先放宽限额：\`/tasks set ${id} attempts <n>\`（当前上限 ${control.budget.maxAttempts}）` +
			`${control.deadline ? `，或 \`/tasks set ${id} deadline <ISO8601>\`（当前 ${control.deadline}）` : ""}，然后再试一次。`,
		"若这个任务已经不该继续，用 `task_manage cancel` 关掉它。",
	].join("\n");
}

export async function resumeTask(options: HandleTasksCommandOptions, idInput: string): Promise<string> {
	const id = normalizeTaskId(idInput);
	const task = await readStoredTask(options.channelDir, id);
	if (!task) return `找不到任务：${id}`;
	const from = normalizeStoredStatus(task.fields.status);
	if (from !== "paused") return `任务 ${id} 当前是 ${from}，并非暂停状态。`;
	const blocked = restartBlockedMessage(id, task.fields.control);
	if (blocked) return blocked;
	resolveTaskTransition("resume", id, from);
	task.fields.status = "active";
	task.fields.wake = undefined;
	if (task.fields.control) {
		task.fields.control.pausedBy = undefined;
		task.fields.control.blockedReason = undefined;
	}
	await writeStoredTask(task);
	return `已恢复任务 ${id}，任务驱动器下一轮扫描会接上。`;
}

/**
 * Edit one task field directly.
 *
 * The alternative — telling the model "change wake to tomorrow 9am" — costs a whole turn and its
 * tokens to reach the same one-line write. Validation is not re-implemented here: `wake` reuses
 * the ledger's ISO8601 rule and everything else goes through `applyTaskControlPatch`, the same
 * function `task_manage set` uses, so the two entry points cannot drift apart.
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
		} else if (!Number.isFinite(new Date(value).getTime())) {
			return `wake "${value}" 不是合法的 ISO8601 时间。`;
		} else {
			task.fields.wake = value;
		}
	} else {
		const control = task.fields.control ?? createDefaultTaskControl();
		try {
			task.fields.control = applyTaskControlPatch(
				control,
				field === "next"
					? { nextAction: value }
					: field === "deadline"
						? { deadline: value }
						: field === "priority"
							? { priority: parseTaskPriority(value) }
							: { maxAttempts: parseAttempts(value) },
			);
		} catch (error) {
			return errorMessage(error);
		}
	}

	await writeStoredTask(task);
	return `已更新任务 ${id}：${field} = ${value || "（已清除）"}`;
}

function parseTaskPriority(value: string): TaskPriority {
	if (!TASK_PRIORITIES.includes(value as TaskPriority)) {
		throw new Error(`priority 必须是 ${TASK_PRIORITIES.join(" / ")} 之一。`);
	}
	return value as TaskPriority;
}

function parseAttempts(value: string): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1) {
		throw new Error("attempts 必须是不小于 1 的整数。");
	}
	return parsed;
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
	const blocked = restartBlockedMessage(id, task.fields.control);
	if (blocked) return blocked;
	task.fields.status = "active";
	task.fields.wake = undefined;
	if (task.fields.control) {
		task.fields.control.pausedBy = undefined;
		task.fields.control.blockedReason = undefined;
	}
	await writeStoredTask(task);
	const now = new Date();
	const claim = task.fields.control ? await claimTaskAttempt(options.channelDir, id, now) : undefined;
	const enqueued = await options.dispatchTask?.(id);
	if (!enqueued && claim) await releaseTaskAttemptClaim(options.channelDir, id, claim, now);
	return enqueued
		? `已把任务 ${id} 排入一次立即执行。`
		: `任务 ${id} 已就绪。启动钉钉守护进程可自动派发，或在本会话里直接发一条普通消息推进它。`;
}

function renderUsageLine(entry: TaskLedgerEntry): string {
	const control = entry.frontmatter.control;
	if (!control) return `- ${entry.id}：旧格式任务（没有受治理的用量记录）`;
	const verification = control.verification;
	const cycleCost = control.usage.costKnown ? `$${control.usage.costUsd.toFixed(4)}` : "unavailable";
	return [
		`- ${entry.id} — ${entry.title}`,
		`  this cycle: ${control.usage.attempts}/${control.budget.maxAttempts} attempts, ${control.usage.tokens} tokens, ${cycleCost}, ${control.usage.wallTimeMinutes.toFixed(1)}m`,
		`  last run: ${control.lastOutcome}`,
		`  verification: ${verification.required ? "required" : "not required"}/${verification.status}`,
	].join("\n");
}

async function taskStats(options: HandleTasksCommandOptions, idInput?: string): Promise<string> {
	if (idInput) {
		const id = normalizeTaskId(idInput);
		const task = await readStoredTask(options.channelDir, id, true, true);
		if (!task) return `找不到任务：${id}`;
		const entry: TaskLedgerEntry = {
			id,
			title: extractTaskTitle(task.body, id),
			frontmatter: {
				readable: true,
				status: task.fields.status,
				wake: task.fields.wake,
				recurrence: task.fields.recurrence,
				control: task.fields.control,
			},
			actionable: false,
		};
		return `# 任务用量\n\n${renderUsageLine(entry)}`;
	}
	const entries = await readActiveTasks(tasksDir(options.channelDir));
	const governed = entries.filter((entry) => entry.frontmatter.control);
	const totals = governed.reduce(
		(total, entry) => {
			const usage = entry.frontmatter.control!.usage;
			total.attempts += usage.attempts;
			total.tokens += usage.tokens;
			total.costUsd += usage.costUsd;
			total.costKnown &&= usage.costKnown;
			total.wallTimeMinutes += usage.wallTimeMinutes;
			return total;
		},
		{ attempts: 0, tokens: 0, costUsd: 0, costKnown: true, wallTimeMinutes: 0 },
	);
	const verified = governed.filter((entry) => entry.frontmatter.control?.verification.status === "passed").length;
	const stalled = governed.filter((entry) => entry.frontmatter.control?.lastOutcome === "failed").length;
	return [
		"# 任务用量",
		"",
		`governed tasks: ${governed.length}/${entries.length}`,
		`this cycle: ${totals.attempts} attempts, ${totals.tokens} tokens, ${totals.costKnown ? `$${totals.costUsd.toFixed(4)}` : "cost unavailable"}, ${totals.wallTimeMinutes.toFixed(1)}m`,
		`verification PASS: ${verified}`,
		`last-run failures: ${stalled}`,
		"",
		...governed.map(renderUsageLine),
	].join("\n");
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
	const location = path === archivePath ? "（已归档）" : "";
	const content = await readFile(path, "utf-8");
	return `# 任务：${taskId}${location}\n\n\`\`\`markdown\n${content}\n\`\`\``;
}

async function listArchive(channelDir: string): Promise<string> {
	const dir = join(tasksDir(channelDir), "archive");
	if (!existsSync(dir)) {
		return "# 已归档任务\n\n暂无已归档任务。";
	}
	const filenames = (await readdir(dir)).filter((filename) => filename.endsWith(".md")).sort();
	if (filenames.length === 0) {
		return "# 已归档任务\n\n暂无已归档任务。";
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
	return `# 已归档任务：${blocks.length}\n\n${blocks.join("\n")}`;
}

async function doctor(options: HandleTasksCommandOptions): Promise<string> {
	if (!options.workspaceDir || !options.channelId) {
		return "# 任务体检\n\n不可用：需要 workspaceDir 与 channelId。";
	}

	const now = Date.now();
	const entries = await readActiveTasks(tasksDir(options.channelDir), now);
	const activeIds = new Set(entries.map((entry) => entry.id));
	const archivedIds = await readArchivedTaskIds(options.channelDir);
	const events = await readTaskEvents(options.workspaceDir, options.channelId);
	const runningJobTaskIds = channelJobTaskIds(options.channelId);
	const issues: string[] = [];

	for (const entry of entries) {
		const status = entry.frontmatter.status ?? "active";
		if (!entry.frontmatter.readable) {
			issues.push(
				issue(
					`tasks/${entry.id}.md has unreadable frontmatter; wake/status cannot be trusted.`,
					`Fix tasks/${entry.id}.md so it starts with readable status/wake/recurrence frontmatter.`,
				),
			);
			continue;
		}
		if (entry.frontmatter.controlReadable === false) {
			issues.push(
				issue(
					`tasks/${entry.id}.md has invalid control metadata; governance is fail-open but cannot be enforced.`,
					`Use task_manage set or repair the one-line control JSON before allowing the task to run.`,
				),
			);
			continue;
		}

		const control = entry.frontmatter.control;
		if (control) {
			const storedTask = await readStoredTask(options.channelDir, entry.id);
			const violation = taskBudgetViolation(control, now);
			if (violation) {
				issues.push(
					issue(
						`tasks/${entry.id}.md exceeds its control limit: ${violation}.`,
						`Review the task, then explicitly raise its budget/deadline or cancel it; the driver will escalate it.`,
					),
				);
			}
			if (control.sideEffects === "external" && control.externalApproval === "required") {
				issues.push(
					issue(
						`tasks/${entry.id}.md requires external side effects but has no user approval.`,
						`After reviewing the proposed action, a user must run /tasks approve ${entry.id}.`,
					),
				);
			}
			if (
				control.externalApproval === "granted" &&
				storedTask &&
				control.approvalBodyHash !== taskBodyHash(storedTask.body)
			) {
				issues.push(
					issue(
						`tasks/${entry.id}.md changed after external-action approval was granted.`,
						`Review the current action and run /tasks approve ${entry.id} again.`,
					),
				);
			}
			if (status !== "done" && control.verification.status === "passed" && control.verification.bodyHash) {
				if (storedTask && taskBodyHash(storedTask.body) !== control.verification.bodyHash) {
					issues.push(
						issue(
							`tasks/${entry.id}.md changed after its recorded independent PASS.`,
							`Run a fresh purpose=verify sub-agent and import its attestation before completion.`,
						),
					);
				} else if (control.verification.required) {
					const attestationOk = control.verification.runId
						? await readVerificationAttestation(options.channelDir, control.verification.runId)
								.then((attestation) => attestation.taskId === entry.id && attestation.verdict === "pass")
								.catch(() => false)
						: false;
					if (!attestationOk) {
						issues.push(
							issue(
								`tasks/${entry.id}.md records an independent PASS with no matching verifier attestation on disk.`,
								`Run a fresh purpose=verify sub-agent and import its attestation with task_manage verify before completion.`,
							),
						);
					}
				}
			}
		}

		const recurring = Boolean(entry.frontmatter.schedule);
		if (status === "done" && !recurring) {
			issues.push(
				issue(
					`tasks/${entry.id}.md is done but still in the active directory.`,
					`Archive one-shot task ${entry.id}, or add a schedule cron with task_manage set if it is recurring.`,
				),
			);
		}

		const content = await readActiveTaskContent(options.channelDir, entry.id);
		if (content === undefined) {
			issues.push(
				issue(
					`tasks/${entry.id}.md could not be read during doctor checks.`,
					`Open tasks/${entry.id}.md manually and repair permissions or file contents.`,
				),
			);
		} else {
			const missing = missingStandardTaskSections(content);
			if (missing.length > 0) {
				issues.push(
					issue(
						`tasks/${entry.id}.md is missing standard section(s): ${missing.join(", ")}.`,
						`Ask the agent to normalize tasks/${entry.id}.md to the standard task skeleton.`,
					),
				);
			}
		}

		// A parked task is waiting for someone to call it: a finished background job, a user
		// message, or `/tasks run`. The driver deliberately will not (see `isTaskParked`), so with
		// no running job carrying this id, whether it ever resumes is entirely up to the user.
		// That is legitimate when it is waiting on an answer — and indistinguishable, on disk,
		// from a task everyone has forgotten. Report the fact and name every way out.
		if (isTaskParked(entry.frontmatter) && !runningJobTaskIds.has(entry.id)) {
			issues.push(
				issue(
					`tasks/${entry.id}.md is parked (waiting, no wake) and no running background job will wake it.`,
					`It resumes only when you reply to it, run /tasks run ${entry.id}, or give it a wake with /tasks set ${entry.id} wake <ISO8601>; cancel it if what it waits for is gone.`,
				),
			);
		}

		if (entry.frontmatter.wake && validWakeMs(entry) === undefined) {
			issues.push(
				issue(
					`tasks/${entry.id}.md has an invalid wake value (${entry.frontmatter.wake}); the native driver will treat it as due.`,
					`Use task_manage set or progress to replace wake with ISO8601, or clear it if the task should continue now.`,
				),
			);
		}
	}

	// Spec 036 D8: retired control keys are ignored on read, which keeps stored tasks readable
	// but silently discards whatever `parent`/`dependsOn` once expressed. Report the loss —
	// naming the dropped edges, not just the key — so the user can restate any real ordering.
	for (const entry of entries) {
		const retired = retiredTaskControlKeys(entry.frontmatter.rawControl);
		if (retired.length === 0) continue;
		const edges = describeDroppedTaskRelations(entry.id, entry.frontmatter.rawControl);
		issues.push(
			issue(
				`tasks/${entry.id}.md still carries retired control keys: ${retired.join(", ")}.${edges ? ` Dropped ordering: ${edges}.` : ""}`,
				edges
					? `These no longer constrain execution. Restate any real ordering in the task body or with wake, then remove the keys (any task_manage write drops them).`
					: `They are ignored; any task_manage write drops them.`,
			),
		);
	}

	for (const event of events) {
		if (!event.id || !event.use) {
			issues.push(
				issue(
					`events/${event.filename} does not follow task.<channelId>.<taskId>.<use>.json.`,
					"Rename the event to the task-owned naming convention or manage it as a normal event.",
				),
			);
			continue;
		}
		if (event.error) {
			issues.push(
				issue(
					`events/${event.filename} is not parseable: ${event.error}`,
					`Fix or delete events/${event.filename}; invalid task-owned events cannot be trusted.`,
				),
			);
			continue;
		}
		if (!activeIds.has(event.id) && !archivedIds.has(event.id)) {
			issues.push(
				issue(
					`events/${event.filename} points to missing task ${event.id}.`,
					`Delete events/${event.filename}, or recreate tasks/${event.id}.md if that task still exists conceptually.`,
				),
			);
			continue;
		}
		if (archivedIds.has(event.id)) {
			issues.push(
				issue(
					`events/${event.filename} points to archived task ${event.id}; closed tasks should have no live events.`,
					`Delete events/${event.filename}; archived tasks should not wake the agent.`,
				),
			);
		}
	}

	if (issues.length === 0) {
		return "# 任务体检\n\n未发现任务台账问题。";
	}
	return `# 任务体检\n\n发现 ${issues.length} 个问题：\n\n${issues.join("\n")}`;
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
		switch (command.action) {
			case "list":
				return await listTasks(options.channelDir);
			case "show":
				return await showTask(options.channelDir, command.id);
			case "archive":
				return await listArchive(options.channelDir);
			case "approve":
				return await approveTask(options, command.id);
			case "pause":
				return await pauseTask(options, command.id);
			case "resume":
				return await resumeTask(options, command.id);
			case "run":
				return await runTask(options, command.id);
			case "set":
				return await setTaskField(options, command.id, command.field, command.value);
			case "stats":
				return await taskStats(options, command.id);
			case "doctor":
				return await doctor(options);
		}
	} catch (error) {
		const message = errorMessage(error);
		return `执行 /tasks ${command.action} 失败：${message}`;
	}
}
