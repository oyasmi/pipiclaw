import { createHash } from "node:crypto";
import { join } from "node:path";
import * as log from "../log.js";
import { PLAYBOOKS_DIR } from "../paths.js";
import type { PipiclawTaskDriverSettings } from "../settings.js";
import { parseLocalTime } from "../shared/local-time.js";
import { errorMessage } from "../shared/text-utils.js";
import { taskBudgetViolation } from "../tasks/control.js";
import {
	normalizeTaskFields,
	readActiveTasks,
	recurringTaskMissedOccurrence,
	type TaskLedgerEntry,
} from "../tasks/ledger.js";
import {
	activateWaitingTask,
	claimTaskAttempt,
	escalateTask,
	openRecurringTaskCycle,
	releaseTaskAttemptClaim,
	updateStoredTask,
} from "../tasks/store.js";
import { nextTaskWake } from "../tasks/task-schedule.js";
import type { ChannelEvent } from "./channel-event.js";
import { discoverWorkspaceChannelIds } from "./channel-index.js";
import { isChannelId } from "./channel-paths.js";

export interface TaskDriverOptions {
	workspaceDir: string;
	getKnownChannelIds?: () => Iterable<string>;
	isChannelActive: (channelId: string) => boolean;
	dispatch: (event: ChannelEvent) => boolean | Promise<boolean>;
	/** Optional observability hook. It runs after every production dispatch attempt. */
	onDispatch?: (event: ChannelEvent, accepted: boolean) => void;
	getSettings: () => PipiclawTaskDriverSettings;
	/**
	 * Externally visible effects produced by this task's own turns so far (spec 031, D7).
	 * Defaults to a constant, which simply makes the fingerprint depend on ledger fields alone.
	 */
	getEffectCount?: (channelId: string, taskId: string) => number;
	/** Master autonomy switch (`tools.tasks.enabled`); re-read every tick. Defaults to on. */
	isEnabled?: () => boolean;
	/** Test-only override for the idle-sleep cap; production uses `settings.maxSleepMinutes`. */
	intervalMs?: number;
	/** Direct, non-LLM receipt for deterministic governor stops. */
	notify?: (event: ChannelEvent) => boolean | Promise<boolean>;
}

interface DispatchAttempt {
	fingerprint: string;
	atMs: number;
	accepted: boolean;
	/** The task's effect tally when this attempt was recorded; the baseline for the fast tier. */
	effects: number;
	/** Consecutive accepted wakes that ended with the ledger fingerprint unchanged (spec 029, D5). */
	futileCount: number;
}

/** Short debounce so a burst of nudges collapses into a single rescan. */
const NUDGE_DEBOUNCE_MS = 50;
/** Never schedule a scan closer than this, so near-now horizons cannot spin the loop. */
const MIN_SLEEP_MS = 250;
/** Consecutive no-progress wakes before the governor pauses a task (spec 029, D5). */
const FUTILE_WAKE_LIMIT = 3;

export async function discoverTaskChannels(
	workspaceDir: string,
	knownChannelIds: Iterable<string> = [],
): Promise<string[]> {
	const channels = new Set<string>();
	for (const channelId of knownChannelIds) {
		if (isChannelId(channelId)) channels.add(channelId);
	}
	for (const channelId of await discoverWorkspaceChannelIds(workspaceDir)) {
		channels.add(channelId);
	}
	return Array.from(channels).sort();
}

function attemptKey(channelId: string, taskId: string): string {
	return `${channelId}\0${taskId}`;
}

/**
 * What "this task moved" means to the driver.
 *
 * Do not use mtime/size here. Runtime usage accounting deliberately rewrites task control after
 * every attempt; treating that bookkeeping as progress made governed tasks retry at the short
 * continuation interval forever.
 *
 * `latestNote` is deliberately absent (spec 031, D7): it is the model's own account of its work,
 * so including it let a wake that did nothing but append a note reset the futile counter forever,
 * and let a wake that changed real files count as stalled. The task's own effect tally stands in
 * for the work itself instead — per task, not per channel, so a neighbour's activity (including
 * the user chatting) neither certifies progress here nor hides a task that is spinning.
 *
 * `entry.plan` is absent for the same reason (spec 037, D5): checking off a Plan step is a
 * model-reported claim, not evidence of an effect. If plan state fed the fingerprint, ticking a
 * checkbox would reset the futile counter and buy the short retry tier — a governor bypass this
 * driver must not offer. The Plan is a capsule/agenda display concern only.
 *
 * nextAction and blockedReason are also model-written explanations, not evidence of an effect.
 * Including either lets a progress/set call reset the futile counter without changing the task's
 * externally observable work.
 */
