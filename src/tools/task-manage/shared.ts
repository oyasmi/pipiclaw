import { existsSync } from "node:fs";
import { readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import * as log from "../../log.js";
import { parseScheduledEventContent } from "../../runtime/events.js";
import { formatLocalTime, parseWakeInput } from "../../shared/local-time.js";
import { taskEventPrefix } from "../../shared/task-events.js";
import { nextTaskWake, validateTaskSchedule } from "../../shared/task-schedule.js";
import { errorMessage } from "../../shared/text-utils.js";
import { applyTaskControlPatch, createDefaultTaskControl, type TaskControlPatch } from "../../tasks/control.js";
import {
	parseTaskFrontmatter,
	renderStandardTaskBody,
	renderTaskDocument,
	taskBody,
	upsertCurrentCycleCompletionEvidence,
} from "../../tasks/ledger.js";
import { isSettableTaskStatus } from "../../tasks/transitions.js";
import { RecoverableToolError } from "../tool-details.js";
import { SETTABLE_STATUSES } from "./schema.js";
import type { TaskFields, TaskManageRequest, TaskManageToolOptions } from "./types.js";

export function tasksDir(options: TaskManageToolOptions): string {
	return join(options.channelDir, "tasks");
}

export function eventsDir(options: TaskManageToolOptions): string {
	return join(options.workspaceDir, "events");
}

export function renderTaskFile(fields: TaskFields, body: string): string {
	return renderTaskDocument(fields, body);
}

export function requiredField(value: string | undefined, field: string, action: string): string {
	const trimmed = value?.trim();
	if (!trimmed) {
		throw new RecoverableToolError(`action "${action}" requires ${field}.`);
	}
	return trimmed;
}

export function requireNonEmpty(value: string | undefined, field: string): string {
	return requiredField(value, field, "done");
}

export function markdownValue(value: string): string {
	const lines = value.trim().split(/\r?\n/);
	if (lines.length === 1) return lines[0];
	return lines.map((line, index) => (index === 0 ? line : `  ${line}`)).join("\n");
}

export function appendCompletionEvidence(body: string, request: TaskManageRequest): string {
	const summary = requireNonEmpty(request.summary, "summary");
	const evidence = requireNonEmpty(request.evidence, "evidence");
	const lines = [`- Summary: ${markdownValue(summary)}`, `- Evidence: ${markdownValue(evidence)}`];
	const residualRisk = request.residualRisk?.trim();
	if (residualRisk) {
		lines.push(`- Residual risk: ${markdownValue(residualRisk)}`);
	}
	return upsertCurrentCycleCompletionEvidence(body, lines);
}

function normalizeCreateStatus(status: string | undefined): (typeof SETTABLE_STATUSES)[number] {
	if (status === undefined) return "active";
	if (isSettableTaskStatus(status)) return status;
	throw new RecoverableToolError(`Invalid status "${status}". Use one of ${SETTABLE_STATUSES.join(", ")}.`);
}

export function renderTaskSkeleton(request: TaskManageRequest): {
	fields: TaskFields;
	body: string;
} {
	const title = requiredField(request.title, "title", "create");
	const goal = requiredField(request.goal, "goal", "create");
	const dod = requiredField(request.dod, "dod", "create");
	// Independent verification is a real tax (an extra dispatch round plus a verifier
	// sub-agent run) that only pays off when there is something a read-only verifier can
	// actually check, so it is opt-in. `applyTaskControlPatch` still turns it on by default
	// for external side effects (spec 036, D5).
	const control = applyTaskControlPatch(
		createDefaultTaskControl(request.control?.verificationRequired ?? false),
		request.control ?? {},
	);
	const fields = applySet({ status: normalizeCreateStatus(request.status), control }, request);
	// First-cycle scheduling. A recurring task created without an explicit wake follows cron
	// semantics: its first run is deferred to the next scheduled occurrence, not fired now.
	// Without this the task is `active` + no `wake` → immediately actionable, so the driver
	// resumes it the instant it is created (ignoring the schedule) and re-dispatches it every
	// backoff interval; an agent expecting a scheduled wake then idles through those dispatches.
	// Seeding the first wake here mirrors what `done` does for every subsequent cycle. Only a
	// freshly opened task with no caller-supplied wake is seeded — an explicit wake (including a
	// past one for "start now") or a non-active initial status is always honoured verbatim.
	if (fields.schedule && fields.status === "active" && request.wake === undefined) {
		const next = nextTaskWake(fields.schedule);
		fields.wake = next ? formatLocalTime(next) : undefined;
	}
	const body = renderStandardTaskBody({
		title,
		goal,
		dod,
		manual: request.manual,
		verificationPlan: request.verificationPlan,
		verificationRequired: control.verification.required,
	});
	return { fields, body };
}

/**
 * Read a task file and split it into validated frontmatter and a verbatim body.
 * Fail-closed: an unreadable frontmatter block is rejected (fix it with edit first)
 * rather than guessed at, so task_manage never silently mangles a body.
 */
export async function readTaskDocument(
	taskPath: string,
	id: string,
	allowControlRepair = false,
): Promise<{ fields: TaskFields; body: string }> {
	if (!existsSync(taskPath)) {
		throw new RecoverableToolError(`Task "${id}" does not exist; create it with task_manage action "create" first.`);
	}
	const content = await readFile(taskPath, "utf-8");
	const frontmatter = parseTaskFrontmatter(content);
	if (!frontmatter.readable) {
		throw new RecoverableToolError(
			`Task "${id}" has no readable frontmatter; fix it with edit before using task_manage.`,
		);
	}
	if (frontmatter.controlReadable === false && !allowControlRepair) {
		throw new RecoverableToolError(
			`Task "${id}" has invalid control metadata; repair it with task_manage action "set" and an explicit control patch first.`,
		);
	}
	return {
		fields: {
			status: frontmatter.status ?? "active",
			wake: frontmatter.wake,
			schedule: frontmatter.schedule,
			recurrence: frontmatter.recurrence,
			control: frontmatter.control,
		},
		body: taskBody(content),
	};
}

/**
 * The scheduling half of a lifecycle notice: where the task stands and who will wake it.
 *
 * Parking (`waiting` with no wake) is the one state whose consequence is not obvious from the
 * status alone — the driver deliberately never returns to it — so the notice says so at the
 * moment the model chooses it, rather than leaving it to be rediscovered by a task that goes quiet.
 */
export function describeTaskSchedule(fields: TaskFields): string {
	if (fields.status === "waiting" && !fields.wake) {
		return "status: waiting（已停泊：driver 不会再叫你，等后台作业结束、用户消息或 /tasks run）";
	}
	return `status: ${fields.status}${fields.wake ? `, wake: ${fields.wake}` : ""}`;
}

/** Apply a `set` request's optional fields onto the existing frontmatter. */
export function applySet(fields: TaskFields, request: TaskManageRequest): TaskFields {
	const next: TaskFields = { ...fields };
	// The schema does not offer "granted", but the check stays: this is the only place that
	// guarantees a self-granted approval cannot reach disk, whatever the caller sends.
	const patch: TaskControlPatch = request.control ?? {};
	if (patch.externalApproval === "granted") {
		throw new Error('Only a user can grant external-action approval with "/tasks approve <id>".');
	}
	if (request.status !== undefined) {
		if (!isSettableTaskStatus(request.status)) {
			throw new RecoverableToolError(
				`Invalid status "${request.status}". Use one of ${SETTABLE_STATUSES.join(", ")}, or action "done".`,
			);
		}
		next.status = request.status;
	}
	if (request.wake !== undefined) {
		const trimmed = request.wake.trim();
		if (trimmed === "") {
			next.wake = undefined;
		} else {
			const ms = parseWakeInput(trimmed);
			if (ms === undefined) {
				throw new RecoverableToolError(
					`wake "${request.wake}" is not a valid local time (e.g. 2026-07-27T07:30:00+08:00) or relative offset (e.g. +2h).`,
				);
			}
			next.wake = formatLocalTime(new Date(ms));
		}
	}
	if (request.schedule !== undefined) {
		const trimmed = request.schedule.trim();
		if (trimmed === "") {
			next.schedule = undefined;
		} else {
			validateTaskSchedule(trimmed);
			next.schedule = trimmed;
			// A cadence change without an explicit new wake in the same call means the old
			// wake belongs to the old rhythm — recompute it against the new cron so a stale
			// or hand-typed value can never silently point at an occurrence the new schedule
			// doesn't have. A parked task (waiting, no wake) is left parked: it intentionally
			// has no wake at all, and this must not be the thing that gives it one.
			const parked = next.status === "waiting" && next.wake === undefined;
			if (request.wake === undefined && !parked) {
				const nextWake = nextTaskWake(trimmed);
				if (nextWake) next.wake = formatLocalTime(nextWake);
			}
		}
	}
	if (request.recurrence !== undefined) {
		const trimmed = request.recurrence.trim();
		next.recurrence = trimmed === "" ? undefined : trimmed;
	}
	if (request.control !== undefined) {
		next.control = applyTaskControlPatch(next.control ?? createDefaultTaskControl(), request.control);
	}
	// A done recurring task's wake is the single time rule's job: `normalizeTaskFields` fills the
	// next occurrence on the write path, so no per-action recompute lives here anymore (D1).
	return next;
}

/**
 * On close-out (done or cancel), delete every task-owned event.
 *
 * Recurrence cadence now lives solely in the task's `schedule` frontmatter (027/029), so a
 * recurring task needs no surviving `.schedule` event — the driver reopens each cycle from
 * frontmatter. Any remaining task-owned events are temporary sensors/check-ins that a closed
 * task should not keep alive. A file that cannot be parsed is left for `/events` to handle.
 */
export async function cleanupTaskEvents(options: TaskManageToolOptions, id: string): Promise<{ deleted: string[] }> {
	const dir = eventsDir(options);
	if (!existsSync(dir)) return { deleted: [] };

	const prefix = taskEventPrefix(options.channelId, id);
	const deleted: string[] = [];

	for (const filename of (await readdir(dir)).sort()) {
		if (!filename.endsWith(".json") || !filename.startsWith(prefix)) continue;
		const eventPath = join(dir, filename);
		let content: string;
		try {
			content = await readFile(eventPath, "utf-8");
		} catch (error) {
			log.logWarning(
				`Could not read task-owned event ${filename} during cleanup`,
				`${errorMessage(error)}. Fix filesystem access, then use /events show ${filename.slice(0, -".json".length)} and retry cleanup.`,
			);
			continue;
		}
		try {
			parseScheduledEventContent(content, filename);
		} catch {
			continue; // can't classify → leave it for /events to handle
		}
		await unlink(eventPath);
		deleted.push(filename.slice(0, -".json".length));
	}
	return { deleted };
}
