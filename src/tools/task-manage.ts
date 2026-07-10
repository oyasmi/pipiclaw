import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { parseScheduledEventContent } from "../runtime/events.js";
import { writeFileAtomically } from "../shared/atomic-file.js";
import { isTaskScheduleEvent, taskEventPrefix, taskScheduleEventFilename } from "../shared/task-events.js";
import {
	appendCurrentCycleNote,
	normalizeTaskId,
	parseTaskFrontmatter,
	readActiveTasks,
	renderStandardTaskBody,
	renderTaskDocument,
	startTaskCycle,
	taskBody,
	uncheckedTaskAcceptanceItems,
} from "../shared/task-ledger.js";
import { workspaceSubjectHash } from "../tasks/artifact-subject.js";
import {
	applyTaskControlPatch,
	createDefaultTaskControl,
	invalidateTaskApproval,
	invalidateTaskVerification,
	resetTaskControlForCycle,
	type TaskControl,
	type TaskControlPatch,
} from "../tasks/control.js";
import { dependencyState, readStoredTask, taskBodyHash } from "../tasks/store.js";
import { readVerificationAttestation } from "../tasks/verification.js";

const SETTABLE_STATUSES = ["open", "in-progress", "awaiting-user", "blocked", "paused"] as const;

const taskControlSchema = Type.Object({
	priority: Type.Optional(
		Type.Union([Type.Literal("low"), Type.Literal("normal"), Type.Literal("high"), Type.Literal("critical")]),
	),
	deadline: Type.Optional(Type.String({ description: "ISO8601 deadline; empty string clears it." })),
	nextAction: Type.Optional(Type.String({ description: "Concrete next executable step; empty string clears it." })),
	lastOutcome: Type.Optional(
		Type.Union([
			Type.Literal("pending"),
			Type.Literal("running"),
			Type.Literal("progress"),
			Type.Literal("blocked"),
			Type.Literal("failed"),
			Type.Literal("verified"),
		]),
	),
	blockedReason: Type.Optional(Type.String({ description: "Why work cannot currently proceed; empty clears it." })),
	parent: Type.Optional(Type.String({ description: "Parent task id; empty clears it." })),
	dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Task ids that must be done first." })),
	isolation: Type.Optional(Type.Union([Type.Literal("shared"), Type.Literal("worktree")])),
	sideEffects: Type.Optional(
		Type.Union([Type.Literal("read-only"), Type.Literal("workspace"), Type.Literal("external")]),
	),
	externalApproval: Type.Optional(
		Type.Union([Type.Literal("not-required"), Type.Literal("required")], {
			description: 'External approval can only be granted by a user with "/tasks approve <id>".',
		}),
	),
	maxAttempts: Type.Optional(Type.Integer({ minimum: 1 })),
	maxTokens: Type.Optional(Type.Number({ minimum: 0, description: "0 clears this budget." })),
	maxCostUsd: Type.Optional(Type.Number({ minimum: 0, description: "0 clears this budget." })),
	maxWallTimeMinutes: Type.Optional(Type.Number({ minimum: 0, description: "0 clears this budget." })),
	verificationMode: Type.Optional(Type.Union([Type.Literal("evidence"), Type.Literal("independent")])),
	worktreePath: Type.Optional(Type.String({ description: "Owned worktree path; empty clears it." })),
	worktreeBranch: Type.Optional(Type.String()),
});

