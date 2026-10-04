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
import type { TaskFrontmatter } from "../tasks/frontmatter.js";
import { extractTaskTitle, findTaskSectionBounds, normalizeTaskId, parseTaskItems, taskBody } from "../tasks/ledger.js";
import { appendTaskLog } from "../tasks/log.js";
import { withTaskMutation } from "../tasks/mutation-lock.js";
import { archiveTask, readStoredTask, writeStoredTask } from "../tasks/store.js";
import { discoverTaskChannels } from "./task-driver.js";

/**
 * One-time, deterministic, no-LLM conversion of v3 task files (0.9.2: `status` / `enabled` /
 * `wake` / `schedule` / `control` frontmatter) to v5 (spec 052). It ships with the release that
 * introduces v5 and is deleted in the next minor release.
 *
 * - **Recurring tasks become event templates.** A v3 task with a `schedule` is, from v5's point of
 *   view, an event that spawns an instance per occurrence. The converter writes that event, then
 *   retires the task if it was only sleeping until its next occurrence, or lets the occurrence in
 *   flight finish as an instance of the event.
 * - **Nothing is parked.** v3 waits (`wake`, `waitingFor`) have no v5 equivalent; the task is
 *   reopened, and `enabled: false` / `control.stop` become a pause, so a disabled task never
 *   starts running because of the upgrade.
 *
 * Originals are copied to `tasks/.v3/` and never deleted. Files that already carry v5
 * frontmatter (`state:`) are left alone.
 */
const MIGRATION_MARKER = "task-migration-v5.done";
const BACKUP_DIRNAME = ".v3";
const ITEMS_NAMES = ["Plan", "计划"] as const;
/** v3 per-cycle bookkeeping; v5 keeps this in the loop log instead of the contract. */
const CYCLE_SECTION_NAMES = ["Current Cycle", "当前周期", "History", "历史"] as const;

interface V3Fields {
	status?: string;
	enabled?: boolean;
	schedule?: string;
	stopReason?: string;
	/** Any v5 key present: the file is already converted. */
	v5: boolean;
}

