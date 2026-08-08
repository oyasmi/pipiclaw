import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomically } from "../shared/atomic-file.js";
import { formatLocalTime, parseLocalTime } from "../shared/local-time.js";
import {
	createDefaultTaskControl,
	resetTaskControlForCycle,
	type TaskControl,
	type TaskOutcome,
	type TaskWaitingFor,
	type TaskWakeHandoff,
} from "./control.js";
import {
	normalizeTaskId,
	parseTaskFrontmatter,
	renderTaskDocument,
	startTaskCycle,
	type TaskDocumentFields,
	taskBody,
	taskContractSegment,
} from "./ledger.js";
import { withTaskMutation } from "./mutation-lock.js";
import { normalizeStoredStatus, resolveTaskTransition } from "./transitions.js";

export interface StoredTaskDocument {
	id: string;
	path: string;
	fields: TaskDocumentFields;
	body: string;
}

/**
 * Hash the task's *contract* segment (Goal/DoD/Manual/Verification), not the whole body, so
 * verification PASS survives routine Current Cycle / History logging and only breaks when the
 * contract itself changes (spec 029, D4). Old attestations that hashed the
 * whole body naturally fail this check after upgrade and are re-verified — verification should
 * always reflect current content, so there is no compatibility burden.
 */
export function taskBodyHash(body: string): string {
	return createHash("sha256").update(taskContractSegment(body)).digest("hex");
}

export async function readStoredTask(
	channelDir: string,
	idInput: string,
	includeArchive = false,
	allowInvalidControl = false,
): Promise<StoredTaskDocument | undefined> {
	const id = normalizeTaskId(idInput);
	const activePath = join(channelDir, "tasks", `${id}.md`);
	const archivePath = join(channelDir, "tasks", "archive", `${id}.md`);
	const path = existsSync(activePath)
		? activePath
		: includeArchive && existsSync(archivePath)
			? archivePath
			: undefined;
	if (!path) return undefined;
	const content = await readFile(path, "utf-8");
	const frontmatter = parseTaskFrontmatter(content);
	if (!frontmatter.readable) throw new Error(`Task "${id}" has unreadable frontmatter.`);
	if (frontmatter.controlReadable === false && !allowInvalidControl) {
		throw new Error(`Task "${id}" has unreadable control metadata.`);
	}
	return {
		id,
		path,
		fields: {
			status: frontmatter.status ?? "active",
			legacyStatus: frontmatter.rawStatus,
			enabled: frontmatter.enabled,
			wake: frontmatter.wake,
			schedule: frontmatter.schedule,
			recurrence: frontmatter.recurrence,
			control: frontmatter.control,
			outcome: frontmatter.archiveOutcome,
			closedAt: frontmatter.closedAt,
		},
		body: taskBody(content),
	};
}

export async function writeStoredTask(document: StoredTaskDocument): Promise<void> {
	await writeFileAtomically(document.path, renderTaskDocument(document.fields, document.body));
}

export async function updateStoredTask(
	channelDir: string,
	id: string,
	update: (document: StoredTaskDocument) => void,
	includeArchive = false,
): Promise<StoredTaskDocument | undefined> {
	return withTaskMutation(channelDir, id, async () => {
		const document = await readStoredTask(channelDir, id, includeArchive);
		if (!document) return undefined;
		update(document);
		await writeStoredTask(document);
		return document;
	});
}

export interface TaskAttemptClaim {
	control: TaskControl;
	previousLastOutcome: TaskOutcome;
	previousBlockedReason?: string;
	previousLastStartedAt?: string;
	generation: number;
}

