import { readdir } from "node:fs/promises";
import { join } from "node:path";
import * as log from "../log.js";
import { PLAYBOOKS_DIR } from "../paths.js";
import type { PipiclawTaskDriverSettings } from "../settings.js";
import { normalizeTaskFields, readActiveTasks, type TaskLedgerEntry } from "../shared/task-ledger.js";
import { errorMessage } from "../shared/text-utils.js";
import { taskBudgetViolation } from "../tasks/control.js";
import {
	claimTaskAttempt,
	dependencyState,
	escalateTask,
	openRecurringTaskCycle,
	releaseTaskAttemptClaim,
	updateStoredTask,
} from "../tasks/store.js";
import { TERMINAL_TASK_STATUSES } from "../tasks/transitions.js";
import type { DingTalkEvent } from "./dingtalk.js";

export interface TaskDriverOptions {
	workspaceDir: string;
	getKnownChannelIds?: () => Iterable<string>;
	isChannelActive: (channelId: string) => boolean;
	dispatch: (event: DingTalkEvent) => boolean | Promise<boolean>;
	/** Optional observability hook. It runs after every production dispatch attempt. */
	onDispatch?: (event: DingTalkEvent, accepted: boolean) => void;
	getSettings: () => PipiclawTaskDriverSettings;
	/** Master autonomy switch (`tools.tasks.enabled`); re-read every tick. Defaults to on. */
	isEnabled?: () => boolean;
	/** Test-only override for the idle-sleep cap; production uses `settings.maxSleepMinutes`. */
	intervalMs?: number;
}

interface DispatchAttempt {
	fingerprint: string;
	atMs: number;
	accepted: boolean;
}

/** Short debounce so a burst of nudges collapses into a single rescan. */
const NUDGE_DEBOUNCE_MS = 50;
/** Never schedule a scan closer than this, so near-now horizons cannot spin the loop. */
const MIN_SLEEP_MS = 250;
const CHANNEL_ID_PATTERN = /^(dm|group)_[A-Za-z0-9._:-]+$/;
const TERMINAL_STATUSES = TERMINAL_TASK_STATUSES;

function isChannelId(value: string): boolean {
	return CHANNEL_ID_PATTERN.test(value);
}

export async function discoverTaskChannels(
	workspaceDir: string,
	knownChannelIds: Iterable<string> = [],
): Promise<string[]> {
	const channels = new Set<string>();
	for (const channelId of knownChannelIds) {
		if (isChannelId(channelId)) channels.add(channelId);
	}
	try {
		const entries = await readdir(workspaceDir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isDirectory() && isChannelId(entry.name)) channels.add(entry.name);
		}
	} catch {
		// A missing/unreadable workspace simply has no tasks to drive this tick.
	}
	return Array.from(channels).sort();
}

function attemptKey(channelId: string, taskId: string): string {
	return `${channelId}\0${taskId}`;
}

async function taskFingerprint(_channelDir: string, entry: TaskLedgerEntry): Promise<string> {
	// Do not use mtime/size here. Runtime usage accounting deliberately rewrites
	// task control after every attempt; treating that bookkeeping as progress made
	// governed tasks retry at the short continuation interval forever.
	const control = entry.frontmatter.control;
	return [
		entry.frontmatter.readable ? "readable" : "unreadable",
		entry.frontmatter.status ?? "",
		entry.frontmatter.wake ?? "",
		entry.frontmatter.schedule ?? "",
		entry.frontmatter.recurrence ?? "",
		entry.latestNote ?? "",
		control?.nextAction ?? "",
		control?.blockedReason ?? "",
		control?.verification.status ?? "",
		control?.cycleId ?? "",
	].join("\0");
}

function isEligible(
	attempt: DispatchAttempt | undefined,
	fingerprint: string,
	nowMs: number,
	settings: PipiclawTaskDriverSettings,
): boolean {
	if (!attempt) return true;
	const changed = attempt.fingerprint !== fingerprint;
	const delayMinutes = changed || !attempt.accepted ? settings.continuationDelayMinutes : settings.stalledRetryMinutes;
	return nowMs - attempt.atMs >= delayMinutes * 60_000;
}

export function createTaskDriverEvent(channelId: string, entry: TaskLedgerEntry, nowMs: number): DingTalkEvent {
	const verification = entry.frontmatter.control?.verification;
	const verificationInstruction =
		entry.frontmatter.status === "verifying"
			? verification?.status === "passed"
				? ` Independent verification already passed; preserve its body/artifact hashes and follow ${join(PLAYBOOKS_DIR, "task-closeout.md")}.`
				: ` This is a checker-only turn: read ${join(PLAYBOOKS_DIR, "task-closeout.md")} and do not continue implementation.`
			: "";
	const repair = entry.frontmatter.readable
		? ""
		: ` Its frontmatter is unreadable: also read ${join(PLAYBOOKS_DIR, "task-repair.md")}.`;
	const control = entry.frontmatter.control;
	const capsule = [
		`Task capsule: title=${entry.title}; status=${entry.frontmatter.status ?? "active"};`,
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
			"Advance the next concrete step under the task's current control, acceptance, approval, and verification state. " +
			`If complete or waiting, use the matching task_manage lifecycle/checkpoint action from the playbook.${verificationInstruction} ` +
			"If the task explicitly says there is no change and no tool action is needed, do not call task_manage; respond with exactly [SILENT]. Otherwise, if this wake produces no user-visible change or result, respond with exactly [SILENT].",
		ts: String(nowMs),
		conversationId: "",
		conversationType: channelId.startsWith("group_") ? "2" : "1",
	};
}