const taskManageSchema = Type.Object({
	label: Type.String({ description: "Brief description of the ledger change (shown to the user)" }),
	action: Type.Union(
		[
			Type.Literal("create"),
			Type.Literal("progress"),
			Type.Literal("set"),
			Type.Literal("verify"),
			Type.Literal("done"),
			Type.Literal("cancel"),
			Type.Literal("start-cycle"),
			Type.Literal("candidate"),
			Type.Literal("list"),
		],
		{
			description:
				'"create" writes a governed task; "progress" atomically checkpoints work; "candidate" requests independent verification; "set" repairs metadata; "verify" imports an independent verifier attestation; "done" closes verified work; "cancel" closes abandoned work; "start-cycle" opens a completed recurring task; "list" returns tasks.',
		},
	),
	id: Type.Optional(
		Type.String({ description: "Task id (filename without .md). Required for create/progress/set/done." }),
	),
	title: Type.Optional(Type.String({ description: "Required for create: task title used as the H1 heading." })),
	goal: Type.Optional(Type.String({ description: "Required for create: concise task goal." })),
	dod: Type.Optional(
		Type.String({
			description:
				'Required for create: acceptance criteria as Markdown checklist items, one per line, e.g. "- [ ] <criterion>". Plain prose or a numbered list without checkboxes is rejected — candidate/done can only verify items that are checkable.',
		}),
	),
	manual: Type.Optional(Type.String({ description: "Optional for create: initial operating steps or checklist." })),
	verificationPlan: Type.Optional(
		Type.String({ description: "Optional for create: deterministic checks the verifier must perform." }),
	),
	control: Type.Optional(taskControlSchema),
	status: Type.Optional(
		Type.Union(
			SETTABLE_STATUSES.map((status) => Type.Literal(status)),
			{ description: "New status for create/progress/set. To close a task use action done, not status." },
		),
	),
	wake: Type.Optional(
		Type.String({
			description:
				"ISO8601 earliest-recheck time for create/progress/set; empty string clears it. The native task driver resumes it; no .checkin event is needed.",
		}),
	),
	recurrence: Type.Optional(Type.String({ description: "Annotation only (e.g. 每周一); empty string clears it." })),
	note: Type.Optional(
		Type.String({
			description:
				"Required for progress: concise Current Cycle entry covering what changed, evidence observed, and the next step.",
		}),
	),
	verifierRunId: Type.Optional(
		Type.String({ description: "Required for verify: run id returned by a purpose=verify sub-agent." }),
	),
	summary: Type.Optional(Type.String({ description: "Required for done: concise completion summary." })),
	evidence: Type.Optional(
		Type.String({
			description:
				"Required for done: verification evidence (tests, commands, review result, external confirmation, or a clear not-run reason).",
		}),
	),
	residualRisk: Type.Optional(Type.String({ description: "Optional for done: remaining risk or follow-up note." })),
	reason: Type.Optional(Type.String({ description: "Required for cancel: why the task was abandoned." })),
	cycleId: Type.Optional(
		Type.String({ description: "Required for start-cycle: stable id for the newly opened recurring cycle." }),
	),
});

export type TaskManageAction =
	| "create"
	| "progress"
	| "candidate"
	| "set"
	| "verify"
	| "done"
	| "cancel"
	| "start-cycle"
	| "list";

export interface TaskManageResult {
	action: TaskManageAction;
	id?: string;
	path?: string;
	status?: string;
	archived?: boolean;
	deletedEvents?: string[];
	tasks?: Array<{
		id: string;
		title: string;
		status: string;
		wake?: string;
		actionable: boolean;
		control?: TaskControl;
	}>;
	notice: string;
}

export interface TaskManageRequest {
	action: TaskManageAction;
	id?: string;
	title?: string;
	goal?: string;
	dod?: string;
	manual?: string;
	status?: string;
	wake?: string;
	recurrence?: string;
	note?: string;
	verificationPlan?: string;
	control?: TaskControlPatch;
	verifierRunId?: string;
	summary?: string;
	evidence?: string;
	residualRisk?: string;
	reason?: string;
	cycleId?: string;
}

export interface TaskManageToolOptions {
	workspaceDir: string;
	workspacePath: string;
	channelDir: string;
	channelId: string;
	/** Project checkout whose artifact state an independent verifier binds to. */
	workingDirectory?: string;
}

interface TaskFields {
	status: string;
	wake?: string;
	recurrence?: string;
	control?: TaskControl;
}

function parseAction(action: string): TaskManageAction {
	if (
		action === "create" ||
		action === "progress" ||
		action === "candidate" ||
		action === "set" ||
		action === "verify" ||
		action === "done" ||
		action === "cancel" ||
		action === "start-cycle" ||
		action === "list"
	) {
		return action;
	}
	throw new Error("Unsupported task action. Use create, progress, set, verify, done, cancel, start-cycle, or list.");
}

function toWorkspacePath(options: TaskManageToolOptions, hostPath: string): string {
	if (hostPath.startsWith(options.workspaceDir)) {
		return `${options.workspacePath}${hostPath.slice(options.workspaceDir.length)}`;
	}
	return hostPath;
}