export async function claimTaskAttempt(
	channelDir: string,
	id: string,
	now: Date,
): Promise<TaskAttemptClaim | undefined> {
	let claim: TaskAttemptClaim | undefined;
	const document = await updateStoredTask(channelDir, id, (task) => {
		const status = normalizeStoredStatus(task.fields.status, Boolean(task.fields.schedule));
		if (status !== "active" || task.fields.enabled === false) return;
		task.fields.control ??= createDefaultTaskControl();
		claim = {
			control: task.fields.control,
			previousLastOutcome: task.fields.control.lastOutcome,
			previousBlockedReason: task.fields.control.blockedReason,
			previousLastStartedAt: task.fields.control.lastStartedAt,
			generation: task.fields.control.attemptGeneration + 1,
		};
		task.fields.control.usage.attempts++;
		task.fields.control.attemptGeneration = claim.generation;
		task.fields.control.lastStartedAt = formatLocalTime(now);
		task.fields.control.lastOutcome = "running";
	});
	if (claim && document?.fields.control) claim.control = document.fields.control;
	return claim;
}

export async function releaseTaskAttemptClaim(channelDir: string, id: string, claim: TaskAttemptClaim): Promise<void> {
	await updateStoredTask(channelDir, id, (task) => {
		const control = task.fields.control;
		if (!control || control.attemptGeneration !== claim.generation) return;
		control.usage.attempts = Math.max(0, control.usage.attempts - 1);
		control.lastStartedAt = claim.previousLastStartedAt;
		control.lastOutcome = claim.previousLastOutcome;
		control.blockedReason = claim.previousBlockedReason;
	});
}

export async function finishTaskAttempt(
	channelDir: string,
	id: string,
	result: {
		tokens: number;
		costUsd: number;
		costKnown: boolean;
		wallTimeMinutes: number;
		failed: boolean;
		silent?: boolean;
		finishedAt: Date;
		/**
		 * The `attemptGeneration` this turn's claim recorded (spec 029's monotonic claim
		 * identity, see `TaskControl.attemptGeneration`). When present and stale — a newer
		 * claim has since superseded it — usage is still tallied (the spend genuinely
		 * happened), but the outcome/finish fields are left alone so a slow, superseded turn
		 * cannot overwrite the newer attempt's in-flight or already-finished state. Absent
		 * (e.g. legacy callers) means "apply unconditionally", matching prior behavior.
		 */
		generation?: number;
	},
): Promise<void> {
	await updateStoredTask(
		channelDir,
		id,
		(task) => {
			const control = task.fields.control;
			if (!control) return;
			control.usage.tokens += Math.max(0, Math.floor(result.tokens));
			control.usage.costUsd += Math.max(0, result.costUsd);
			control.usage.costKnown &&= result.costKnown;
			control.usage.wallTimeMinutes += Math.max(0, result.wallTimeMinutes);
			if (result.generation !== undefined && control.attemptGeneration !== result.generation) return;
			control.lastFinishedAt = formatLocalTime(result.finishedAt);
			if (result.silent) {
				// The driver claimed before dispatch to prevent concurrent work. A silent
				// turn performed no task advancement, so retain its cost audit but not its
				// attempt charge.
				control.usage.attempts = Math.max(0, control.usage.attempts - 1);
				if (control.lastOutcome === "running") {
					control.lastOutcome = "pending";
					control.blockedReason = undefined;
				}
			} else if (result.failed) {
				control.lastOutcome = "failed";
				control.blockedReason = "The previous agent run failed; inspect the runtime error before retrying.";
			} else if (control.lastOutcome === "running") {
				control.lastOutcome = "progress";
				control.blockedReason = undefined;
			}
		},
		true,
	);
}

/**
 * A governor stop: disable the task without changing its lifecycle stage or wake. The structured
 * stop record is the durable recovery receipt; notification is handled by the runtime driver.
 */
export async function escalateTask(channelDir: string, id: string, reason: string): Promise<boolean> {
	const document = await updateStoredTask(channelDir, id, (task) => {
		const status = normalizeStoredStatus(task.fields.status, Boolean(task.fields.schedule));
		resolveTaskTransition("governor-stop", id, status);
		task.fields.enabled = false;
		task.fields.control ??= createDefaultTaskControl();
		task.fields.control.stop = { by: "governor", reason, at: formatLocalTime() };
		task.fields.control.lastOutcome = "blocked";
		task.fields.control.blockedReason = reason;
	});
	return document !== undefined;
}