function taskFingerprint(entry: TaskLedgerEntry, effects: number): string {
	const control = entry.frontmatter.control;
	return [
		entry.frontmatter.readable ? "readable" : "unreadable",
		entry.frontmatter.status ?? "",
		entry.frontmatter.wake ?? "",
		entry.frontmatter.schedule ?? "",
		entry.frontmatter.recurrence ?? "",
		control?.verification.status ?? "",
		control?.waitingFor ?? "",
		entry.frontmatter.enabled === false ? "disabled" : "enabled",
		control?.stop?.reason ?? "",
		control?.cycleId ?? "",
		`effects:${effects}`,
	].join("\0");
}

/**
 * How long a task must wait after its last attempt, in three tiers.
 *
 * Backoff and cadence are different jobs, and one delay used to do both: any wake that changed
 * the ledger — including one that wrote code — waited out the same continuation delay as one that
 * only edited a note. A twenty-step task therefore spent well over an hour purely idle, which is
 * fatal for the "drive an external agent in small steps" shape this driver exists for.
 *
 * So the tiers are keyed on evidence, not on the boolean "something changed":
 * - this task's effect tally grew ⇒ its last wake actually did something ⇒ continue at once;
 * - the ledger changed with no effect (status/note churn) ⇒ the ordinary continuation delay;
 * - nothing changed ⇒ the long stalled-retry backoff, and the futile counter keeps running.
 *
 * Nothing here relaxes the stop-losses: the fast tier still costs one attempt against
 * `budget.maxAttempts`, so a task that spins productively-looking still hits the governor — just
 * sooner in wall time instead of an hour per step.
 */
function attemptDelayMs(
	attempt: DispatchAttempt,
	fingerprint: string,
	effects: number,
	settings: PipiclawTaskDriverSettings,
): number {
	// A dispatch the channel refused never ran; retry it on the short delay regardless of state.
	if (!attempt.accepted) return settings.continuationDelayMinutes * 60_000;
	if (attempt.fingerprint === fingerprint) return settings.stalledRetryMinutes * 60_000;
	if (effects > attempt.effects) return 0;
	return settings.continuationDelayMinutes * 60_000;
}

function isEligible(
	attempt: DispatchAttempt | undefined,
	fingerprint: string,
	effects: number,
	nowMs: number,
	settings: PipiclawTaskDriverSettings,
): boolean {
	if (!attempt) return true;
	return nowMs - attempt.atMs >= attemptDelayMs(attempt, fingerprint, effects, settings);
}

/**
 * Stable, provenance-derived dispatch id for a task wake (spec 031, D1).
 *
 * A scheduled task has a real occurrence — its `wake` — so retries of that occurrence collapse
 * onto one durable record. A task that is simply actionable has no occurrence identity, so the
 * dispatch time is used: two separate wakes of the same task are genuinely separate work, and
 * collapsing them would silently drop the later one.
 */
function taskDispatchId(channelId: string, entry: TaskLedgerEntry, nowMs: number): string {
	const occurrence = entry.frontmatter.control?.cycleId ?? entry.frontmatter.wake ?? `t${nowMs}`;
	return `task:${channelId}:${entry.id}:${occurrence}`;
}

