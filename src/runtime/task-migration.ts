import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getChannelDir } from "../channel/channel-paths.js";
import * as log from "../log.js";
import { formatLocalTime, parseLocalTime } from "../shared/local-time.js";
import { errorMessage } from "../shared/text-utils.js";
import { isPlainObject } from "../shared/type-guards.js";
import { writeLastResult } from "../tasks/cycle.js";
import type { TaskCycle, TaskFrontmatterV4 } from "../tasks/frontmatter.js";
import { findTaskSectionBounds, normalizeTaskId, taskBody } from "../tasks/ledger.js";
import { appendTaskLog } from "../tasks/log.js";
import { withTaskMutation } from "../tasks/mutation-lock.js";
import { writeStoredTask } from "../tasks/store.js";
import { nextTaskWake } from "../tasks/task-schedule.js";
import type { Ticket } from "../tasks/ticket.js";
import { discoverTaskChannels } from "./task-driver.js";

/**
 * One-time, deterministic, no-LLM migration from the v3 task contract to v4 (spec 051, D14).
 *
 * The single most valuable thing this pass does is the `waiting` conversion. A v3 task could be
 * `waiting` with no `wake` and a purely decorative `waitingFor`, which meant *nothing would ever
 * resume it* — on the author's own machine two tasks had been silently dead for 9 and 13 days.
 * v4 has no such state: a park needs a ticket the runtime can redeem. So a `waiting` task whose
 * resumption source can still be reconstructed (a real future `wake`, or a live schedule) is
 * parked on the matching ticket, and **anything else is reopened** with a note explaining why.
 * Upgrading is therefore also the repair.
 *
 * Originals are copied to `tasks/.v3/` and never deleted. `workspace/events/` is not touched at
 * all — spec 051 D8 keeps the events subsystem exactly as it is.
 */
const MIGRATION_MARKER = "task-migration-v4.done";

interface LegacyControl {
	deadline?: string;
	nextAction?: string;
	cycleId?: string;
	verification?: { required?: boolean };
	stop?: { by?: string; reason?: string; at?: string };
}

interface LegacyFields {
	status?: string;
	enabled: boolean;
	wake?: string;
	schedule?: string;
	control?: LegacyControl;
	outcome?: "completed" | "cancelled";
	closedAt?: string;
}

/** Minimal reader for the v3 frontmatter block; the only place that still understands it. */
function parseLegacyFrontmatter(content: string): LegacyFields | undefined {
	if (!content.startsWith("---")) return undefined;
	const end = content.indexOf("\n---", 3);
	if (end === -1) return undefined;
	const fields: LegacyFields = { enabled: true };
	let sawLegacy = false;
	for (const line of content.slice(3, end).split("\n")) {
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		const key = line.slice(0, idx).trim();
		const value = line.slice(idx + 1).trim();
		switch (key) {
			case "status":
				fields.status = value;
				sawLegacy = true;
				break;
			case "enabled":
				fields.enabled = value !== "false";
				sawLegacy = true;
				break;
			case "wake":
				fields.wake = value || undefined;
				break;
			case "schedule":
				fields.schedule = value || undefined;
				break;
			case "outcome":
				if (value === "completed" || value === "cancelled") fields.outcome = value;
				break;
			case "closedAt":
				fields.closedAt = value || undefined;
				break;
			case "control": {
				sawLegacy = true;
				try {
					const parsed: unknown = JSON.parse(value);
					if (isPlainObject(parsed)) fields.control = parsed as LegacyControl;
				} catch {
					// An unparseable control block is exactly why the task needs migrating; drop it.
				}
				break;
			}
			default:
				break;
		}
	}
	// `state:` means this file is already v4.
	if (/^state:/m.test(content.slice(3, end))) return undefined;
	return sawLegacy || fields.outcome ? fields : undefined;
}

function legacyCycle(control: LegacyControl | undefined): TaskCycle | undefined {
	if (!control?.cycleId) return undefined;
	return {
		id: control.cycleId.replace(/^cycle-/, "c-"),
		startedAt: formatLocalTime(),
		steps: 0,
		rounds: 0,
		usd: 0,
		usdEstimated: false,
		expired: 0,
	};
}

export interface LegacyTaskConversion {
	fields: TaskFrontmatterV4;
	/** Set when the v3 park had no reconstructible source and the task was reopened instead. */
	repairNote?: string;
}

/**
 * The v3 → v4 field mapping. Exported for the migration test, which pins the one branch that
 * matters most: a `waiting` task with no wake and no schedule becomes `open`, not a dead park.
 */