function tasksDir(options: TaskManageToolOptions): string {
	return join(options.channelDir, "tasks");
}

function eventsDir(options: TaskManageToolOptions): string {
	return join(options.workspaceDir, "events");
}

function renderTaskFile(fields: TaskFields, body: string): string {
	return renderTaskDocument(fields, body);
}

function requiredField(value: string | undefined, field: string, action: string): string {
	const trimmed = value?.trim();
	if (!trimmed) {
		throw new Error(`action "${action}" requires ${field}.`);
	}
	return trimmed;
}

function requireNonEmpty(value: string | undefined, field: string): string {
	return requiredField(value, field, "done");
}

function markdownValue(value: string): string {
	const lines = value.trim().split(/\r?\n/);
	if (lines.length === 1) return lines[0];
	return lines.map((line, index) => (index === 0 ? line : `  ${line}`)).join("\n");
}

function appendCompletionEvidence(body: string, request: TaskManageRequest): string {
	const summary = requireNonEmpty(request.summary, "summary");
	const evidence = requireNonEmpty(request.evidence, "evidence");
	const lines = [
		"## Completion Evidence",
		"",
		`- Summary: ${markdownValue(summary)}`,
		`- Evidence: ${markdownValue(evidence)}`,
	];
	const residualRisk = request.residualRisk?.trim();
	if (residualRisk) {
		lines.push(`- Residual risk: ${markdownValue(residualRisk)}`);
	}
	const normalizedBody = body.endsWith("\n") ? body.replace(/\n+$/, "\n") : `${body}\n`;
	return `${normalizedBody}\n${lines.join("\n")}\n`;
}

function normalizeCreateStatus(status: string | undefined): (typeof SETTABLE_STATUSES)[number] {
	if (status === undefined) return "open";
	if ((SETTABLE_STATUSES as readonly string[]).includes(status)) {
		return status as (typeof SETTABLE_STATUSES)[number];
	}
	throw new Error(`Invalid status "${status}". Use one of ${SETTABLE_STATUSES.join(", ")}.`);
}