export function createTaskDriverEvent(
	channelId: string,
	entry: TaskLedgerEntry,
	nowMs: number,
	attemptGeneration?: number,
): ChannelEvent {
	const repairOnly = !entry.frontmatter.readable || entry.frontmatter.controlReadable === false;
	const repair = repairOnly
		? ` Task metadata is not readable; repair only the frontmatter/control in tasks/${entry.id}.md, then stop. ` +
			`Do not execute the task goal or any external action. Read ${join(PLAYBOOKS_DIR, "task-driving.md")} for the repair path.`
		: "";
	const control = entry.frontmatter.control;
	const capsule = [
		`Task capsule: title=${entry.title}; status=${entry.frontmatter.status ?? "active"};`,
		// Surfacing the Plan's progress and current step here is the point of spec 037, D2/D4: the
		// model no longer has to re-derive "what step am I on" from latestNote/nextAction each wake.
		entry.plan
			? `plan=${entry.plan.done}/${entry.plan.total} done, current=${entry.plan.current?.id ?? "none"};`
			: "",
		entry.latestNote ? `latest=${entry.latestNote};` : "",
		control?.nextAction ? `next=${control.nextAction};` : "",
		control ? `budget=${control.usage.attempts}/${control.budget.maxAttempts} attempts;` : "",
	]
		.filter(Boolean)
		.join(" ");
	return {
		type: channelId.startsWith("group_") ? "group" : "dm",
		channelId,
		user: "TASK_DRIVER",
		userName: "TASK_DRIVER",
		text:
			`[TASK_DRIVER:${entry.id}] Resume task ${entry.id}. ${capsule}${repair} ` +
			`Open tasks/${entry.id}.md and read ${join(PLAYBOOKS_DIR, "task-driving.md")} before acting. ` +
			(repairOnly
				? "After the metadata is repaired, leave task work for a later wake. "
				: "Advance the next concrete step under the task's current goal, control, acceptance, and verification state. ") +
			`If complete or waiting, use the matching task_manage lifecycle/checkpoint action from the playbook. ` +
			"For a recurring occurrence intentionally not run because it is duplicate or already satisfied, call task_manage skip with the reason, then respond with exactly [SILENT]. " +
			"If no task state or tool action is needed and this wake produces no user-visible result, respond with exactly [SILENT].",
		ts: String(nowMs),
		conversationType: channelId.startsWith("group_") ? "2" : "1",
		dispatchId: taskDispatchId(channelId, entry, nowMs),
		taskAttemptGeneration: attemptGeneration,
	};
}

/** Durable checker wake created by request-verification; it is a normal main-agent turn. */
export function createTaskVerificationEvent(channelId: string, entry: TaskLedgerEntry, nowMs: number): ChannelEvent {
	const control = entry.frontmatter.control;
	return {
		type: channelId.startsWith("group_") ? "group" : "dm",
		channelId,
		user: "TASK_VERIFIER",
		userName: "TASK_VERIFIER",
		text:
			`[TASK_VERIFY:${entry.id}] Verify task ${entry.id} independently. ` +
			`Read tasks/${entry.id}.md and the workspace verification instructions, then run a read-only ` +
			`subagent with purpose=verify. Import its attestation with task_manage verify using the returned run id. ` +
			`Do not modify the workspace or task contract; if verification fails, record the failure and leave the task recoverable.`,
		ts: String(nowMs),
		conversationType: channelId.startsWith("group_") ? "2" : "1",
		dispatchId: `task:${channelId}:${entry.id}:verification:${control?.cycleId ?? `t${nowMs}`}`,
	};
}

/** sleeping + a schedule cadence + a valid wake that is due → time to open the next cycle. */
function isCycleStartReady(entry: TaskLedgerEntry, nowMs: number): boolean {
	return (
		entry.frontmatter.status === "sleeping" &&
		entry.frontmatter.enabled !== false &&
		Boolean(entry.frontmatter.schedule) &&
		entry.wakeMs !== undefined &&
		entry.wakeMs <= nowMs
	);
}

/** sleeping + schedule but no parseable wake → self-heal target (recompute wake, zero token). */
function needsWakeHeal(entry: TaskLedgerEntry): boolean {
	return entry.frontmatter.status === "sleeping" && Boolean(entry.frontmatter.schedule) && entry.wakeMs === undefined;
}

