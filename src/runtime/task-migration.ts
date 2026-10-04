import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getChannelDir } from "../channel/channel-paths.js";
import * as log from "../log.js";
import { writeFileAtomically } from "../shared/atomic-file.js";
import { formatLocalTime } from "../shared/local-time.js";
import { errorMessage } from "../shared/text-utils.js";
import { isPlainObject } from "../shared/type-guards.js";
import { createUsage } from "../tasks/budget.js";
import { validateTaskContractInput } from "../tasks/contract-input.js";
import type { TaskFrontmatter, TaskPaused } from "../tasks/frontmatter.js";
import { extractTaskTitle, findTaskSectionBounds, normalizeTaskId, parseTaskItems, taskBody } from "../tasks/ledger.js";
import { appendTaskLog } from "../tasks/log.js";
import { withTaskMutation } from "../tasks/mutation-lock.js";
import { archiveTask, readStoredTask, writeStoredTask } from "../tasks/store.js";
import { type PendingWorkRef, resolveTicket, type Ticket } from "../tasks/ticket.js";
import { discoverTaskChannels } from "./task-driver.js";

/**
 * One-time, deterministic, no-LLM conversion of v4 task files to v5 (spec 052, D12). It exists
 * for the version that introduces v5 and is deleted in the next minor release.
 *
 * Two things matter most:
 *
 * - **Recurring tasks become event templates.** A v4 task with a `schedule` is, from v5's point of
 *   view, an event that spawns an instance each occurrence. The converter writes that event (same
 *   cron, a template built from the contract), then retires the task if it was only waiting for
 *   its next occurrence, or lets the occurrence in flight finish as an instance of the event.
 * - **Nothing is parked on a source that no longer exists.** `run`/`job` tickets become a `work`
 *   ticket only if the run/job is still in flight in the persisted state; otherwise the task is
 *   reopened with a note, so the conversion is also a repair.
 *
 * Originals are copied to `tasks/.v4/` and never deleted. v3 files (`status`/`control`) are left
 * alone: upgrade through a 0.9.x release first.
 */
const MIGRATION_MARKER = "task-migration-v5.done";
const ITEMS_NAMES = ["Plan", "计划"] as const;
const LAST_RESULT_NAMES = ["上次结果", "Last Result"] as const;

interface V4Fields {
	state?: string;
	paused?: TaskPaused;
	schedule?: string;
	ticket?: Record<string, unknown>;
	cycle?: Record<string, unknown>;
	budget?: Record<string, unknown>;
	verify?: boolean;
	hasUsage: boolean;
	/** v3 markers: this file is older than v4 and is not converted here. */
	v3: boolean;
	/** Any key v5 does not know, i.e. the file has not been converted yet. */
	v4Keys: boolean;
}