function renderTaskSkeleton(request: TaskManageRequest): { fields: TaskFields; body: string } {
	const title = requiredField(request.title, "title", "create");
	const goal = requiredField(request.goal, "goal", "create");
	const dod = requiredField(request.dod, "dod", "create");
	const mode = request.control?.verificationMode ?? "independent";
	const control = applyTaskControlPatch(createDefaultTaskControl(mode), request.control ?? {});
	const fields = applySet({ status: normalizeCreateStatus(request.status), control }, request);
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
async function readTaskDocument(
	taskPath: string,
	id: string,
	allowControlRepair = false,
): Promise<{ fields: TaskFields; body: string }> {
	if (!existsSync(taskPath)) {
		throw new Error(`Task "${id}" does not exist; create it with task_manage action "create" first.`);
	}
	const content = await readFile(taskPath, "utf-8");
	const frontmatter = parseTaskFrontmatter(content);
	if (!frontmatter.readable) {
		throw new Error(`Task "${id}" has no readable frontmatter; fix it with edit before using task_manage.`);
	}
	if (frontmatter.controlReadable === false && !allowControlRepair) {
		throw new Error(
			`Task "${id}" has invalid control metadata; repair it with task_manage action "set" and an explicit control patch first.`,
		);
	}
	return {
		fields: {
			status: frontmatter.status ?? "open",
			wake: frontmatter.wake,
			recurrence: frontmatter.recurrence,
			control: frontmatter.control,
		},
		body: taskBody(content),
	};
}

/** Apply a `set` request's optional fields onto the existing frontmatter. */
function applySet(fields: TaskFields, request: TaskManageRequest): TaskFields {
	const next: TaskFields = { ...fields };
	if (request.control?.externalApproval === "granted") {
		throw new Error('Only a user can grant external-action approval with "/tasks approve <id>".');
	}
	if (request.status !== undefined) {
		if (!(SETTABLE_STATUSES as readonly string[]).includes(request.status)) {
			throw new Error(
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
			throw new Error(`wake "${request.wake}" is not a valid ISO8601 date.`);
		} else {
			next.wake = trimmed;
		}
	}
	if (request.recurrence !== undefined) {
		const trimmed = request.recurrence.trim();
		next.recurrence = trimmed === "" ? undefined : trimmed;
	}
	if (request.control !== undefined) {
		next.control = applyTaskControlPatch(next.control ?? createDefaultTaskControl("evidence"), request.control);
	}
	return next;
}

async function validateTaskRelations(options: TaskManageToolOptions, id: string, fields: TaskFields): Promise<void> {
	const control = fields.control;
	if (!control) return;
	if (control.parent === id || control.dependsOn.includes(id)) {
		throw new Error(`Task "${id}" cannot be its own parent or dependency.`);
	}
	for (const relatedId of [control.parent, ...control.dependsOn].filter((value): value is string => Boolean(value))) {
		const active = join(tasksDir(options), `${relatedId}.md`);
		const archived = join(tasksDir(options), "archive", `${relatedId}.md`);
		if (!existsSync(active) && !existsSync(archived)) {
			throw new Error(`Related task "${relatedId}" does not exist; create it before linking task "${id}".`);
		}
	}

	if (control.parent) {
		const visited = new Set<string>();
		let current: string | undefined = control.parent;
		while (current) {
			if (visited.has(current)) {
				throw new Error(`Existing parent chain for "${control.parent}" already contains a cycle.`);
			}
			if (current === id) {
				throw new Error(`Task parent cycle detected while linking "${id}" to "${control.parent}".`);
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
				throw new Error(`Task dependency cycle detected while linking "${id}" to "${dependencyId}".`);
			}
			visited.add(current);
			const task = await readStoredTask(options.channelDir, current, true);
			stack.push(...(task?.fields.control?.dependsOn ?? []));
		}
	}
}

async function createTask(options: TaskManageToolOptions, request: TaskManageRequest): Promise<TaskManageResult> {
	if (!request.id) throw new Error('action "create" requires an id.');
	const id = normalizeTaskId(request.id);
	const dir = tasksDir(options);
	const taskPath = join(dir, `${id}.md`);
	const archivePath = join(dir, "archive", `${id}.md`);
	if (existsSync(taskPath)) {
		throw new Error(`Task "${id}" already exists; use action "set" or edit the body instead.`);
	}
	if (existsSync(archivePath)) {
		throw new Error(`Archived task "${id}" already exists; choose a new id or restore it manually first.`);
	}
	const { fields, body } = renderTaskSkeleton(request);
	const badDod = uncheckedTaskAcceptanceItems(body).find((item) => item.startsWith("DoD has no checklist items"));
	if (badDod) throw new Error(badDod);
	await validateTaskRelations(options, id, fields);
	await mkdir(dir, { recursive: true });
	await writeFileAtomically(taskPath, renderTaskFile(fields, body));
	return {
		action: "create",
		id,
		path: toWorkspacePath(options, taskPath),
		status: fields.status,
		notice: `已创建任务 \`${id}\`（status: ${fields.status}）。`,
	};
}

/**
 * On close-out, keep only the task's recurring cadence event
 * (`task.<channelId>.<id>.schedule`) and delete every other task-owned event.
 *
 * A task may also own temporary periodic events (for example an agentmux idle sensor).
 * Those are lifecycle check-ins, not proof that the task itself is recurring, so they
 * must not prevent a one-shot task from being archived.
 */
async function cleanupTaskEvents(
	options: TaskManageToolOptions,
	id: string,
	preserveSchedule = true,
): Promise<{ deleted: string[]; hasSchedule: boolean }> {
	const dir = eventsDir(options);
	if (!existsSync(dir)) return { deleted: [], hasSchedule: false };

	const prefix = taskEventPrefix(options.channelId, id);
	const scheduleFilename = taskScheduleEventFilename(options.channelId, id);
	const deleted: string[] = [];
	let hasSchedule = false;

	for (const filename of (await readdir(dir)).sort()) {
		if (!filename.endsWith(".json") || !filename.startsWith(prefix)) continue;
		const eventPath = join(dir, filename);
		let type: string | undefined;
		try {
			type = parseScheduledEventContent(await readFile(eventPath, "utf-8"), filename).type;
		} catch {
			continue; // can't classify → leave it for /events to handle
		}
		if (
			preserveSchedule &&
			filename === scheduleFilename &&
			isTaskScheduleEvent({ use: "schedule", event: { type } })
		) {
			hasSchedule = true; // the cadence lives on for the next cycle
			continue;
		}
		await unlink(eventPath);
		deleted.push(filename.slice(0, -".json".length));
	}
	return { deleted, hasSchedule };
}

async function setTask(options: TaskManageToolOptions, request: TaskManageRequest): Promise<TaskManageResult> {
	if (!request.id) throw new Error('action "set" requires an id.');
	const id = normalizeTaskId(request.id);
	const taskPath = join(tasksDir(options), `${id}.md`);
	const { fields, body } = await readTaskDocument(taskPath, id, request.control !== undefined);
	if (request.control !== undefined && fields.control === undefined) {
		fields.control = createDefaultTaskControl("independent");
	}
	const nextFields = applySet(fields, request);
	await validateTaskRelations(options, id, nextFields);
	await writeFileAtomically(taskPath, renderTaskFile(nextFields, body));
	return {
		action: "set",
		id,
		path: toWorkspacePath(options, taskPath),
		status: nextFields.status,
		notice: `已更新任务 \`${id}\`（status: ${nextFields.status}${nextFields.wake ? `, wake: ${nextFields.wake}` : ""}）。`,
	};
}

async function progressTask(options: TaskManageToolOptions, request: TaskManageRequest): Promise<TaskManageResult> {
	if (!request.id) throw new Error('action "progress" requires an id.');
	const id = normalizeTaskId(request.id);
	const note = requiredField(request.note, "note", "progress");
	const taskPath = join(tasksDir(options), `${id}.md`);
	const { fields, body } = await readTaskDocument(taskPath, id);
	const nextFields = applySet(fields, request);
	await validateTaskRelations(options, id, nextFields);
	if (nextFields.control) {
		nextFields.control = invalidateTaskVerification(nextFields.control);
		nextFields.control = invalidateTaskApproval(nextFields.control);
		if (request.status === "blocked" || request.status === "awaiting-user") {
			nextFields.control.lastOutcome = "blocked";
		} else if (request.control?.lastOutcome === undefined) {
			nextFields.control.lastOutcome = "progress";
			if (request.control?.blockedReason === undefined) nextFields.control.blockedReason = undefined;
		}
	}
	const nextBody = appendCurrentCycleNote(body, note);
	await writeFileAtomically(taskPath, renderTaskFile(nextFields, nextBody));
	return {
		action: "progress",
		id,
		path: toWorkspacePath(options, taskPath),
		status: nextFields.status,
		notice: `已记录任务 \`${id}\` 的进展（status: ${nextFields.status}${nextFields.wake ? `, wake: ${nextFields.wake}` : ""}）。`,
	};
}

/**
 * Move a task into the verification lane. The runtime driver will explicitly
 * wake a fresh verifier on the next attempt, keeping the maker from grading
 * its own work in the same reasoning context.
 */
async function candidateTask(options: TaskManageToolOptions, request: TaskManageRequest): Promise<TaskManageResult> {
	if (!request.id) throw new Error('action "candidate" requires an id.');
	const id = normalizeTaskId(request.id);
	const note = requiredField(request.note, "note", "candidate");
	const taskPath = join(tasksDir(options), `${id}.md`);
	const { fields, body } = await readTaskDocument(taskPath, id);
	if (["done", "cancelled", "escalated", "paused"].includes(fields.status)) {
		throw new Error(`Task "${id}" is ${fields.status} and cannot enter verification.`);
	}
	const uncheckedAcceptance = uncheckedTaskAcceptanceItems(body);
	if (uncheckedAcceptance.length > 0) {
		throw new Error(
			`Task "${id}" still has unchecked acceptance items: ${uncheckedAcceptance.join("; ")}. Check them with evidence before requesting verification.`,
		);
	}
	const control = fields.control ?? createDefaultTaskControl("independent");
	control.verification = { mode: "independent", status: "pending" };
	control.lastOutcome = "progress";
	control.blockedReason = undefined;
	control.nextAction = "Run a purpose=verify sub-agent and import its attestation.";
	const nextBody = appendCurrentCycleNote(body, note);
	await writeFileAtomically(
		taskPath,
		renderTaskFile({ ...fields, status: "verifying", wake: undefined, control }, nextBody),
	);
	return {
		action: "candidate",
		id,
		path: toWorkspacePath(options, taskPath),
		status: "verifying",
		notice: `任务 \`${id}\` 已进入独立验收队列；driver 将安排 verifier。`,
	};
}

async function verifyTask(options: TaskManageToolOptions, request: TaskManageRequest): Promise<TaskManageResult> {
	if (!request.id) throw new Error('action "verify" requires an id.');
	const id = normalizeTaskId(request.id);
	const runId = requiredField(request.verifierRunId, "verifierRunId", "verify");
	const task = await readStoredTask(options.channelDir, id);
	if (!task) throw new Error(`Task "${id}" does not exist; create it before verification.`);
	const attestation = await readVerificationAttestation(options.channelDir, runId);
	if (attestation.taskId !== id) {
		throw new Error(`Verification run "${runId}" belongs to task "${attestation.taskId}", not "${id}".`);
	}
	if (attestation.workspaceChanged) {
		throw new Error(`Verification run "${runId}" changed the workspace; rerun a read-only verifier.`);
	}
	if (attestation.bodyHash !== taskBodyHash(task.body)) {
		throw new Error(`Task "${id}" changed after verification run "${runId}"; rerun the verifier on current content.`);
	}
	if (attestation.subjectHash) {
		const currentSubject = await workspaceSubjectHash(options.workingDirectory ?? process.cwd());
		if (!currentSubject) {
			throw new Error(
				`Verification run "${runId}" is bound to a Git artifact subject, but the current checkout cannot be read. Rerun verification from the project checkout.`,
			);
		}
		if (currentSubject !== attestation.subjectHash) {
			throw new Error(`Task "${id}" artifacts changed after verification run "${runId}"; rerun the verifier.`);
		}
	}
	const control = task.fields.control ?? createDefaultTaskControl("independent");
	control.verification = {
		mode: "independent",
		status: attestation.verdict === "pass" ? "passed" : "failed",
		runId,
		evidence: attestation.evidence,
		bodyHash: attestation.bodyHash,
		subjectHash: attestation.subjectHash,
		checkedAt: attestation.checkedAt,
	};
	control.lastOutcome = attestation.verdict === "pass" ? "verified" : "failed";
	control.blockedReason = attestation.verdict === "fail" ? attestation.evidence : undefined;
	task.fields.control = control;
	await writeFileAtomically(task.path, renderTaskFile(task.fields, task.body));
	return {
		action: "verify",
		id,
		path: toWorkspacePath(options, task.path),
		status: task.fields.status,
		notice: `任务 \`${id}\` 独立验收结果：${attestation.verdict.toUpperCase()}（run: ${runId}）。`,
	};
}

async function unfinishedChildren(options: TaskManageToolOptions, parentId: string): Promise<string[]> {
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

async function doneTask(options: TaskManageToolOptions, request: TaskManageRequest): Promise<TaskManageResult> {
	if (!request.id) throw new Error('action "done" requires an id.');
	const id = normalizeTaskId(request.id);
	const dir = tasksDir(options);
	const taskPath = join(dir, `${id}.md`);
	const { fields, body } = await readTaskDocument(taskPath, id);
	const uncheckedAcceptance = uncheckedTaskAcceptanceItems(body);
	if (uncheckedAcceptance.length > 0) {
		throw new Error(
			`Task "${id}" still has unchecked acceptance items: ${uncheckedAcceptance.join("; ")}. Check them with evidence before done.`,
		);
	}
	const dependencies = await dependencyState(options.channelDir, fields.control?.dependsOn ?? [], id);
	if (!dependencies.ready) {
		throw new Error(`Task "${id}" cannot be completed: ${dependencies.reason}. Complete its dependencies first.`);
	}
	const children = await unfinishedChildren(options, id);
	if (children.length > 0) {
		throw new Error(
			`Task "${id}" still has unfinished child tasks: ${children.join(", ")}. Finish or cancel them first.`,
		);
	}
	if (fields.control?.sideEffects === "external") {
		if (fields.control.externalApproval !== "granted") {
			throw new Error(`Task "${id}" requires explicit external-action approval before it can be completed.`);
		}
		if (fields.control.approvalBodyHash !== taskBodyHash(body)) {
			throw new Error(
				`Task "${id}" changed after external-action approval; ask the user to run /tasks approve ${id} again.`,
			);
		}
	}
	if (fields.control?.verification.mode === "independent") {
		const verification = fields.control.verification;
		if (verification.status !== "passed" || !verification.bodyHash) {
			throw new Error(
				`Task "${id}" requires an independent PASS. Run a purpose=verify sub-agent, then task_manage verify with its run id.`,
			);
		}
		if (verification.bodyHash !== taskBodyHash(body)) {
			throw new Error(`Task "${id}" changed after its independent PASS; rerun verification before done.`);
		}
		if (verification.subjectHash) {
			const currentSubject = await workspaceSubjectHash(options.workingDirectory ?? process.cwd());
			if (currentSubject !== verification.subjectHash) {
				throw new Error(
					`Task "${id}" artifacts changed after its independent PASS; rerun verification before done.`,
				);
			}
		}
	}
	const bodyWithEvidence = appendCompletionEvidence(body, request);
	if (fields.control) {
		fields.control.lastOutcome = "verified";
		fields.control.blockedReason = undefined;
	}

	await writeFileAtomically(taskPath, renderTaskFile({ ...fields, status: "done" }, bodyWithEvidence));
	const { deleted, hasSchedule } = await cleanupTaskEvents(options, id);

	// Periodic task → sleeps in place until its schedule fires next; one-shot → archive.
	let archived = false;
	let finalPath = taskPath;
	if (!hasSchedule) {
		const archiveDir = join(dir, "archive");
		await mkdir(archiveDir, { recursive: true });
		finalPath = join(archiveDir, `${id}.md`);
		await rename(taskPath, finalPath);
		archived = true;
	}

	const cleanup = deleted.length > 0 ? `，清理事件 ${deleted.join(", ")}` : "";
	const disposition = archived ? "已归档" : "周期任务留原地待下次唤醒";
	return {
		action: "done",
		id,
		path: toWorkspacePath(options, finalPath),
		status: "done",
		archived,
		deletedEvents: deleted,
		notice: `任务 \`${id}\` 已完成（${disposition}${cleanup}）。`,
	};
}

async function cancelTask(options: TaskManageToolOptions, request: TaskManageRequest): Promise<TaskManageResult> {
	if (!request.id) throw new Error('action "cancel" requires an id.');
	const id = normalizeTaskId(request.id);
	const reason = requiredField(request.reason, "reason", "cancel");
	const dir = tasksDir(options);
	const taskPath = join(dir, `${id}.md`);
	const { fields, body } = await readTaskDocument(taskPath, id);
	const children = await unfinishedChildren(options, id);
	if (children.length > 0) {
		throw new Error(
			`Task "${id}" still has unfinished child tasks: ${children.join(", ")}. Cancel or re-parent them first.`,
		);
	}
	if (fields.control) {
		fields.control.lastOutcome = "blocked";
		fields.control.blockedReason = `Cancelled: ${reason}`;
	}
	const cancelledBody = `${body.replace(/\n+$/, "\n")}\n## Cancellation\n\n- Reason: ${markdownValue(reason)}\n`;
	await writeFileAtomically(
		taskPath,
		renderTaskFile({ ...fields, status: "cancelled", wake: undefined }, cancelledBody),
	);
	const { deleted } = await cleanupTaskEvents(options, id, false);
	const archiveDir = join(dir, "archive");
	await mkdir(archiveDir, { recursive: true });
	const finalPath = join(archiveDir, `${id}.md`);
	await rename(taskPath, finalPath);
	return {
		action: "cancel",
		id,
		path: toWorkspacePath(options, finalPath),
		status: "cancelled",
		archived: true,
		deletedEvents: deleted,
		notice: `任务 \`${id}\` 已取消并归档${deleted.length ? `，清理事件 ${deleted.join(", ")}` : ""}。`,
	};
}

async function startCycleTask(options: TaskManageToolOptions, request: TaskManageRequest): Promise<TaskManageResult> {
	if (!request.id) throw new Error('action "start-cycle" requires an id.');
	const id = normalizeTaskId(request.id);
	const cycleId = requiredField(request.cycleId, "cycleId", "start-cycle");
	const taskPath = join(tasksDir(options), `${id}.md`);
	const { fields, body } = await readTaskDocument(taskPath, id);
	if (fields.status !== "done") {
		throw new Error(
			`Task "${id}" is ${fields.status}, not done. Finish, cancel, or explicitly resolve the current cycle before starting another.`,
		);
	}
	if (!fields.recurrence) {
		throw new Error(
			`Task "${id}" is not marked recurring. Add recurrence and its canonical .schedule event before starting a cycle.`,
		);
	}
	const control = fields.control ? resetTaskControlForCycle(fields.control, cycleId) : undefined;
	const nextBody = startTaskCycle(body, cycleId);
	await writeFileAtomically(
		taskPath,
		renderTaskFile({ ...fields, status: "in-progress", wake: undefined, control }, nextBody),
	);
	return {
		action: "start-cycle",
		id,
		path: toWorkspacePath(options, taskPath),
		status: "in-progress",
		notice: `已开启周期任务 \`${id}\` 的新周期 \`${cycleId}\`。`,
	};
}

async function listTasks(options: TaskManageToolOptions): Promise<TaskManageResult> {
	const entries = await readActiveTasks(tasksDir(options));
	return {
		action: "list",
		tasks: entries.map((entry) => ({
			id: entry.id,
			title: entry.title,
			status: entry.frontmatter.readable ? (entry.frontmatter.status ?? "open") : "unreadable",
			wake: entry.frontmatter.wake,
			actionable: entry.actionable,
			control: entry.frontmatter.control,
		})),
		notice: `台账共有 ${entries.length} 个 active 任务。`,
	};
}

export async function manageTask(
	options: TaskManageToolOptions,
	request: TaskManageRequest,
): Promise<TaskManageResult> {
	switch (request.action) {
		case "create":
			return createTask(options, request);
		case "progress":
			return progressTask(options, request);
		case "candidate":
			return candidateTask(options, request);
		case "set":
			return setTask(options, request);
		case "verify":
			return verifyTask(options, request);
		case "done":
			return doneTask(options, request);
		case "cancel":
			return cancelTask(options, request);
		case "start-cycle":
			return startCycleTask(options, request);
		case "list":
			return listTasks(options);
	}
}

export function createTaskManageTool(options: TaskManageToolOptions): AgentTool<typeof taskManageSchema> {
	return {
		name: "task_manage",
		label: "task_manage",
		description:
			"Manage governed persistent tasks: create, atomically checkpoint progress/control state, import an independent " +
			"verifier attestation, complete verified work, cancel abandoned work, or list tasks. Use progress for routine " +
			"end-of-turn checkpoints; use write/edit only for substantial Goal/DoD/Manual/Verification changes.",
		parameters: taskManageSchema,
		execute: async (
			_toolCallId: string,
			args: {
				label: string;
				action: string;
				id?: string;
				title?: string;
				goal?: string;
				dod?: string;
				manual?: string;
				verificationPlan?: string;
				control?: TaskControlPatch;
				status?: string;
				wake?: string;
				recurrence?: string;
				note?: string;
				verifierRunId?: string;
				summary?: string;
				evidence?: string;
				residualRisk?: string;
				reason?: string;
				cycleId?: string;
			},
		) => {
			const result = await manageTask(options, {
				action: parseAction(args.action),
				id: args.id,
				title: args.title,
				goal: args.goal,
				dod: args.dod,
				manual: args.manual,
				verificationPlan: args.verificationPlan,
				control: args.control,
				status: args.status,
				wake: args.wake,
				recurrence: args.recurrence,
				note: args.note,
				verifierRunId: args.verifierRunId,
				summary: args.summary,
				evidence: args.evidence,
				residualRisk: args.residualRisk,
				reason: args.reason,
				cycleId: args.cycleId,
			});
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				details: {
					kind: "task_manage",
					...result,
				},
			};
		},
	};
}