function parseJson(value: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(value);
		return isPlainObject(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/** Minimal reader for the v3 frontmatter block; the only place that still understands it. */
export function parseV3Frontmatter(content: string): V3Fields | undefined {
	if (!content.startsWith("---")) return undefined;
	const end = content.indexOf("\n---", 3);
	if (end === -1) return undefined;
	const fields: V3Fields = { v5: false };
	for (const line of content.slice(3, end).split("\n")) {
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		const key = line.slice(0, idx).trim();
		const value = line.slice(idx + 1).trim();
		switch (key) {
			case "state":
				fields.v5 = true;
				break;
			case "status":
				fields.status = value;
				break;
			case "enabled":
				fields.enabled = value !== "false";
				break;
			case "schedule":
				fields.schedule = value || undefined;
				break;
			case "control": {
				const stop = parseJson(value)?.stop;
				if (isPlainObject(stop) && typeof stop.reason === "string") fields.stopReason = stop.reason;
				break;
			}
			default:
				break;
		}
	}
	return fields;
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

/** Rename `## Plan` to `## Work Items` and drop the per-cycle sections, the two body changes v5 makes. */
export function convertBody(body: string): string {
	const lines = body.split("\n");
	const items = findTaskSectionBounds(lines, ITEMS_NAMES);
	if (items) lines[items.headingIndex] = "## Work Items";
	for (const names of [CYCLE_SECTION_NAMES.slice(0, 2), CYCLE_SECTION_NAMES.slice(2)]) {
		const bounds = findTaskSectionBounds(lines, names);
		if (bounds) lines.splice(bounds.headingIndex, bounds.end - bounds.headingIndex);
	}
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
 * Build the event template a recurring v3 task becomes. The original Manual and Verification text
 * is carried into the Goal (v5 has no such sections, and a recurring job's accumulated rules are
 * exactly what the template exists to keep), and every checkbox is reset.
 */
export function buildTemplate(id: string, body: string): TemplateOutcome {
	const title = extractTaskTitle(`---\n---\n${body}`, id);
	const goal = sectionText(body, ["Goal", "目标"]) ?? title;
	const manual = sectionText(body, ["Manual", "手册"]);
	const verification = sectionText(body, ["Verification", "验收"])
		?.split("\n")
		.filter((line) => !/^Independent verification:/i.test(line.trim()))
		.join("\n")
		.trim();
	const dod = (sectionText(body, ["DoD"]) ?? "")
		.split("\n")
		.map((line) => line.replace(/^(\s*[-*]\s+)\[[xX]\]/, "$1[ ]"))
		.join("\n")
		.trim();
	const items = parseTaskItems(convertBody(body))?.items.map((item) => ({ text: item.text })) ?? [];

	const template: Record<string, unknown> = {
		title,
		goal: [
			goal,
			manual ? `原手册（每次执行都适用）：\n${manual}` : undefined,
			verification ? `原检查要求：\n${verification}` : undefined,
		]
			.filter(Boolean)
			.join("\n\n"),
		dod: dod || "- [ ] 完成上述目标",
		...(items.length > 0 ? { items } : {}),
	};
	try {
		validateTaskContractInput(template);
		return { template };
	} catch (error) {
		return { reason: errorMessage(error) };
	}
}

/** Write the event template for a recurring task; returns the event name, or why it could not be expressed. */
async function writeTemplateEvent(
	workspaceDir: string,
	channelId: string,
	id: string,
	body: string,
	schedule: string,
): Promise<{ name?: string; reason?: string }> {
	const { template, reason } = buildTemplate(id, body);
	if (!template) return { reason };
	const eventsDir = join(workspaceDir, "events");
	await mkdir(eventsDir, { recursive: true });
	let name = id;
	if (existsSync(join(eventsDir, `${name}.json`))) name = `${id}-task`;
	if (existsSync(join(eventsDir, `${name}.json`))) return { reason: `event ${name} already exists` };
	const event = { type: "periodic", channelId, schedule, task: template };
	await writeFileAtomically(join(eventsDir, `${name}.json`), `${JSON.stringify(event, null, 2)}\n`);
	return { name };
}

async function convertOneTask(
	workspaceDir: string,
	channelId: string,
	channelDir: string,
	id: string,
	now: Date,
): Promise<boolean> {
	return withTaskMutation(channelDir, id, async () => {
		const path = join(channelDir, "tasks", `${id}.md`);
		const content = await readFile(path, "utf-8");
		const v3 = parseV3Frontmatter(content);
		if (!v3 || v3.v5 || v3.status === undefined) return false;

		const backupDir = join(channelDir, "tasks", BACKUP_DIRNAME);
		await mkdir(backupDir, { recursive: true });
		await copyFile(path, join(backupDir, `${id}.md`));
		const original = taskBody(content);
		const notes: string[] = [];

		let origin: string | undefined;
		let retire = false;
		if (v3.schedule) {
			const written = await writeTemplateEvent(workspaceDir, channelId, id, original, v3.schedule);
			if (written.name) {
				origin = written.name;
				retire = v3.status === "sleeping";
				notes.push(
					retire
						? `转换到 v5：周期性已移到事件模板 ${written.name}（${v3.schedule}），每次触发会生成一个新的任务实例；本任务不再重复。`
						: `转换到 v5：周期性已移到事件模板 ${written.name}（${v3.schedule}）。本次正在进行的执行作为它的一个实例继续，下一次由事件生成。`,
				);
			} else {
				notes.push(`转换到 v5：无法把周期性转换为事件模板（${written.reason}），该任务已暂停，需要人工处理。`);
			}
		}

		const fields: TaskFrontmatter = { state: "open", origin, usage: createUsage(now) };
		const stopped = v3.enabled === false || v3.stopReason !== undefined;
		if (stopped || (v3.schedule && !origin)) {
			fields.paused = {
				by: stopped ? "user" : "runtime",
				reason: stopped ? (v3.stopReason ?? "v3 中已停用。") : "周期性无法转换为事件模板，需要人工处理。",
				at: formatLocalTime(now),
			};
		}
		if (v3.status === "waiting") {
			notes.push(
				"转换到 v5：该任务此前在等待外部条件，v5 没有对应的等待来源，已改为 open。先核对真实状态，再决定继续还是重新停泊。",
			);
		}

		await writeStoredTask({ id, path, fields, body: convertBody(original) });
		for (const note of notes) await appendTaskLog(channelDir, id, { kind: "note", note });
		if (retire) await archiveTask(channelDir, id, "cancelled");
		log.logInfo(
			`Task ${id} converted to v5`,
			`state=${fields.state}${fields.paused ? " paused" : ""}${origin ? ` origin=${origin}` : ""}${retire ? " (retired)" : ""}`,
		);
		return true;
	});
}

/** Move task-owned sensor events (`task.<channelId>.<taskId>.<use>`) out of the way: v5 has no `signal` ticket. */
async function moveTaskOwnedEvents(workspaceDir: string, channelId: string, channelDir: string): Promise<void> {
	const eventsDir = join(workspaceDir, "events");
	let names: string[];
	try {
		names = (await readdir(eventsDir)).filter((name) => name.endsWith(".json"));
	} catch {
		return;
	}
	const prefix = `task.${channelId}.`;
	for (const name of names) {
		if (!name.startsWith(prefix)) continue;
		const rest = name.slice(prefix.length, -".json".length);
		const lastDot = rest.lastIndexOf(".");
		const ownerId = lastDot > 0 ? rest.slice(0, lastDot) : undefined;
		const targetDir = join(channelDir, "tasks", BACKUP_DIRNAME, "events");
		await mkdir(targetDir, { recursive: true });
		await rename(join(eventsDir, name), join(targetDir, name));
		if (ownerId && (await readStoredTask(channelDir, ownerId).catch(() => undefined))) {
			await appendTaskLog(channelDir, ownerId, {
				kind: "note",
				note: `转换到 v5：传感器事件 ${name.slice(0, -".json".length)} 已移到 tasks/.v3/events/（v5 没有 signal 票）；需要等待外部条件时，改用带超时的后台作业。`,
			});
		}
	}
}

/** Convert every v3 task file in every known channel. Failures are logged and skipped. */
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
				if (await convertOneTask(workspaceDir, channelId, channelDir, normalizeTaskId(id), now)) converted++;
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