/** status done + a schedule cadence + a valid wake that is due → time to open the next cycle. */
function isCycleStartReady(entry: TaskLedgerEntry, nowMs: number): boolean {
	return (
		entry.frontmatter.status === "done" &&
		Boolean(entry.frontmatter.schedule) &&
		entry.wakeMs !== undefined &&
		entry.wakeMs <= nowMs
	);
}

/** done + schedule but no parseable wake → self-heal target (recompute wake, zero token). */
function needsWakeHeal(entry: TaskLedgerEntry): boolean {
	return entry.frontmatter.status === "done" && Boolean(entry.frontmatter.schedule) && entry.wakeMs === undefined;
}

function taskEscalationEvent(channelId: string, entry: TaskLedgerEntry, reason: string, nowMs: number): DingTalkEvent {
	return {
		type: channelId.startsWith("group_") ? "group" : "dm",
		channelId,
		user: "TASK_DRIVER",
		userName: "TASK_DRIVER",
		text:
			`[TASK_ESCALATION:${entry.id}] Task ${entry.id} (${entry.title}) was stopped by the deterministic task ` +
			`governor: ${reason}. Read ${join(PLAYBOOKS_DIR, "task-repair.md")}, diagnose before changing control, ` +
			"inform the user of the cause and recovery, and do not continue implementation in this run.",
		ts: String(nowMs),
		conversationId: "",
		conversationType: channelId.startsWith("group_") ? "2" : "1",
	};
}

function terminalDependencyReason(reason: string | undefined): string | undefined {
	return reason?.includes(" is missing") ||
		reason?.includes(" is cancelled") ||
		reason?.includes(" is paused by the governor") ||
		reason?.includes("dependency cycle")
		? reason
		: undefined;
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

	private observeDispatch(event: DingTalkEvent, accepted: boolean): void {
		try {
			this.options.onDispatch?.(event, accepted);
		} catch (error) {
			log.logWarning("Task driver dispatch observer failed", errorMessage(error));
		}
	}

	start(): void {
		if (this.loopActive) return;
		this.loopActive = true;
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
			this.noteHorizon(entry.wakeMs, nowMs);
			const control = entry.frontmatter.control;
			if (control?.deadline && !TERMINAL_STATUSES.has(entry.frontmatter.status ?? "")) {
				this.noteHorizon(new Date(control.deadline).getTime(), nowMs);
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
				const entries = await readActiveTasks(join(channelDir, "tasks"), nowMs);
				for (const entry of entries) seen.add(attemptKey(channelId, entry.id));
				this.collectHorizons(entries, nowMs);

				if (dispatched >= settings.maxDispatchesPerTick || this.options.isChannelActive(channelId)) continue;

				// Zero-token self-heal: a done recurring task with a missing/unparseable wake (usually a
				// hand edit that bypassed the runtime) gets its next occurrence recomputed via the same
				// `normalizeTaskFields` write-path invariant, rather than fail-open into an accidental cycle.
				for (const entry of entries) {
					if (!needsWakeHeal(entry)) continue;
					let healedWake: string | undefined;
					await updateStoredTask(channelDir, entry.id, (task) => {
						healedWake = normalizeTaskFields(task.fields).wake;
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
					if (!control || TERMINAL_STATUSES.has(status ?? "")) continue;
					const dependencies = await dependencyState(channelDir, control.dependsOn, candidate.id);
					const escalationReason =
						taskBudgetViolation(control, nowMs) ?? terminalDependencyReason(dependencies.reason);
					if (!escalationReason) continue;
					governanceHandled = true;
					const escalationEvent = taskEscalationEvent(channelId, candidate, escalationReason, nowMs);
					const accepted = await this.options.dispatch(escalationEvent);
					this.observeDispatch(escalationEvent, accepted);
					if (accepted && (await escalateTask(channelDir, candidate.id, escalationReason))) {
						dispatched++;
						lastDispatchOffset = offset;
						log.logWarning(`[${channelId}] Task driver escalated ${candidate.id}`, escalationReason);
					}
					break;
				}
				if (governanceHandled) continue;

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
				let entry: TaskLedgerEntry | undefined;
				for (const candidate of rotatedCandidates) {
					const control = candidate.frontmatter.control;
					if (control) {
						const dependencies = await dependencyState(channelDir, control.dependsOn, candidate.id);
						if (!dependencies.ready) continue;
					}
					entry = candidate;
					break;
				}
				if (!entry || dispatched >= settings.maxDispatchesPerTick) continue;

				// A cycle-start-ready recurring task is reopened in-process before dispatch: fold the
				// previous cycle, reset per-cycle control, mark it active. If the write fails we skip
				// this tick rather than dispatch a stale `done` capsule.
				if (!entry.actionable && isCycleStartReady(entry, nowMs)) {
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
					entry = {
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
				let fingerprint = await taskFingerprint(channelDir, entry);
				if (!isEligible(this.attempts.get(key), fingerprint, nowMs, settings)) continue;

				const claim = entry.frontmatter.control ? await claimTaskAttempt(channelDir, entry.id, now) : undefined;
				if (claim) {
					fingerprint = await taskFingerprint(channelDir, entry);
				}
				const event = createTaskDriverEvent(channelId, entry, nowMs);
				const accepted = await this.options.dispatch(event);
				this.observeDispatch(event, accepted);
				if (!accepted && claim) await releaseTaskAttemptClaim(channelDir, entry.id, claim, now);
				this.attempts.set(key, { fingerprint, atMs: nowMs, accepted });
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
			// so an unchanged ledger is still retried without polling. Changed ledgers arrive via nudge.
			for (const attempt of this.attempts.values()) {
				const delayMinutes = attempt.accepted ? settings.stalledRetryMinutes : settings.continuationDelayMinutes;
				this.noteHorizon(attempt.atMs + delayMinutes * 60_000, nowMs);
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