/** Atomically convert a due timed wait to active before any wake is dispatched. */
export async function activateWaitingTask(
	channelDir: string,
	id: string,
	expectedWaitingFor?: TaskWaitingFor,
): Promise<StoredTaskDocument | undefined> {
	let activated = false;
	const document = await updateStoredTask(channelDir, id, (task) => {
		const status = normalizeStoredStatus(task.fields.status, Boolean(task.fields.schedule));
		if (status !== "waiting" || task.fields.enabled === false) return;
		if (expectedWaitingFor && task.fields.control?.waitingFor !== expectedWaitingFor) return;
		activated = true;
		task.fields.control ??= createDefaultTaskControl();
		task.fields.status = "active";
		task.fields.wake = undefined;
		if (task.fields.control) {
			task.fields.control.waitingFor = undefined;
			task.fields.control.blockedReason = undefined;
		}
	});
	return activated ? document : undefined;
}

export interface WakeTaskTransitionHooks {
	/** Test-only fault seam: both hooks run before the single atomic task-file write. */
	beforeActivation?: () => void;
	beforeAttemptClaim?: () => void;
}

export interface WakeTaskHandoffInput {
	kind: "subagent";
	resourceId: string;
	dispatchId: string;
}

/** Activate a completion-woken task and claim its next attempt in one task-file mutation. Keeping
 * these state changes in one atomic write means a transient failure cannot leave the task active
 * but unclaimed, which would make a retry of the same durable wake look ineligible. */
export async function activateWaitingTaskAndClaimAttempt(
	channelDir: string,
	id: string,
	expectedWaitingFor: TaskWaitingFor,
	now: Date,
	hooks?: WakeTaskTransitionHooks,
	handoff?: WakeTaskHandoffInput,
): Promise<{ document: StoredTaskDocument; generation: number } | undefined> {
	let generation: number | undefined;
	const document = await updateStoredTask(channelDir, id, (task) => {
		const status = normalizeStoredStatus(task.fields.status, Boolean(task.fields.schedule));
		const existingHandoff = task.fields.control?.wakeHandoff;
		if (
			handoff &&
			status === "active" &&
			existingHandoff?.kind === handoff.kind &&
			existingHandoff.resourceId === handoff.resourceId &&
			existingHandoff.dispatchId === handoff.dispatchId &&
			task.fields.control?.attemptGeneration === existingHandoff.generation
		) {
			generation = existingHandoff.generation;
			return;
		}
		if (status !== "waiting" || task.fields.enabled === false) return;
		if (task.fields.control?.waitingFor !== expectedWaitingFor) return;
		hooks?.beforeActivation?.();
		task.fields.control ??= createDefaultTaskControl();
		task.fields.status = "active";
		task.fields.wake = undefined;
		task.fields.control.waitingFor = undefined;
		task.fields.control.blockedReason = undefined;

		hooks?.beforeAttemptClaim?.();
		generation = task.fields.control.attemptGeneration + 1;
		const previousLastOutcome = task.fields.control.lastOutcome;
		const previousBlockedReason = task.fields.control.blockedReason;
		const previousLastStartedAt = task.fields.control.lastStartedAt;
		task.fields.control.usage.attempts++;
		task.fields.control.attemptGeneration = generation;
		task.fields.control.lastStartedAt = formatLocalTime(now);
		task.fields.control.lastOutcome = "running";
		if (handoff) {
			task.fields.control.wakeHandoff = {
				...handoff,
				generation,
				previousLastOutcome,
				previousBlockedReason,
				previousLastStartedAt,
			};
		}
	});
	return document && generation !== undefined ? { document, generation } : undefined;
}

function isMatchingWakeHandoff(
	handoff: TaskWakeHandoff | undefined,
	expected: WakeTaskHandoffInput,
): handoff is TaskWakeHandoff {
	return (
		handoff?.kind === expected.kind &&
		handoff.resourceId === expected.resourceId &&
		handoff.dispatchId === expected.dispatchId
	);
}

