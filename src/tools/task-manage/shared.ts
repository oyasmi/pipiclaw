import { existsSync } from "node:fs";
import { readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { parseScheduledEventContent } from "../../runtime/events.js";
import { taskEventPrefix } from "../../shared/task-events.js";
import {
	parseTaskFrontmatter,
	readActiveTasks,
	renderStandardTaskBody,
	renderTaskDocument,
	taskBody,
	upsertCurrentCycleCompletionEvidence,
} from "../../shared/task-ledger.js";
import { nextTaskWake, validateTaskSchedule } from "../../shared/task-schedule.js";
import { applyTaskControlPatch, createDefaultTaskControl } from "../../tasks/control.js";
import { readStoredTask } from "../../tasks/store.js";
import { isSettableTaskStatus } from "../../tasks/transitions.js";
import { RecoverableToolError } from "../tool-details.js";
import { SETTABLE_STATUSES } from "./schema.js";
import type { TaskFields, TaskManageRequest, TaskManageToolOptions } from "./types.js";

export function tasksDir(options: TaskManageToolOptions): string {
	return join(options.channelDir, "tasks");
}

export function assertCostBudgetAvailable(options: TaskManageToolOptions, request: TaskManageRequest): void {
	if (
		request.control?.maxCostUsd !== undefined &&
		request.control.maxCostUsd > 0 &&
		options.costTrackingAvailable === false
	) {
		throw new RecoverableToolError(
			"maxCostUsd requires model pricing, but the current model has no price metadata. Configure model pricing or use maxTokens instead.",
		);
	}
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

export function renderTaskSkeleton(request: TaskManageRequest): { fields: TaskFields; body: string } {
	const title = requiredField(request.title, "title", "create");
	const goal = requiredField(request.goal, "goal", "create");
	const dod = requiredField(request.dod, "dod", "create");
	// Independent verification is a real tax (an extra dispatch round plus a verifier
	// sub-agent run) that only pays off when there is something a read-only verifier can
	// actually check. Default to evidence (maker self-checks the DoD); the tool schema asks
	// the model to opt into independent explicitly for tasks with a checkable artifact.
	const mode = request.control?.verificationMode ?? "evidence";
	const control = applyTaskControlPatch(createDefaultTaskControl(mode), request.control ?? {});
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
		fields.wake = nextTaskWake(fields.schedule)?.toISOString();
	}
	const body = renderStandardTaskBody({
		title,
		goal,
		dod,
		manual: request.manual,
		verificationPlan: request.verificationPlan,
		verificationMode: control.verification.mode,
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

/** Apply a `set` request's optional fields onto the existing frontmatter. */
export function applySet(fields: TaskFields, request: TaskManageRequest): TaskFields {
	const next: TaskFields = { ...fields };
	if (request.control?.externalApproval === "granted") {
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
		} else if (!Number.isFinite(new Date(trimmed).getTime())) {
			throw new RecoverableToolError(`wake "${request.wake}" is not a valid ISO8601 date.`);
		} else {
			next.wake = trimmed;
		}
	}
	if (request.schedule !== undefined) {
		const trimmed = request.schedule.trim();
		if (trimmed === "") {
			next.schedule = undefined;
		} else {
			validateTaskSchedule(trimmed);
			next.schedule = trimmed;
		}
	}
	if (request.recurrence !== undefined) {
		const trimmed = request.recurrence.trim();
		next.recurrence = trimmed === "" ? undefined : trimmed;
	}
	if (request.control !== undefined) {
		next.control = applyTaskControlPatch(next.control ?? createDefaultTaskControl("evidence"), request.control);
	}
	// A done recurring task's wake is the single time rule's job: `normalizeTaskFields` fills the
	// next occurrence on the write path, so no per-action recompute lives here anymore (D1).
	return next;
}

export async function validateTaskRelations(
	options: TaskManageToolOptions,
	id: string,
	fields: TaskFields,
): Promise<void> {
	const control = fields.control;
	if (!control) return;
	if (control.parent === id || control.dependsOn.includes(id)) {
		throw new RecoverableToolError(`Task "${id}" cannot be its own parent or dependency.`);
	}
	for (const relatedId of [control.parent, ...control.dependsOn].filter((value): value is string => Boolean(value))) {
		const active = join(tasksDir(options), `${relatedId}.md`);
		const archived = join(tasksDir(options), "archive", `${relatedId}.md`);
		if (!existsSync(active) && !existsSync(archived)) {
			throw new RecoverableToolError(
				`Related task "${relatedId}" does not exist; create it before linking task "${id}".`,
			);
		}
	}

	if (control.parent) {
		const visited = new Set<string>();
		let current: string | undefined = control.parent;
		while (current) {
			if (visited.has(current)) {
				throw new RecoverableToolError(`Existing parent chain for "${control.parent}" already contains a cycle.`);
			}
			if (current === id) {
				throw new RecoverableToolError(`Task parent cycle detected while linking "${id}" to "${control.parent}".`);
			}
			visited.add(current);
			const task = await readStoredTask(options.channelDir, current, true);
			current = task?.fields.control?.parent;
		}
	}

	for (const dependencyId of control.dependsOn) {
		const visited = new Set<string>();
		const stack = [dependencyId];
		while (stack.length > 0) {
			const current = stack.pop();
			if (!current || visited.has(current)) continue;
			if (current === id) {
				throw new RecoverableToolError(
					`Task dependency cycle detected while linking "${id}" to "${dependencyId}".`,
				);
			}
			visited.add(current);
			const task = await readStoredTask(options.channelDir, current, true);
			stack.push(...(task?.fields.control?.dependsOn ?? []));
		}
	}
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
		try {
			parseScheduledEventContent(await readFile(eventPath, "utf-8"), filename);
		} catch {
			continue; // can't classify → leave it for /events to handle
		}
		await unlink(eventPath);
		deleted.push(filename.slice(0, -".json".length));
	}
	return { deleted };
}

export async function unfinishedChildren(options: TaskManageToolOptions, parentId: string): Promise<string[]> {
	const entries = await readActiveTasks(tasksDir(options));
	return entries
		.filter(
			(entry) =>
				entry.frontmatter.control?.parent === parentId &&
				entry.frontmatter.status !== "done" &&
				entry.frontmatter.status !== "cancelled",
		)
		.map((entry) => entry.id);
}