export function taskGovernorReceipt(
	channelId: string,
	entry: TaskLedgerEntry,
	reason: string,
	nowMs: number,
): ChannelEvent {
	return {
		type: channelId.startsWith("group_") ? "group" : "dm",
		channelId,
		user: "TASK_DRIVER",
		userName: "TASK_DRIVER",
		text:
			`任务 ${entry.id}（${entry.title}）已停止自动执行：${reason}\n` +
			`当前阶段：${entry.frontmatter.status ?? "active"}${entry.frontmatter.control?.cycleId ? `；周期：${entry.frontmatter.control.cycleId}` : ""}\n` +
			`继续：/tasks resume ${entry.id}\n立即执行：/tasks run ${entry.id}\n不再需要：让 Agent cancel 该任务。`,
		ts: String(nowMs),
		conversationType: channelId.startsWith("group_") ? "2" : "1",
		// Keyed on the cause, not the moment: re-detecting the same violation before the user has
		// acted must not queue a second identical escalation, while a different cause still does.
		dispatchId: `task:${channelId}:${entry.id}:escalation:${createHash("sha256").update(reason).digest("hex").slice(0, 12)}`,
	};
}

/**
 * Native, token-gated driver for the persistent task ledger.
 *
 * The scan itself is deterministic and cheap. It wakes at most one actionable task
 * per channel, skips active channels, backs off unchanged ledgers, and round-robins
 * dispatches so a busy channel cannot starve the rest. `wake` is therefore sufficient
 * to resume a task; users do not need to install a heartbeat event or sensor script.
 */
export class TaskDriver {
	private timer: ReturnType<typeof setTimeout> | null = null;
	private nudgeTimer: ReturnType<typeof setTimeout> | null = null;
	private loopActive = false;
	private running = false;
	private nextChannelIndex = 0;
	/** Absolute ms of the next moment worth waking for (min wake/deadline/backoff), recomputed each scan. */
	private nextWakeMs: number | undefined;
	private readonly attempts = new Map<string, DispatchAttempt>();
	/**
	 * Last task id dispatched per channel. Cross-channel fairness is handled by
	 * `nextChannelIndex`, but within one channel every tick used to pick the first ready
	 * candidate in sort order — an actively-progressing task keeps winning that slot forever,
	 * starving every other ready task (including its own unlocked dependents) in the same
	 * channel. Remembering the last pick and starting the search just after it gives ready
	 * candidates in a channel the same round-robin fairness across ticks.
	 */
	private readonly lastDispatchedTaskId = new Map<string, string>();

	constructor(private readonly options: TaskDriverOptions) {}

	private observeDispatch(event: ChannelEvent, accepted: boolean): void {
		try {
			this.options.onDispatch?.(event, accepted);
		} catch (error) {
			log.logWarning("Task driver dispatch observer failed", errorMessage(error));
		}
	}

	start(): void {
		if (this.loopActive) return;
		this.loopActive = true;
		log.logInfo(
			"Task driver started",
			`schedule timezone=${Intl.DateTimeFormat().resolvedOptions().timeZone} (host)`,
		);
		void this.tick();
	}

	stop(): void {
		this.loopActive = false;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (this.nudgeTimer) {
			clearTimeout(this.nudgeTimer);
			this.nudgeTimer = null;
		}
	}

	/**
	 * In-process wake: after a turn ends or a task file is written, re-scan promptly instead
	 * of waiting out the current sleep. The timer is a hint; the scan re-reads every file, so
	 * a stale or missed nudge only costs one capped sleep of latency, never correctness.
	 */
	nudge(): void {
		if (!this.loopActive || this.nudgeTimer) return;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		this.nudgeTimer = setTimeout(() => {
			this.nudgeTimer = null;
			void this.tick();
		}, NUDGE_DEBOUNCE_MS);
		this.nudgeTimer.unref?.();
	}

	private async tick(): Promise<void> {
		try {
			await this.runOnce();
		} catch (error) {
			log.logWarning("Task driver tick failed", errorMessage(error));
		}
		this.scheduleNext();
	}