/** Return a transport-rejected structured wake to its exact pre-activation task state. */
export async function rollbackWakeTaskActivation(
	channelDir: string,
	id: string,
	expected: WakeTaskHandoffInput,
): Promise<void> {
	await updateStoredTask(channelDir, id, (task) => {
		const control = task.fields.control;
		const handoff = control?.wakeHandoff;
		if (!control || !isMatchingWakeHandoff(handoff, expected) || control.attemptGeneration !== handoff.generation) {
			return;
		}
		task.fields.status = "waiting";
		task.fields.wake = undefined;
		control.waitingFor = "external-signal";
		control.usage.attempts = Math.max(0, control.usage.attempts - 1);
		control.attemptGeneration = Math.max(0, handoff.generation - 1);
		control.lastOutcome = handoff.previousLastOutcome;
		control.blockedReason = handoff.previousBlockedReason;
		control.lastStartedAt = handoff.previousLastStartedAt;
		control.wakeHandoff = undefined;
	});
}

/** Clear the durable handoff after the transport has accepted the activated turn. */
export async function finishWakeTaskActivation(
	channelDir: string,
	id: string,
	expected: WakeTaskHandoffInput,
): Promise<void> {
	await updateStoredTask(channelDir, id, (task) => {
		if (isMatchingWakeHandoff(task.fields.control?.wakeHandoff, expected) && task.fields.control) {
			task.fields.control.wakeHandoff = undefined;
		}
	});
}

/**
 * A stable cycle id for a runtime-opened recurring cycle: `cycle-YYYY-MM-DD`, disambiguated
 * with a `-N` suffix when the same task is reopened more than once on the same local day.
 */
export function nextCycleId(previousCycleId: string | undefined, occurrence: Date): string {
	const base = `cycle-${occurrence.getFullYear()}-${String(occurrence.getMonth() + 1).padStart(2, "0")}-${String(occurrence.getDate()).padStart(2, "0")}`;
	if (!previousCycleId || !previousCycleId.startsWith(base)) return base;
	const suffix = previousCycleId.slice(base.length + 1);
	const previousCount = suffix ? Number.parseInt(suffix, 10) : 1;
	const nextCount = Number.isFinite(previousCount) && previousCount >= 1 ? previousCount + 1 : 2;
	return `${base}-${nextCount}`;
}

/**
 * Open the next cycle of a sleeping recurring task entirely in the runtime (spec 029, D2):
 * fold the previous cycle's log into History, reset per-cycle control, clear the wake, and
 * mark it `active`. This is the deterministic replacement for the retired
 * no LLM turn is spent just to reopen a cycle.
 */
export async function openRecurringTaskCycle(
	channelDir: string,
	id: string,
	now: Date,
	force = false,
): Promise<{ document: StoredTaskDocument; cycleId: string } | undefined> {
	let cycleId: string | undefined;
	const document = await updateStoredTask(channelDir, id, (task) => {
		const status = normalizeStoredStatus(task.fields.status, Boolean(task.fields.schedule));
		if (status !== "sleeping" || !task.fields.schedule) return;
		const wakeMs = task.fields.wake ? parseLocalTime(task.fields.wake) : undefined;
		if (!force && (task.fields.enabled === false || wakeMs === undefined || wakeMs > now.getTime())) return;
		const occurrence = !force && wakeMs !== undefined ? new Date(wakeMs) : now;
		cycleId = nextCycleId(task.fields.control?.cycleId, occurrence);
		task.fields.control ??= createDefaultTaskControl();
		const firstCycle = !task.fields.control.cycleId;
		task.body = startTaskCycle(task.body, cycleId, !firstCycle);
		task.fields.status = "active";
		task.fields.enabled = true;
		task.fields.wake = undefined;
		task.fields.control = resetTaskControlForCycle(task.fields.control, cycleId);
	});
	if (!document || !cycleId) return undefined;
	return { document, cycleId };
}
