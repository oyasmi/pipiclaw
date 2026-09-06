import { existsSync } from "node:fs";
import { readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { getChannelJobManager } from "../../agent/job-manager.js";
import { createExecutor } from "../../executor.js";
import * as log from "../../log.js";
import { parseScheduledEventContent } from "../../runtime/events.js";
import { errorMessage } from "../../shared/text-utils.js";
import { getSubAgentRunManager } from "../../subagents/runs.js";
import { createCycle, nextCycleId } from "../../tasks/cycle.js";
import type { TaskBudget, TaskFrontmatterV4 } from "../../tasks/frontmatter.js";
import { renderStandardTaskBody, renderTaskDocument } from "../../tasks/ledger.js";
import type { StoredTaskDocument } from "../../tasks/store.js";
import { parseTaskEventName } from "../../tasks/task-events.js";
import { validateTaskSchedule } from "../../tasks/task-schedule.js";
import { describeTicket, type TicketContext, type TicketEventRef } from "../../tasks/ticket.js";
import { completionVerificationBlockReason } from "../../tasks/verification.js";
import { RecoverableToolError } from "../tool-details.js";
import type { TaskCloseRequest, TaskCreateRequest, TaskManageToolOptions, TaskUpdateRequest } from "./types.js";

export function tasksDir(options: TaskManageToolOptions): string {
	return join(options.channelDir, "tasks");
}

export function eventsDir(options: TaskManageToolOptions): string {
	return join(options.workspaceDir, "events");
}

export function renderTaskFile(fields: TaskFrontmatterV4, body: string): string {
	return renderTaskDocument(fields, body);
}

export function requiredField(value: string | undefined, field: string, action: string): string {
	const trimmed = value?.trim();
	if (!trimmed) throw new RecoverableToolError(`${action} requires ${field}.`);
	return trimmed;
}

export function markdownValue(value: string): string {
	const lines = value.trim().split(/\r?\n/);
	if (lines.length === 1) return lines[0];
	return lines.map((line, index) => (index === 0 ? line : `  ${line}`)).join("\n");
}

/** The `## 上次结果` paragraph a close writes into the contract. */
export function renderCloseEvidence(request: TaskCloseRequest): string {
	const summary = requiredField(request.summary, "summary", "task_close outcome=complete");
	const evidence = requiredField(request.evidence, "evidence", "task_close outcome=complete");
	const lines = [`- Summary: ${markdownValue(summary)}`, `- Evidence: ${markdownValue(evidence)}`];
	const residualRisk = request.residualRisk?.trim();
	if (residualRisk) lines.push(`- Residual risk: ${markdownValue(residualRisk)}`);
	return lines.join("\n");
}

export function normalizeBudget(budget: TaskUpdateRequest["budget"]): Partial<TaskBudget> | undefined {
	if (!budget) return undefined;
	const next: Partial<TaskBudget> = {};
	for (const key of ["steps", "wallMin", "usd", "rounds"] as const) {
		const value = budget[key];
		if (value === undefined) continue;
		if (!Number.isFinite(value) || value <= 0) {
			throw new RecoverableToolError(`budget.${key} must be a positive number.`);
		}
		next[key] = value;
	}
	if (budget.until !== undefined) next.until = budget.until.trim() || undefined;
	return Object.keys(next).length > 0 ? next : undefined;
}

export function normalizeSchedule(schedule: string | undefined): string | undefined | null {
	if (schedule === undefined) return undefined;
	const trimmed = schedule.trim();
	if (!trimmed) return null; // explicit clear
	validateTaskSchedule(trimmed);
	return trimmed;
}

/**
 * A newly created task starts `open` — even a recurring one. Creation opens its first cycle
 * immediately rather than parking until the next cron occurrence, because "create it and it does
 * nothing until tomorrow morning" was consistently surprising; the cadence still governs every
 * *subsequent* cycle through the `schedule` ticket the loop parks on when it finishes.
 */
export function renderTaskSkeleton(
	request: TaskCreateRequest,
	now: Date = new Date(),
): {
	fields: TaskFrontmatterV4;
	body: string;
} {
	const schedule = normalizeSchedule(request.schedule);
	const fields: TaskFrontmatterV4 = {
		state: "open",
		schedule: schedule ?? undefined,
		// The first cycle opens at creation: steps, rework rounds and cost all accumulate onto a
		// cycle, so a task without one would have nowhere to record what it did.
		cycle: createCycle(nextCycleId(undefined, now), now),
		budget: normalizeBudget(request.budget),
		verify: request.verificationRequired ? "required" : undefined,
	};
	const body = renderStandardTaskBody({
		title: request.title,
		goal: request.goal,
		dod: request.dod,
		manual: request.manual,
		verificationPlan: request.verificationPlan,
		verificationRequired: request.verificationRequired ?? false,
		plan: request.plan,
	});
	return { fields, body };
}

/** The scheduling half of a lifecycle notice: where the task stands and who will wake it. */
export function describeTaskState(fields: TaskFrontmatterV4): string {
	if (fields.paused) return `state: ${fields.state}（已暂停：${fields.paused.reason}）`;
	if (fields.state === "parked" && fields.ticket) {
		return `state: parked（${describeTicket(fields.ticket)}；兜底 ${fields.ticket.by}）`;
	}
	return `state: ${fields.state}`;
}

/**
 * Build the injected lookup a ticket resolver needs. The run/job/event registries are read here —
 * once, at the call site — rather than imported inside `ticket.ts`, which is what keeps the whole
 * validation matrix unit-testable against plain fakes.
 */
export async function buildTicketContext(
	options: TaskManageToolOptions,
	taskId: string,
	schedule: string | undefined,
	now: Date = new Date(),
): Promise<TicketContext> {
	const runManager = getSubAgentRunManager(options.channelId);
	const jobs = await getChannelJobManager(options.channelId, createExecutor())
		.list()
		.catch(() => []);
	const events = await readChannelEvents(options);
	return {
		now,
		taskId,
		channelId: options.channelId,
		schedule,
		findRun: (id) => runManager.get(id),
		findJob: (id) => jobs.find((job) => job.id === id),
		findEvent: (name) => events.get(name),
	};
}

/** Every parseable event definition in the workspace, by name. Missing directory → empty. */
async function readChannelEvents(options: TaskManageToolOptions): Promise<Map<string, TicketEventRef>> {
	const dir = eventsDir(options);
	const events = new Map<string, TicketEventRef>();
	if (!existsSync(dir)) return events;
	for (const filename of await readdir(dir)) {
		if (!filename.endsWith(".json")) continue;
		try {
			const event = parseScheduledEventContent(await readFile(join(dir, filename), "utf-8"), filename);
			events.set(filename.slice(0, -".json".length), {
				type: event.type,
				channelId: event.channelId,
				schedule: event.type === "periodic" ? event.schedule : undefined,
			});
		} catch {
			// An unparseable event cannot back a ticket; leave it for /events to clean up.
		}
	}
	return events;
}

/**
 * On close-out (complete or cancel), delete every task-owned event.
 *
 * Matching is done by parsing each candidate name and comparing the full task id, not by prefix —
 * a prefix match on `task.<channel>.<id>.` would also match a *different* task whose id happens to
 * start with this one plus a dot (e.g. closing "v1" must not delete events owned by "v1.2-release").
 */
export async function cleanupTaskEvents(options: TaskManageToolOptions, id: string): Promise<{ deleted: string[] }> {
	const dir = eventsDir(options);
	if (!existsSync(dir)) return { deleted: [] };

	const deleted: string[] = [];
	for (const filename of (await readdir(dir)).sort()) {
		if (!filename.endsWith(".json")) continue;
		const parsed = parseTaskEventName(filename.slice(0, -".json".length), options.channelId);
		if (parsed?.id !== id) continue;
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

/**
 * The verification gate both close entry points share (`task_step_end outcome=done` and
 * `task_close outcome=complete`).
 *
 * It exists as one function because the two used to ask the question separately and both asked
 * the weaker one — "did a PASS ever land in this cycle" — which a contract edit or a further code
 * change made *after* the PASS would still satisfy. The real check is re-run here, against the
 * contract and the checkout as they stand at close time.
 */
export async function assertVerificationHoldsForClose(
	options: TaskManageToolOptions,
	document: StoredTaskDocument,
	id: string,
): Promise<void> {
	if (document.fields.verify !== "required") return;
	const runManager = getSubAgentRunManager(options.channelId);
	const reason = await completionVerificationBlockReason({
		channelDir: options.channelDir,
		taskId: id,
		taskBody: document.body,
		cycleId: document.fields.cycle?.id,
		findRunWorkingDirectory: (runId) => runManager.get(runId)?.workingDirectory,
		fallbackWorkingDirectory: options.workingDirectory,
	});
	if (!reason) return;
	throw new RecoverableToolError(
		`Task "${id}" requires independent verification and it does not currently hold: ${reason}. ` +
			`Dispatch a purpose=verify sub-agent with taskId=${id} against the artifact you are about to deliver, and let its PASS land before finishing.`,
	);
}