function parseJson(value: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(value);
		return isPlainObject(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/** Minimal reader for the v4 frontmatter block; the only place that still understands it. */
export function parseV4Frontmatter(content: string): V4Fields | undefined {
	if (!content.startsWith("---")) return undefined;
	const end = content.indexOf("\n---", 3);
	if (end === -1) return undefined;
	const fields: V4Fields = { hasUsage: false, v3: false, v4Keys: false };
	for (const line of content.slice(3, end).split("\n")) {
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		const key = line.slice(0, idx).trim();
		const value = line.slice(idx + 1).trim();
		switch (key) {
			case "state":
				fields.state = value;
				break;
			case "paused": {
				const paused = parseJson(value);
				if (paused && typeof paused.reason === "string" && paused.reason) {
					fields.paused = {
						by: paused.by === "runtime" ? "runtime" : "user",
						reason: paused.reason,
						at: typeof paused.at === "string" && paused.at ? paused.at : formatLocalTime(),
					};
				}
				break;
			}
			case "schedule":
				fields.schedule = value || undefined;
				fields.v4Keys = true;
				break;
			case "ticket":
				fields.ticket = parseJson(value);
				break;
			case "cycle":
				fields.cycle = parseJson(value);
				fields.v4Keys = true;
				break;
			case "budget":
				fields.budget = parseJson(value);
				break;
			case "verify":
				fields.verify = value === "required";
				fields.v4Keys = true;
				break;
			case "usage":
				fields.hasUsage = true;
				break;
			case "status":
			case "enabled":
			case "control":
			case "wake":
				fields.v3 = true;
				break;
			default:
				break;
		}
	}
	return fields;
}

function num(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function positive(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function sectionText(body: string, names: readonly string[]): string | undefined {
	const lines = body.split("\n");
	const bounds = findTaskSectionBounds(lines, names);
	if (!bounds) return undefined;
	const text = lines
		.slice(bounds.headingIndex + 1, bounds.end)
		.join("\n")
		.trim();
	return text || undefined;
}

/** Rename `## Plan` to `## Work Items` and drop `## 上次结果`, the two body changes v5 makes. */
export function convertBody(body: string): string {
	let lines = body.split("\n");
	const items = findTaskSectionBounds(lines, ITEMS_NAMES);
	if (items) lines[items.headingIndex] = "## Work Items";
	const last = findTaskSectionBounds(lines, LAST_RESULT_NAMES);
	if (last) lines.splice(last.headingIndex, last.end - last.headingIndex);
	lines = lines.filter((_, index, all) => !(all[index] === "" && all[index - 1] === "" && all[index - 2] === ""));
	return lines
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trimEnd();
}

interface TemplateOutcome {
	template?: Record<string, unknown>;
	reason?: string;
}

/**
 * Build the event template a recurring v4 task becomes. The original Manual and Verification text
 * is carried into the Goal (v5 has no such sections, and a recurring job's accumulated rules are
 * exactly what the template exists to keep), and every checkbox is reset.
 */
export function buildTemplate(id: string, body: string, fields: V4Fields): TemplateOutcome {
	const title = extractTaskTitle(`---\n---\n${body}`, id);
	const goal = sectionText(body, ["Goal", "目标"]) ?? title;
	const manual = sectionText(body, ["Manual", "手册"]);
	const verification = sectionText(body, ["Verification", "验收"])
		?.split("\n")
		.filter((line) => !/^Independent verification:/i.test(line.trim()))
		.join("\n")
		.trim();
	const dodRaw = sectionText(body, ["DoD"]);
	const dod =
		dodRaw
			?.split("\n")
			.map((line) => line.replace(/^(\s*[-*]\s+)\[[xX]\]/, "$1[ ]"))
			.join("\n") ?? "";
	const items = parseTaskItems(body)?.items.map((item) => ({ text: item.text })) ?? [];
	const budget: Record<string, number> = {};
	const steps = positive(fields.budget?.steps);
	const usd = positive(fields.budget?.usd);
	if (steps) budget.steps = steps;
	if (usd) budget.usd = usd;

	const template: Record<string, unknown> = {
		title,
		goal: [
			goal,
			manual ? `原手册（每次执行都适用）：\n${manual}` : undefined,
			verification ? `原检查要求：\n${verification}` : undefined,
		]
			.filter(Boolean)
			.join("\n\n"),
		dod: dod.trim() ? dod : "- [ ] 完成上述目标",
		...(items.length > 0 ? { items } : {}),
		...(Object.keys(budget).length > 0 ? { budget } : {}),
	};
	try {
		validateTaskContractInput(template);
		return { template };
	} catch (error) {
		return { reason: errorMessage(error) };
	}
}

/** Unsettled runs and running jobs bound to `taskId`, read from the persisted manager state. */
async function readPendingWork(
	stateDir: string,
	channelId: string,
	taskId: string,
	nowMs: number,
): Promise<PendingWorkRef[]> {
	const pending: PendingWorkRef[] = [];
	const readJsonFiles = async (dir: string): Promise<Record<string, unknown>[]> => {
		let names: string[];
		try {
			names = (await readdir(dir)).filter((name) => name.endsWith(".json"));
		} catch {
			return [];
		}
		const records: Record<string, unknown>[] = [];
		for (const name of names) {
			const parsed = parseJson(await readFile(join(dir, name), "utf-8").catch(() => ""));
			if (parsed) records.push(parsed);
		}
		return records;
	};
	for (const run of await readJsonFiles(getChannelDir(join(stateDir, "subagent-runs"), channelId))) {
		if (run.taskId !== taskId || run.status !== "running" || run.settledAt !== undefined) continue;
		if (typeof run.runId !== "string") continue;
		const startedAt = num(run.startedAt, nowMs);
		pending.push({
			ref: run.runId,
			deadlineMs: positive(run.deadlineAt) ?? startedAt + 24 * 60 * 60_000,
		});
	}
	for (const job of await readJsonFiles(join(stateDir, "jobs", channelId))) {
		const contract = isPlainObject(job.contract) ? job.contract : undefined;
		if (contract?.taskId !== taskId || job.status !== "running" || typeof job.id !== "string") continue;
		pending.push({
			ref: job.id,
			deadlineMs: num(job.startedAt, nowMs) + num(job.timeoutSeconds, 0) * 1000,
		});
	}
	return pending;
}

async function appendNote(channelDir: string, id: string, note: string): Promise<void> {
	await appendTaskLog(channelDir, id, { kind: "note", note });
}

export interface V4Conversion {
	fields: TaskFrontmatter;
	notes: string[];
}

/**
 * The v4 → v5 field mapping for one live task. Exported for the conversion test, which pins the
 * branches that matter: a park whose source is gone becomes `open`, never a dead park.
 */
export function convertV4Fields(v4: V4Fields, pending: PendingWorkRef[], now: Date, origin?: string): V4Conversion {
	const notes: string[] = [];
	const cycle = v4.cycle;
	const usage = cycle
		? {
				startedAt: typeof cycle.startedAt === "string" && cycle.startedAt ? cycle.startedAt : formatLocalTime(now),
				steps: num(cycle.steps, 0),
				usd: num(cycle.usd, 0),
				usdEstimated: cycle.usdEstimated === true,
				expired: num(cycle.expired, 0),
			}
		: createUsage(now);

	const budget: Partial<{ steps: number; usd: number }> = {};
	const steps = positive(v4.budget?.steps);
	const usd = positive(v4.budget?.usd);
	if (steps) budget.steps = steps;
	if (usd) budget.usd = usd;
	const dropped = ["wallMin", "rounds", "until"].filter((key) => v4.budget?.[key] !== undefined);
	if (dropped.length > 0) notes.push(`转换到 v5：预算项 ${dropped.join("、")} 已取消（v5 只保留 steps 与 usd）。`);
	if (v4.verify) {
		notes.push(
			"转换到 v5：v4 的“完成前必须独立验收通过”门禁已取消；是否验收、是否采信由负责人判断。原检查要求仍在契约里。",
		);
	}

	const fields: TaskFrontmatter = {
		state: v4.state === "parked" ? "parked" : "open",
		paused: v4.paused,
		origin,
		usage,
		budget: Object.keys(budget).length > 0 ? budget : undefined,
	};

	if (fields.state === "parked" && v4.ticket) {
		const kind = v4.ticket.kind;
		if (kind === "time" || kind === "ask") {
			const by = typeof v4.ticket.by === "string" ? v4.ticket.by : undefined;
			if (kind === "time" && typeof v4.ticket.at === "string" && by) {
				fields.ticket = { kind: "time", at: v4.ticket.at, by } satisfies Ticket;
			} else if (kind === "ask" && typeof v4.ticket.asked === "string" && by) {
				fields.ticket = { kind: "ask", asked: v4.ticket.asked, by } satisfies Ticket;
			}
		} else if ((kind === "run" || kind === "job") && pending.length > 0) {
			fields.ticket = resolveTicket({ kind: "work" }, { now, pendingWork: () => pending });
		}
		if (!fields.ticket) {
			fields.state = "open";
			notes.push(
				`转换到 v5：该任务此前停在 ${String(kind)} 票上，但这个等待来源在 v5 中已不存在或已结束，已改为 open。先核对真实状态，再决定继续还是重新停泊。`,
			);
		}
	}
	return { fields, notes };
}

async function copyBackup(channelDir: string, id: string): Promise<void> {
	const backupDir = join(channelDir, "tasks", ".v4");
	await mkdir(backupDir, { recursive: true });
	await copyFile(join(channelDir, "tasks", `${id}.md`), join(backupDir, `${id}.md`));
}

/** Write the event template for a recurring task; returns the event name, or `undefined` if it cannot be expressed. */
async function writeTemplateEvent(
	workspaceDir: string,
	channelId: string,
	id: string,
	body: string,
	fields: V4Fields,
): Promise<{ name?: string; reason?: string }> {
	const { template, reason } = buildTemplate(id, body, fields);
	if (!template || !fields.schedule) return { reason: reason ?? "no schedule" };
	const eventsDir = join(workspaceDir, "events");
	await mkdir(eventsDir, { recursive: true });
	let name = id;
	if (existsSync(join(eventsDir, `${name}.json`))) name = `${id}-task`;
	if (existsSync(join(eventsDir, `${name}.json`))) return { reason: `event ${name} already exists` };
	const event = { type: "periodic", channelId, schedule: fields.schedule, task: template };
	await writeFileAtomically(join(eventsDir, `${name}.json`), `${JSON.stringify(event, null, 2)}\n`);
	return { name };
}

async function convertOneTask(
	workspaceDir: string,
	stateDir: string,
	channelId: string,
	channelDir: string,
	id: string,
	now: Date,
): Promise<"converted" | "skipped"> {
	return withTaskMutation(channelDir, id, async () => {
		const path = join(channelDir, "tasks", `${id}.md`);
		const content = await readFile(path, "utf-8");
		const v4 = parseV4Frontmatter(content);
		if (!v4 || v4.hasUsage || v4.state === undefined) return "skipped";
		if (v4.v3) {
			log.logWarning(`Task ${id} is a v3 contract and is not converted`, "upgrade through a 0.9.x release first");
			return "skipped";
		}
		if (!v4.v4Keys && !/^##\s+(Plan|计划|上次结果|Last Result)\b/m.test(taskBody(content))) return "skipped";

		await copyBackup(channelDir, id);
		const original = taskBody(content);
		const notes: string[] = [];

		let origin: string | undefined;
		let retire = false;
		if (v4.schedule) {
			const written = await writeTemplateEvent(workspaceDir, channelId, id, original, v4);
			if (written.name) {
				origin = written.name;
				const parkedOnSchedule = v4.state === "parked" && v4.ticket?.kind === "schedule";
				notes.push(
					parkedOnSchedule
						? `转换到 v5：周期性已移到事件模板 ${written.name}（${v4.schedule}），每次触发会生成一个新的任务实例；本任务不再重复。`
						: `转换到 v5：周期性已移到事件模板 ${written.name}（${v4.schedule}）。本次正在进行的执行作为它的一个实例继续，下一次由事件生成。`,
				);
				retire = parkedOnSchedule;
			} else {
				notes.push(`转换到 v5：无法把周期性转换为事件模板（${written.reason}），该任务已暂停，需要人工处理。`);
			}
		}

		const pending =
			v4.ticket?.kind === "run" || v4.ticket?.kind === "job"
				? await readPendingWork(stateDir, channelId, id, now.getTime())
				: [];
		const converted = convertV4Fields(v4, pending, now, origin);
		notes.push(...converted.notes);
		if (v4.schedule && !origin && !converted.fields.paused) {
			converted.fields.paused = {
				by: "runtime",
				reason: "周期性无法转换为事件模板，需要人工处理。",
				at: formatLocalTime(now),
			};
		}

		await writeStoredTask({ id, path, fields: converted.fields, body: convertBody(original) });
		for (const note of notes) await appendNote(channelDir, id, note);
		if (retire) {
			await archiveTask(channelDir, id, "cancelled");
		}
		log.logInfo(
			`Task ${id} converted to v5`,
			`state=${converted.fields.state}${converted.fields.ticket ? ` ticket=${converted.fields.ticket.kind}` : ""}${origin ? ` origin=${origin}` : ""}${retire ? " (retired)" : ""}`,
		);
		return "converted";
	});
}

/** Move task-owned sensor events (`task.<channelId>.<taskId>.<use>`) out of the way: v5 has no `signal` ticket. */
async function moveTaskOwnedEvents(workspaceDir: string, channelId: string, channelDir: string): Promise<number> {
	const eventsDir = join(workspaceDir, "events");
	let names: string[];
	try {
		names = (await readdir(eventsDir)).filter((name) => name.endsWith(".json"));
	} catch {
		return 0;
	}
	const prefix = `task.${channelId}.`;
	let moved = 0;
	for (const name of names) {
		if (!name.startsWith(prefix)) continue;
		const rest = name.slice(prefix.length, -".json".length);
		const lastDot = rest.lastIndexOf(".");
		const ownerId = lastDot > 0 ? rest.slice(0, lastDot) : undefined;
		const targetDir = join(channelDir, "tasks", ".v4", "events");
		await mkdir(targetDir, { recursive: true });
		await rename(join(eventsDir, name), join(targetDir, name));
		moved++;
		if (ownerId && (await readStoredTask(channelDir, ownerId).catch(() => undefined))) {
			await appendNote(
				channelDir,
				ownerId,
				`转换到 v5：传感器事件 ${name.slice(0, -".json".length)} 已移到 tasks/.v4/events/（v5 没有 signal 票）；需要等待外部条件时，改用带超时的后台作业。`,
			);
		}
	}
	return moved;
}

/** Convert every task file in every known channel. Failures are logged and skipped. */
export async function migrateTasksToV5(workspaceDir: string, stateDir: string): Promise<void> {
	const markerPath = join(stateDir, MIGRATION_MARKER);
	if (existsSync(markerPath)) return;
	const now = new Date();
	let converted = 0;
	for (const channelId of await discoverTaskChannels(workspaceDir)) {
		const channelDir = getChannelDir(workspaceDir, channelId);
		let filenames: string[] = [];
		try {
			filenames = (await readdir(join(channelDir, "tasks"))).filter((name) => name.endsWith(".md"));
		} catch {
			// no tasks in this channel
		}
		for (const filename of filenames) {
			const id = filename.slice(0, -".md".length);
			try {
				if (
					(await convertOneTask(workspaceDir, stateDir, channelId, channelDir, normalizeTaskId(id), now)) ===
					"converted"
				) {
					converted++;
				}
			} catch (error) {
				log.logWarning(`Task ${id} could not be converted to v5`, errorMessage(error));
			}
		}
		await moveTaskOwnedEvents(workspaceDir, channelId, channelDir).catch((error) => {
			log.logWarning(`Task-owned events of ${channelId} could not be moved`, errorMessage(error));
		});
	}
	await mkdir(stateDir, { recursive: true });
	await writeFile(markerPath, `${formatLocalTime(now)}\n`, "utf-8");
	if (converted > 0) log.logInfo("Task conversion to v5 complete", `${converted} task(s)`);
}
