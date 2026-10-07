import { constants, existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
import { ArchiveUndoError, archiveTask, readStoredTask, writeStoredTask } from "../tasks/store.js";
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
 *   starts running as an instance because of the upgrade. Generated recurring events have no
 *   disabled flag: review/isolate them before enabling production scheduling.
 *
 * v4 beta files are NOT supported: any `state:` line skips conversion, even alongside
 * `status:`. Preserve/isolate v4 originals and rebuild through v5 tools before enabling
 * the daemon (docs/events-and-tasks.md).
 *
 * Failure handling: a task whose conversion throws is rolled back (original restored, template
 * event and archive copy removed). If any task or event move failed, the marker is NOT written, a
 * `task-migration-v5.failed.json` report is left in the state dir, and this function throws so
 * bootstrap does not start services. A report that records a failed rollback keeps blocking every
 * later start until the operator resolves it and deletes the report.
 *
 * Originals are copied to `tasks/.v3/` and never deleted or overwritten (a differing existing
 * backup is kept and the new copy gets a numeric suffix). Any file carrying `state:` frontmatter,
 * including unsupported v4 files, is left alone.
 */
const MIGRATION_MARKER = "task-migration-v5.done";
const FAILURE_REPORT = "task-migration-v5.failed.json";
const DEFAULT_STOP_REASON = "v3 中已停用。";
const BACKUP_DIRNAME = ".v3";
const ITEMS_NAMES = ["Plan", "计划"] as const;
/** v3 per-cycle bookkeeping; v5 keeps this in the loop log instead of the contract. */
const CYCLE_SECTION_NAMES = ["Current Cycle", "当前周期", "History", "历史"] as const;

interface V3Fields {
	status?: string;
	enabled?: boolean;
	schedule?: string;
	stopReason?: string;
	/** `control.stop` is present (with or without a usable reason). */
	stopped: boolean;
	/** A state key is present: skip this file, whether v4 or v5. */
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
	const fields: V3Fields = { v5: false, stopped: false };
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
				if (isPlainObject(stop)) {
					fields.stopped = true;
					if (typeof stop.reason === "string" && stop.reason.trim()) fields.stopReason = stop.reason.trim();
				}
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

/** `rm` that also treats "a parent is not a directory" as already gone. */
async function removeIfPresent(path: string): Promise<void> {
	try {
		await rm(path, { force: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error;
	}
}

type ConversionStage = "backup" | "template" | "task" | "log" | "archive";

class TaskConversionError extends Error {
	constructor(
		readonly stage: ConversionStage,
		readonly cause: unknown,
		readonly rollback: string,
	) {
		super(`${stage}: ${errorMessage(cause)} (rollback: ${rollback})`);
	}
}

/**
 * Copy `path` into `dir` as `<stem><ext>` without ever overwriting an existing file: an identical
 * one counts as already backed up, a differing one is kept and this copy gets `<stem>.backup-<n><ext>`.
 */
async function copyWithoutOverwrite(
	dir: string,
	stem: string,
	ext: string,
	path: string,
	content: string,
): Promise<void> {
	await mkdir(dir, { recursive: true });
	for (let n = 0; ; n++) {
		const target = join(dir, n === 0 ? `${stem}${ext}` : `${stem}.backup-${n}${ext}`);
		try {
			await copyFile(path, target, constants.COPYFILE_EXCL);
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if ((await readFile(target, "utf-8")) === content) return;
		}
	}
}

const backupOriginal = (backupDir: string, id: string, path: string, content: string) =>
	copyWithoutOverwrite(backupDir, id, ".md", path, content);

/** `readdir` that treats only "no such directory" as empty; any other failure (EACCES, EIO, ...) must surface. */
async function listDirectory(dir: string): Promise<string[]> {
	try {
		return await readdir(dir);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return [];
		throw error;
	}
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

		let stage: ConversionStage = "backup";
		let createdEvent: string | undefined;
		const logPath = join(channelDir, "tasks", `${id}.jsonl`);
		const hadLog = existsSync(logPath);
		try {
			await backupOriginal(join(channelDir, "tasks", BACKUP_DIRNAME), id, path, content);
			const original = taskBody(content);
			const notes: string[] = [];

			const stopped = v3.enabled === false || v3.stopped;
			let origin: string | undefined;
			let retire = false;
			if (v3.schedule && stopped) {
				// Event templates have no disabled state, so a stopped recurring task must not get one: it would start running.
				notes.push(
					`转换到 v5：该周期任务在 v3 中已停用，未生成事件模板（原周期 ${v3.schedule} 未迁移），任务保持暂停；原件在 tasks/.v3/。要恢复周期执行，请人工核对后用 event_manage 新建模板。`,
				);
			} else if (v3.schedule) {
				stage = "template";
				const written = await writeTemplateEvent(workspaceDir, channelId, id, original, v3.schedule);
				if (written.name) {
					createdEvent = join(workspaceDir, "events", `${written.name}.json`);
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
			if (stopped || (v3.schedule && !origin)) {
				fields.paused = {
					by: stopped ? "user" : "runtime",
					reason: stopped ? (v3.stopReason ?? DEFAULT_STOP_REASON) : "周期性无法转换为事件模板，需要人工处理。",
					at: formatLocalTime(now),
				};
			}
			if (v3.status === "waiting") {
				notes.push(
					"转换到 v5：该任务此前在等待外部条件，v5 没有对应的等待来源，已改为 open。先核对真实状态，再决定继续还是重新停泊。",
				);
			}

			stage = "task";
			await writeStoredTask({ id, path, fields, body: convertBody(original) });
			stage = "log";
			for (const note of notes) await appendTaskLog(channelDir, id, { kind: "note", note });
			if (retire) {
				stage = "archive";
				await archiveTask(channelDir, id, "cancelled");
			}
			log.logInfo(
				`Task ${id} converted to v5`,
				`state=${fields.state}${fields.paused ? " paused" : ""}${origin ? ` origin=${origin}` : ""}${retire ? " (retired)" : ""}`,
			);
			return true;
		} catch (error) {
			// Leave nothing runnable behind: put the v3 original back and drop the artifacts this attempt created.
			const failed: string[] = [];
			const attempt = async (what: string, fn: () => Promise<unknown>) => {
				try {
					await fn();
				} catch (rollbackError) {
					failed.push(`${what}: ${errorMessage(rollbackError)}`);
				}
			};
			if (stage !== "backup") {
				// archiveTask undoes its own partial work. When that undo failed, archive-side files may be the
				// only copy of the old logs: leave them (and the log) alone and report the rollback as failed.
				if (error instanceof ArchiveUndoError)
					failed.push(`rollback failed, archive undo incomplete: ${errorMessage(error)}`);
				else if (!hadLog) await attempt("remove log", () => removeIfPresent(logPath));
				if (createdEvent) {
					const eventFile = createdEvent;
					await attempt("remove template event", () => removeIfPresent(eventFile));
				}
				await attempt("restore original", () => writeFileAtomically(path, content));
			}
			throw new TaskConversionError(stage, error, failed.length === 0 ? "ok" : failed.join("; "));
		}
	});
}

/** Move task-owned sensor events (`task.<channelId>.<taskId>.<use>`) out of the way: v5 has no `signal` ticket. */
async function moveTaskOwnedEvents(workspaceDir: string, channelId: string, channelDir: string): Promise<void> {
	const eventsDir = join(workspaceDir, "events");
	const names = (await listDirectory(eventsDir)).filter((name) => name.endsWith(".json"));
	const prefix = `task.${channelId}.`;
	for (const name of names) {
		if (!name.startsWith(prefix)) continue;
		const rest = name.slice(prefix.length, -".json".length);
		const lastDot = rest.lastIndexOf(".");
		const ownerId = lastDot > 0 ? rest.slice(0, lastDot) : undefined;
		const source = join(eventsDir, name);
		// Copy (never overwriting a same-named backup), then remove the live file: if the removal
		// fails the event is still in place and the retry finds an identical backup.
		await copyWithoutOverwrite(
			join(channelDir, "tasks", BACKUP_DIRNAME, "events"),
			name.slice(0, -".json".length),
			".json",
			source,
			await readFile(source, "utf-8"),
		);
		await rm(source);
		if (ownerId && (await readStoredTask(channelDir, ownerId).catch(() => undefined))) {
			await appendTaskLog(channelDir, ownerId, {
				kind: "note",
				note: `转换到 v5：传感器事件 ${name.slice(0, -".json".length)} 已移到 tasks/.v3/events/（v5 没有 signal 票）；需要等待外部条件时，改用带超时的后台作业。`,
			});
		}
	}
}

interface MigrationFailure {
	channelId: string;
	task?: string;
	stage: string;
	error: string;
	rollback: string;
}

/**
 * Validate a failure report written by this module: a non-empty `failures` array whose entries
 * carry string `channelId` / `stage` / `error` / `rollback` (and an optional string `task`).
 * Anything else is untrustworthy and must block rather than count as "no failed rollback".
 */
function parseFailureReport(raw: string): MigrationFailure[] | undefined {
	const failures = parseJson(raw)?.failures;
	if (!Array.isArray(failures) || failures.length === 0) return undefined;
	for (const entry of failures) {
		if (!isPlainObject(entry)) return undefined;
		for (const key of ["channelId", "stage", "error", "rollback"]) {
			if (typeof entry[key] !== "string") return undefined;
		}
		if (entry.task !== undefined && typeof entry.task !== "string") return undefined;
	}
	return failures as unknown as MigrationFailure[];
}

/**
 * Convert every v3 task file in every known channel. Any failure leaves no marker, writes
 * `state/task-migration-v5.failed.json`, and throws so the caller does not start services.
 */
export async function migrateTasksToV5(workspaceDir: string, stateDir: string): Promise<void> {
	const markerPath = join(stateDir, MIGRATION_MARKER);
	if (existsSync(markerPath)) return;
	const reportPath = join(stateDir, FAILURE_REPORT);
	if (existsSync(reportPath)) {
		const blocked = (reason: string) =>
			new Error(
				`v3 → v5 task conversion is blocked: ${reportPath} ${reason}. The report was kept and no marker was written. Inspect it, restore any listed originals from tasks/.v3/ or your backup, then delete the report.`,
			);
		let raw: string;
		try {
			raw = await readFile(reportPath, "utf-8");
		} catch (error) {
			throw blocked(`could not be read (${errorMessage(error)})`);
		}
		const failures = parseFailureReport(raw);
		if (!failures) throw blocked("is not a valid failure report (unparseable or unexpected structure)");
		if (failures.some((entry) => entry.rollback !== "ok")) throw blocked("records a failed rollback");
	}
	const now = new Date();
	let converted = 0;
	const failures: MigrationFailure[] = [];
	let channelIds: string[] = [];
	try {
		channelIds = await discoverTaskChannels(workspaceDir, [], { strict: true });
	} catch (error) {
		// An undiscoverable workspace is not an empty one: no task was looked at, so no marker.
		log.logWarning("Channels of the workspace could not be discovered", errorMessage(error));
		failures.push({ channelId: "*", stage: "discover", error: errorMessage(error), rollback: "ok" });
	}
	for (const channelId of channelIds) {
		const channelDir = getChannelDir(workspaceDir, channelId);
		let filenames: string[] = [];
		try {
			filenames = (await listDirectory(join(channelDir, "tasks"))).filter((name) => name.endsWith(".md"));
		} catch (error) {
			// An unreadable task directory is not an empty one: the originals were not looked at.
			log.logWarning(`Tasks of ${channelId} could not be listed`, errorMessage(error));
			failures.push({ channelId, stage: "scan", error: errorMessage(error), rollback: "ok" });
		}
		for (const filename of filenames) {
			const id = filename.slice(0, -".md".length);
			try {
				if (await convertOneTask(workspaceDir, channelId, channelDir, normalizeTaskId(id), now)) converted++;
			} catch (error) {
				log.logWarning(`Task ${id} could not be converted to v5`, errorMessage(error));
				failures.push({
					channelId,
					task: id,
					stage: error instanceof TaskConversionError ? error.stage : "scan",
					error: errorMessage(error instanceof TaskConversionError ? error.cause : error),
					rollback: error instanceof TaskConversionError ? error.rollback : "ok",
				});
			}
		}
		await moveTaskOwnedEvents(workspaceDir, channelId, channelDir).catch((error) => {
			log.logWarning(`Task-owned events of ${channelId} could not be moved`, errorMessage(error));
			failures.push({ channelId, stage: "events", error: errorMessage(error), rollback: "ok" });
		});
	}
	await mkdir(stateDir, { recursive: true });
	if (failures.length > 0) {
		await writeFileAtomically(reportPath, `${JSON.stringify({ at: formatLocalTime(now), failures }, null, 2)}\n`);
		throw new Error(
			`v3 → v5 task conversion failed for ${failures.length} item(s); services were not started and no marker was written. See ${reportPath}; fix the cause and restart to retry.`,
		);
	}
	await rm(reportPath, { force: true });
	await writeFile(markerPath, `${formatLocalTime(now)}\n`, "utf-8");
	if (converted > 0) log.logInfo("Task conversion to v5 complete", `${converted} task(s)`);
}