	private scheduleNext(): void {
		if (!this.loopActive || this.timer || this.nudgeTimer) return;
		const settings = this.options.getSettings();
		const capMs = this.options.intervalMs ?? settings.maxSleepMinutes * 60_000;
		const untilNext = this.nextWakeMs !== undefined ? this.nextWakeMs - Date.now() : Number.POSITIVE_INFINITY;
		const sleepMs = Math.max(MIN_SLEEP_MS, Math.min(capMs, untilNext));
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.tick();
		}, sleepMs);
		this.timer.unref?.();
	}

	/** Fold `candidate` into the earliest interesting wake moment. */
	private noteHorizon(candidate: number | undefined, nowMs: number): void {
		if (candidate === undefined || !Number.isFinite(candidate) || candidate <= nowMs) return;
		if (this.nextWakeMs === undefined || candidate < this.nextWakeMs) this.nextWakeMs = candidate;
	}

	private collectHorizons(entries: TaskLedgerEntry[], nowMs: number): void {
		for (const entry of entries) {
			if (entry.frontmatter.enabled !== false) this.noteHorizon(entry.wakeMs, nowMs);
			const control = entry.frontmatter.control;
			if (
				entry.frontmatter.enabled !== false &&
				control?.deadline &&
				(entry.frontmatter.status === "active" || entry.frontmatter.status === "waiting") &&
				!entry.frontmatter.archiveOutcome
			) {
				this.noteHorizon(parseLocalTime(control.deadline), nowMs);
			}
		}
	}

	async runOnce(now = new Date()): Promise<void> {
		if (this.options.isEnabled?.() === false || this.running) return;
		const settings = this.options.getSettings();
		const nowMs = now.getTime();

		this.running = true;
		this.nextWakeMs = undefined;
		try {
			const channels = await discoverTaskChannels(this.options.workspaceDir, this.options.getKnownChannelIds?.());
			if (channels.length === 0) {
				this.attempts.clear();
				return;
			}

			const seen = new Set<string>();
			const start = this.nextChannelIndex % channels.length;
			let dispatched = 0;
			let lastDispatchOffset = -1;
			for (let offset = 0; offset < channels.length; offset++) {
				const channelId = channels[(start + offset) % channels.length];
				if (!channelId) continue;
				const channelDir = join(this.options.workspaceDir, channelId);
				let entries = await readActiveTasks(join(channelDir, "tasks"), nowMs);
				for (const entry of entries) seen.add(attemptKey(channelId, entry.id));
				this.collectHorizons(entries, nowMs);
				for (const entry of entries) {
					if (
						entry.frontmatter.enabled !== false &&
						recurringTaskMissedOccurrence(
							{
								status: entry.frontmatter.status ?? "active",
								schedule: entry.frontmatter.schedule,
								control: entry.frontmatter.control,
							},
							now,
						)
					) {
						log.logWarning(
							`[${channelId}] Task ${entry.id} has a missed recurring occurrence; keeping the current cycle open`,
						);
					}
				}

				// Zero-token self-heal: a sleeping recurring task with a missing/unparseable wake (usually a
				// hand edit that bypassed the runtime) gets its next occurrence recomputed via the same
				// `normalizeTaskFields` write-path invariant, rather than fail-open into an accidental cycle.
				for (const entry of entries) {
					if (entry.frontmatter.status !== "sleeping" || entry.frontmatter.enabled === false) continue;
					if (!entry.frontmatter.schedule) {
						const reason = "sleeping recurring task has no schedule";
						if (await escalateTask(channelDir, entry.id, reason)) {
							const receipt = taskGovernorReceipt(channelId, entry, reason, nowMs);
							try {
								await this.options.notify?.(receipt);
							} catch (error) {
								log.logWarning(`[${channelId}] Task governor receipt failed`, errorMessage(error));
							}
						}
						continue;
					}
					const scheduleWake = nextTaskWake(entry.frontmatter.schedule, now);
					if (!scheduleWake) {
						const reason = `sleeping task has invalid schedule: ${entry.frontmatter.schedule}`;
						if (await escalateTask(channelDir, entry.id, reason)) {
							const receipt = taskGovernorReceipt(channelId, entry, reason, nowMs);
							try {
								await this.options.notify?.(receipt);
							} catch (error) {
								log.logWarning(`[${channelId}] Task governor receipt failed`, errorMessage(error));
							}
						}
						continue;
					}
					if (!needsWakeHeal(entry)) continue;
					let healedWake: string | undefined;
					await updateStoredTask(channelDir, entry.id, (task) => {
						healedWake = normalizeTaskFields(task.fields, now).wake;
						task.fields.wake = healedWake;
					});
					if (!healedWake) {
						log.logWarning(
							`[${channelId}] Task ${entry.id} has an unparseable schedule`,
							entry.frontmatter.schedule,
						);
						continue;
					}
					this.noteHorizon(new Date(healedWake).getTime(), nowMs);
					log.logInfo(`[${channelId}] Task driver healed wake for ${entry.id}`, healedWake);
				}

				let governanceHandled = false;
				for (const candidate of entries) {
					const status = candidate.frontmatter.status;
					const control = candidate.frontmatter.control;
					if (!control || candidate.frontmatter.archiveOutcome || candidate.frontmatter.enabled === false)
						continue;
					const escalationReason = taskBudgetViolation(
						control,
						nowMs,
						status as "active" | "waiting" | "sleeping",
					);
					if (!escalationReason) continue;
					governanceHandled = true;
					if (await escalateTask(channelDir, candidate.id, escalationReason)) {
						const receipt = taskGovernorReceipt(channelId, candidate, escalationReason, nowMs);
						try {
							await this.options.notify?.(receipt);
						} catch (error) {
							log.logWarning(`[${channelId}] Task governor receipt failed`, errorMessage(error));
						}
						log.logWarning(`[${channelId}] Task driver disabled ${candidate.id} (governor)`, escalationReason);
					}
					break;
				}
				if (governanceHandled) continue;
				// Deterministic maintenance above must not wait for an idle channel. Only model dispatch
				// and the transitions immediately preceding it are gated by the channel's busy state.
				if (dispatched >= settings.maxDispatchesPerTick || this.options.isChannelActive(channelId)) continue;

				// Timed waits become active atomically before dispatch. Sleeping due tasks use the same
				// runtime cycle-open path as the first occurrence.
				let hadDueWaiting = false;
				for (const candidate of entries) {
					if (candidate.frontmatter.status !== "waiting" || candidate.frontmatter.enabled === false) continue;
					if (candidate.wakeMs !== undefined && candidate.wakeMs <= nowMs) {
						hadDueWaiting = true;
						await activateWaitingTask(channelDir, candidate.id);
					}
				}
				// A failed activation means another writer won the transition (or disabled the
				// task). Re-read before choosing a candidate so a stale waiting capsule can never
				// be dispatched as if its atomic active transition had succeeded.
				if (hadDueWaiting) entries = await readActiveTasks(join(channelDir, "tasks"), nowMs);

				// Actionable tasks and cycle-start-ready recurring tasks share one per-channel slot
				// and the same round-robin fairness. A cycle-start-ready task is folded into its next
				// cycle deterministically by the runtime (D2) and then dispatched as an ordinary wake.
				const candidates = entries.filter(
					(candidate) => candidate.actionable || isCycleStartReady(candidate, nowMs),
				);
				if (candidates.length === 0) continue;
				const lastId = this.lastDispatchedTaskId.get(channelId);
				const lastIndex = lastId ? candidates.findIndex((candidate) => candidate.id === lastId) : -1;
				const rotatedCandidates =
					lastIndex >= 0
						? [...candidates.slice(lastIndex + 1), ...candidates.slice(0, lastIndex + 1)]
						: candidates;
				let entry: TaskLedgerEntry | undefined = rotatedCandidates[0];
				if (!entry || dispatched >= settings.maxDispatchesPerTick) continue;

				// A cycle-start-ready recurring task is reopened in-process before dispatch: fold the
				// previous cycle, reset per-cycle control, mark it active. If the write fails we skip
				// this tick rather than dispatch a stale sleeping capsule.
				if (isCycleStartReady(entry, nowMs)) {
					let opened: Awaited<ReturnType<typeof openRecurringTaskCycle>>;
					try {
						opened = await openRecurringTaskCycle(channelDir, entry.id, now);
					} catch (error) {
						// A malformed recurring body (e.g. missing History) must not stall the whole tick.
						log.logWarning(
							`[${channelId}] Task driver could not open next cycle for ${entry.id}`,
							errorMessage(error),
						);
						continue;
					}
					if (!opened) {
						log.logWarning(`[${channelId}] Task driver could not open next cycle for ${entry.id}`);
						continue;
					}
					// Re-read after the atomic open so the capsule contains the new Current Cycle/Plan,
					// rather than the sleeping occurrence's just-closed note.
					const refreshed = (await readActiveTasks(join(channelDir, "tasks"), nowMs)).find(
						(candidate) => candidate.id === entry?.id,
					);
					entry = refreshed ?? {
						...entry,
						frontmatter: {
							...entry.frontmatter,
							status: "active",
							wake: undefined,
							control: opened.document.fields.control,
						},
						wakeMs: undefined,
						actionable: true,
					};
					log.logInfo(`[${channelId}] Task driver opened cycle ${opened.cycleId} for ${entry.id}`);
				}

				const key = attemptKey(channelId, entry.id);
				const repairOnly = !entry.frontmatter.readable || entry.frontmatter.controlReadable === false;
				const effects = this.options.getEffectCount?.(channelId, entry.id) ?? 0;
				const fingerprint = taskFingerprint(entry, effects);
				const previous = this.attempts.get(key);
				if (!isEligible(previous, fingerprint, effects, nowMs, settings)) continue;

				// D5: a wake that was accepted and left the ledger fingerprint unchanged made no
				// visible progress. Count consecutive such wakes (a changed fingerprint — including
				// a progress note or a failure — resets the count); after the limit the governor
				// pauses the task and notifies the user, so no silent loop burns tokens forever.
				const futileCount =
					!repairOnly && previous?.accepted && previous.fingerprint === fingerprint ? previous.futileCount + 1 : 0;
				if (futileCount >= FUTILE_WAKE_LIMIT) {
					const reason = `task made no visible progress in ${FUTILE_WAKE_LIMIT} consecutive wakes`;
					if (await escalateTask(channelDir, entry.id, reason)) {
						const receipt = taskGovernorReceipt(channelId, entry, reason, nowMs);
						try {
							await this.options.notify?.(receipt);
						} catch (error) {
							log.logWarning(`[${channelId}] Task governor receipt failed`, errorMessage(error));
						}
						this.attempts.delete(key);
						this.lastDispatchedTaskId.set(channelId, entry.id);
						log.logWarning(`[${channelId}] Task driver disabled ${entry.id} (governor)`, reason);
					}
					continue;
				}

				// Claiming an attempt only touches usage bookkeeping, which the fingerprint
				// deliberately excludes, so there is nothing to recompute here.
				const claim = repairOnly ? undefined : await claimTaskAttempt(channelDir, entry.id, now);
				if (claim) entry.frontmatter.control = claim.control;
				const event = createTaskDriverEvent(channelId, entry, nowMs, claim?.generation);
				const accepted = await this.options.dispatch(event);
				this.observeDispatch(event, accepted);
				if (!accepted && claim) await releaseTaskAttemptClaim(channelDir, entry.id, claim);
				this.attempts.set(key, { fingerprint, atMs: nowMs, accepted, effects, futileCount });
				this.lastDispatchedTaskId.set(channelId, entry.id);
				if (accepted) {
					dispatched++;
					lastDispatchOffset = offset;
					log.logInfo(`[${channelId}] Task driver enqueued ${entry.id}`);
				} else {
					log.logWarning(`[${channelId}] Task driver could not enqueue ${entry.id}`, "channel queue unavailable");
				}
			}

			for (const key of this.attempts.keys()) {
				if (!seen.has(key)) this.attempts.delete(key);
			}
			// A backed-off task becomes eligible again at attempt time + its retry delay; wake then
			// so an unchanged ledger is still retried without polling. Changed ledgers arrive via
			// nudge. Both tiers are noted because which one applies depends on the ledger as it will
			// be *then*: `noteHorizon` keeps whichever is next in the future, so the short tier is
			// honored on time and the long one is still not missed.
			for (const attempt of this.attempts.values()) {
				this.noteHorizon(attempt.atMs + settings.continuationDelayMinutes * 60_000, nowMs);
				if (attempt.accepted) this.noteHorizon(attempt.atMs + settings.stalledRetryMinutes * 60_000, nowMs);
			}
			const channelSet = new Set(channels);
			for (const channelId of this.lastDispatchedTaskId.keys()) {
				if (!channelSet.has(channelId)) this.lastDispatchedTaskId.delete(channelId);
			}
			this.nextChannelIndex = (start + (lastDispatchOffset >= 0 ? lastDispatchOffset + 1 : 1)) % channels.length;
		} finally {
			this.running = false;
		}
	}
}