export function convertLegacyTaskFields(legacy: LegacyFields, now: Date = new Date()): LegacyTaskConversion {
	const control = legacy.control;
	const fields: TaskFrontmatterV4 = {
		state: "open",
		schedule: legacy.schedule,
		cycle: legacyCycle(control),
		verify: control?.verification?.required ? "required" : undefined,
	};
	if (control?.deadline && parseLocalTime(control.deadline) !== undefined) {
		fields.budget = { until: control.deadline };
	}
	if (legacy.outcome) {
		fields.outcome = legacy.outcome;
		fields.closedAt = legacy.closedAt ?? formatLocalTime(now);
		fields.state = "done";
		return { fields };
	}
	if (!legacy.enabled) {
		fields.paused = {
			by: control?.stop?.by === "governor" ? "runtime" : "user",
			reason: control?.stop?.reason ?? "迁移前该任务已被停用。",
			at: control?.stop?.at ?? formatLocalTime(now),
		};
	}

	const wakeMs = legacy.wake ? parseLocalTime(legacy.wake) : undefined;
	const futureWake = wakeMs !== undefined && wakeMs > now.getTime();
	if (legacy.status === "sleeping" && legacy.schedule && nextTaskWake(legacy.schedule, now)) {
		const by = nextTaskWake(legacy.schedule, now);
		const second = by ? nextTaskWake(legacy.schedule, by) : undefined;
		fields.state = "parked";
		fields.ticket = { kind: "schedule", at: formatLocalTime(by ?? now), by: formatLocalTime(second ?? by ?? now) };
		return { fields };
	}
	if (legacy.status === "waiting" && futureWake && legacy.wake) {
		const at = formatLocalTime(new Date(wakeMs));
		fields.state = "parked";
		fields.ticket = { kind: "time", at, by: at } satisfies Ticket;
		return { fields };
	}
	if (legacy.status === "waiting") {
		return {
			fields,
			repairNote:
				"迁移提示：该任务此前处于 waiting，但没有任何可兑现的恢复来源（无有效 wake、无在跑的委派或作业）。" +
				"已改为 open。先确认真实状态，再决定继续推进还是重新用 task_step_end 停泊到一张明确的等待票上。" +
				(control?.nextAction ? `迁移前记录的下一步：${control.nextAction}` : ""),
		};
	}
	return { fields };
}

/** Move the v3 `## History` entries into the loop log so nothing is lost when the section goes. */
async function importLegacyHistory(channelDir: string, id: string, body: string, cycleId: string): Promise<number> {
	const lines = body.split("\n");
	const bounds = findTaskSectionBounds(lines, ["History", "历史"]);
	if (!bounds) return 0;
	const entries: string[] = [];
	let current: string[] = [];
	for (let index = bounds.headingIndex + 1; index < bounds.end; index++) {
		const line = lines[index] ?? "";
		if (/^#{3,6}\s+/.test(line)) {
			if (current.length > 0) entries.push(current.join("\n").trim());
			current = [line];
			continue;
		}
		current.push(line);
	}
	if (current.length > 0) entries.push(current.join("\n").trim());
	const kept = entries.filter(Boolean);
	for (const [index, entry] of kept.entries()) {
		await appendTaskLog(channelDir, id, {
			cycle: cycleId,
			kind: "step",
			seq: index + 1,
			outcome: "continue",
			note: entry,
			tools: [],
		});
	}
	return kept.length;
}

/** Strip `## Current Cycle` and `## History` from a v3 body, returning the last cycle note. */
function stripLegacySections(body: string): { body: string; lastNote?: string } {
	let working = body;
	let lastNote: string | undefined;
	for (const names of [
		["Current Cycle", "当前周期"],
		["History", "历史"],
	] as const) {
		const lines = working.split("\n");
		const bounds = findTaskSectionBounds(lines, names);
		if (!bounds) continue;
		if (names[0] === "Current Cycle") {
			const text = lines
				.slice(bounds.headingIndex + 1, bounds.end)
				.join("\n")
				.trim();
			if (text) lastNote = text;
		}
		lines.splice(bounds.headingIndex, bounds.end - bounds.headingIndex);
		working = lines.join("\n");
	}
	return { body: working.replace(/\n{3,}/g, "\n\n").trimEnd(), lastNote };
}

async function migrateOneTask(channelDir: string, id: string, now: Date): Promise<boolean> {
	return withTaskMutation(channelDir, id, async () => {
		const path = join(channelDir, "tasks", `${id}.md`);
		const content = await readFile(path, "utf-8");
		const legacy = parseLegacyFrontmatter(content);
		if (!legacy) return false;

		const backupDir = join(channelDir, "tasks", ".v3");
		await mkdir(backupDir, { recursive: true });
		await copyFile(path, join(backupDir, `${id}.md`));

		const { fields, repairNote } = convertLegacyTaskFields(legacy, now);
		const original = taskBody(content);
		const stripped = stripLegacySections(original);
		const imported = await importLegacyHistory(channelDir, id, original, fields.cycle?.id ?? "c-legacy");

		let body = stripped.body;
		const lastResult = [repairNote, stripped.lastNote].filter(Boolean).join("\n\n");
		if (lastResult) body = writeLastResult(body, lastResult);

		await writeStoredTask({ id, path, fields, body });
		log.logInfo(
			`Task ${id} migrated to v4`,
			`state=${fields.state}${fields.ticket ? ` ticket=${fields.ticket.kind}` : ""} history=${imported}`,
		);
		return true;
	});
}

/** Migrate every task file in every known channel. Failures are logged and skipped. */
export async function migrateTasksToV4(workspaceDir: string, stateDir: string): Promise<void> {
	const markerPath = join(stateDir, MIGRATION_MARKER);
	if (existsSync(markerPath)) return;
	const now = new Date();
	let migrated = 0;
	for (const channelId of await discoverTaskChannels(workspaceDir)) {
		const channelDir = getChannelDir(workspaceDir, channelId);
		let filenames: string[];
		try {
			filenames = (await readdir(join(channelDir, "tasks"))).filter((name) => name.endsWith(".md"));
		} catch {
			continue;
		}
		for (const filename of filenames) {
			const id = filename.slice(0, -".md".length);
			try {
				if (await migrateOneTask(channelDir, normalizeTaskId(id), now)) migrated++;
			} catch (error) {
				log.logWarning(`Task ${id} could not be migrated to v4`, errorMessage(error));
			}
		}
	}
	await mkdir(stateDir, { recursive: true });
	await writeFile(markerPath, `${formatLocalTime(now)}\n`, "utf-8");
	if (migrated > 0) log.logInfo("Task migration to v4 complete", `${migrated} task(s)`);
}
