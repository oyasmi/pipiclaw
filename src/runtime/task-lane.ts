import { join } from "node:path";
import * as log from "../log.js";
import { parseLocalTime } from "../shared/local-time.js";
import { errorMessage } from "../shared/text-utils.js";
import { isTaskArchiving, recoverTaskArchives } from "../tasks/archive.js";
import { pendingTaskClose } from "../tasks/completion.js";
import { extractTaskTitle, readActiveTasks, type TaskLedgerEntry } from "../tasks/contract.js";
import type {
	TaskCancelOutcome,
	TaskControl,
	TaskControlOutcome,
	TaskLiveSnapshot,
	TaskMessageOutcome,
	TaskStepIntent,
} from "../tasks/control.js";
import { drainTaskDeliveries } from "../tasks/delivery.js";
import type { TaskBudget } from "../tasks/frontmatter.js";
import { appendTaskLog, lastStep, newInputs, readTaskLog } from "../tasks/loop-log.js";
import { withTaskMutation } from "../tasks/mutation-lock.js";
import { askReceipt, pausedReceipt } from "../tasks/receipts.js";
import { checkGuards, evaluateWaiting, type GuardVerdict } from "../tasks/state.js";
import { pauseTask, readStoredTask, reconcileTaskState, requeueWaiting } from "../tasks/store.js";
import { finishTaskClose } from "./task-close.js";
import { isFrozen, LaneControl } from "./task-control.js";
import {
	ERROR_BACKOFF_MS,
	type LaneContext,
	type LiveTask,
	MAX_EXECUTING_TASKS,
	MAX_EXECUTING_TASKS_PER_DESK,
	MAX_SLEEP_MS,
	NOTIFY_DEBOUNCE_MS,
	STEP_TIME_LIMIT_MS,
	type TaskLaneOptions,
	taskKey,
} from "./task-lane-types.js";
import { listPendingWork } from "./task-pending.js";
import { abortStep, executeStep, type StepReport } from "./task-step.js";

export type { TaskLaneOptions, TaskRunnerTarget } from "./task-lane-types.js";

/** One task as a scan saw it: its entry, the log when a decision needed it, and whether it is reachable. */
interface Seen {
	entry: TaskLedgerEntry;
	frozen: boolean;
	pendingWork: number;
}

interface DeskScan {
	desk: string;
	deskDir: string;
	seen: Seen[];
}

function isExecuting(seen: Seen, live: LiveTask | undefined): boolean {
	if (live?.driving) return true;
	if (seen.frozen) return false;
	const { fields } = seen.entry;
	return (
		fields.state === "running" ||
		(fields.state === "waiting" && fields.waiting?.kind === "work") ||
		(live?.driving ?? false)
	);
}

/**
 * The task lane (spec 064, D11): the one place tasks execute. A task never enters a channel queue —
 * the chat answers while a step runs and a step never waits for the chat (INV-1).
 *
 * The lane reads the task files, maintains them from facts (waits that came due, results that
 * arrived, budgets that ran out), admits queued tasks into the execution slots, and runs each
 * admitted task as a loop of steps in a runner of its own. Its in-memory state is only what a step
 * in flight needs; losing it (a restart) loses nothing, because every decision is recomputed from
 * the files and the log (D10).
 */
export class TaskLane implements TaskControl {
	private readonly ctx: LaneContext;
	private readonly control: LaneControl;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private notifyTimer: ReturnType<typeof setTimeout> | null = null;
	private started = false;
	private stopped = false;
	private scanning = false;
	private rescan = false;
	private nextDeskIndex = 0;
	private nextWakeMs: number | undefined;
	/** Tasks reported frozen, so the transition is logged once rather than every scan. */
	private readonly frozenLogged = new Set<string>();
	/** Consecutive step errors per task in this process, and when it may be admitted again (D16). Not persisted: a restart starts from zero. */
	/** Drive loops in flight, for `drained`. */
	private readonly drives = new Set<Promise<void>>();
	private readonly backoff = new Map<string, { errors: number; notBefore?: number }>();

	constructor(private readonly options: TaskLaneOptions) {
		const timing = {
			stepTimeLimitMs: options.timing?.stepTimeLimitMs ?? STEP_TIME_LIMIT_MS,
			stopGraceMs: options.timing?.stopGraceMs ?? 3_000,
			maxSleepMs: options.timing?.maxSleepMs ?? MAX_SLEEP_MS,
			notifyDebounceMs: options.timing?.notifyDebounceMs ?? NOTIFY_DEBOUNCE_MS,
			errorBackoffMs: options.timing?.errorBackoffMs ?? ERROR_BACKOFF_MS,
		};
		this.ctx = {
			options,
			live: new Map(),
			now: options.now ?? (() => Date.now()),
			timing,
			notify: () => this.notify(),
			release: (live) => this.release(live),
			isStopped: () => this.stopped,
		};
		this.control = new LaneControl(this.ctx);
	}

	// === Lifecycle ===

	start(): void {
		if (this.started) return;
		this.started = true;
		this.stopped = false;
		log.logInfoEvent("tasks.lane.started", "Task lane started", {
			fields: { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
		});
		this.notify();
	}

	/** Stop admitting, stop the steps in flight (their `step_end` is written by the next start, D10) and let go of every runner. */
	stop(): void {
		this.stopped = true;
		this.started = false;
		if (this.timer) clearTimeout(this.timer);
		if (this.notifyTimer) clearTimeout(this.notifyTimer);
		this.timer = null;
		this.notifyTimer = null;
		for (const live of this.ctx.live.values()) {
			abortStep(this.ctx, live, "shutdown");
			if (!live.driving) void this.dispose(live);
		}
	}

	/** Something changed that a task may need to react to (a result, a message, a new task): look again soon. */
	notify(): void {
		if (this.stopped || !this.started || this.notifyTimer) return;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		this.notifyTimer = setTimeout(() => {
			this.notifyTimer = null;
			void this.scan();
		}, this.ctx.timing.notifyDebounceMs);
		this.notifyTimer.unref?.();
	}

	/** Resolves when no step is in flight (and none was just started by a scan). For tests and evaluation workers. */
	async drained(): Promise<void> {
		await this.scanning_();
		while (this.drives.size > 0) await Promise.all([...this.drives]);
	}

	private async scanning_(): Promise<void> {
		while (this.scanning) await new Promise((resolve) => setTimeout(resolve, 2));
	}

	/** One scan now, outside the timer: the entry point tests and the runtime's own wiring use. */
	async runOnce(): Promise<void> {
		await this.scan();
	}

	// === TaskControl ===
	isRunning(desk: string, id: string): boolean {
		return this.ctx.live.get(taskKey(desk, id))?.driving ?? false;
	}

	created(): void {
		this.control.created();
	}

	snapshot(desk: string, id?: string): Promise<TaskLiveSnapshot[]> {
		return this.control.snapshot(desk, id);
	}

	message(
		desk: string,
		id: string,
		input: { from: string; channel: string; text: string },
	): Promise<TaskMessageOutcome> {
		return this.control.message(desk, id, input);
	}

	pause(desk: string, id: string, input: { by: "user"; reason: string }): Promise<TaskControlOutcome> {
		return this.control.pause(desk, id, input);
	}

	resume(desk: string, id: string, grants: Partial<TaskBudget>): Promise<TaskControlOutcome> {
		return this.control.resume(desk, id, grants);
	}

	cancel(desk: string, id: string, input: { by: "user"; note: string; channel?: string }): Promise<TaskCancelOutcome> {
		return this.control.cancel(desk, id, input);
	}

	// === Scanning ===

	private async scan(): Promise<void> {
		if (this.stopped) return;
		if (this.scanning) {
			this.rescan = true;
			return;
		}
		this.scanning = true;
		try {
			do {
				this.rescan = false;
				await this.scanOnce();
			} while (this.rescan && !this.stopped);
		} catch (error) {
			log.logWarn("tasks.lane.scan_failed", "Task lane scan failed", { reason: errorMessage(error) });
		} finally {
			this.scanning = false;
		}
		this.scheduleNext();
	}

	private scheduleNext(): void {
		if (this.stopped || !this.started || this.timer || this.notifyTimer) return;
		const untilNext = this.nextWakeMs !== undefined ? this.nextWakeMs - this.ctx.now() : Number.POSITIVE_INFINITY;
		const sleepMs = Math.max(250, Math.min(this.ctx.timing.maxSleepMs, untilNext));
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.scan();
		}, sleepMs);
		this.timer.unref?.();
	}

	private noteHorizon(atMs: number | undefined): void {
		const now = this.ctx.now();
		if (atMs === undefined || !Number.isFinite(atMs) || atMs <= now) return;
		if (this.nextWakeMs === undefined || atMs < this.nextWakeMs) this.nextWakeMs = atMs;
	}

	/** Read every active desk's tasks and note which are reachable (INV-7) and how much work each has in flight. */
	private async readDesk(desk: string, deskDir: string): Promise<DeskScan> {
		await recoverTaskArchives(deskDir);
		await this.flushDeliveries(desk, deskDir);
		const now = this.ctx.now();
		let entries = (await readActiveTasks(join(deskDir, "tasks"))).filter((entry) => !entry.fields.outcome);
		let pending = await listPendingWork(this.options, desk, now);
		// D10: whatever state the previous process left becomes true to the facts before anything is decided.
		for (const entry of entries) {
			if (!isFrozen(this.ctx, desk, entry.fields))
				await this.reconcile(desk, deskDir, entry, pending.get(entry.id)?.length ?? 0);
		}
		entries = (await readActiveTasks(join(deskDir, "tasks"))).filter((entry) => !entry.fields.outcome);
		pending = await listPendingWork(this.options, desk, now);
		const seen: Seen[] = [];
		for (const entry of entries) {
			const key = taskKey(desk, entry.id);
			const frozen = !entry.readable || isFrozen(this.ctx, desk, entry.fields);
			if (frozen && entry.readable) this.noteFrozen(key, desk, entry, true);
			else if (!frozen) this.noteFrozen(key, desk, entry, false);
			seen.push({ entry, frozen, pendingWork: pending.get(entry.id)?.length ?? 0 });
		}
		return { desk, deskDir, seen };
	}

	private noteFrozen(key: string, desk: string, entry: TaskLedgerEntry, frozen: boolean): void {
		if (frozen && !this.frozenLogged.has(key)) {
			this.frozenLogged.add(key);
			const channel = entry.fields.channel;
			log.logInfoEvent("tasks.task.frozen", "Task frozen: report channel not usable", {
				channelId: channel,
				fields: {
					taskId: entry.id,
					desk,
					reason: !channel
						? "channel_missing"
						: this.options.isBoundTo(channel, desk)
							? "channel_unreachable"
							: "channel_not_bound",
				},
			});
		} else if (!frozen && this.frozenLogged.delete(key)) {
			log.logInfoEvent("tasks.task.unfrozen", "Task unfrozen: report channel usable again", {
				channelId: entry.fields.channel,
				fields: { taskId: entry.id, desk },
			});
		}
	}

	private async reconcile(
		desk: string,
		deskDir: string,
		entry: TaskLedgerEntry,
		pendingWork: number,
	): Promise<boolean> {
		if (!entry.readable) return false;
		if (this.ctx.live.get(taskKey(desk, entry.id))?.driving) return false;
		try {
			const changed = await reconcileTaskState(deskDir, entry.id, pendingWork, new Date(this.ctx.now()));
			if (changed) {
				log.logInfoEvent("tasks.task.reconciled", "Task state repaired from the log", {
					fields: { taskId: entry.id, desk, was: entry.fields.state },
				});
			}
			return changed;
		} catch (error) {
			log.logWarn("tasks.task.reconcile_failed", "Task reconciliation failed", {
				reason: errorMessage(error),
				fields: { taskId: entry.id, desk },
			});
			return false;
		}
	}

	private async scanOnce(): Promise<void> {
		this.nextWakeMs = undefined;
		const desks = this.options.getActiveDesks();
		const scans: DeskScan[] = [];
		for (const { desk, deskDir } of desks) scans.push(await this.readDesk(desk, deskDir));

		// A task that is frozen holds no slot and no runner (INV-7); one that left execution releases its runner.
		for (const { desk, seen } of scans) {
			for (const item of seen) {
				const live = this.ctx.live.get(taskKey(desk, item.entry.id));
				if (live && !live.driving && (item.frozen || !isExecuting(item, live))) await this.release(live);
			}
		}

		// A task that vanished from its desk (deleted by hand) leaves nothing to execute or to remember.
		const seenKeys = new Set(scans.flatMap(({ desk, seen }) => seen.map((item) => taskKey(desk, item.entry.id))));
		for (const [key, live] of this.ctx.live) {
			if (!seenKeys.has(key) && !live.driving) await this.release(live);
		}

		const executingByDesk = new Map<string, number>();
		let executing = 0;
		for (const { desk, seen } of scans) {
			const count = seen.filter((item) => isExecuting(item, this.ctx.live.get(taskKey(desk, item.entry.id)))).length;
			executingByDesk.set(desk, count);
			executing += count;
		}

		// Maintenance first, for every desk (zero tokens): waits that came due, results that arrived.
		const enabled = this.options.isEnabled?.() !== false;
		const candidates = new Map<string, Seen[]>();
		for (const scan of scans) {
			const ready: Seen[] = [];
			for (const item of scan.seen) {
				if (item.frozen) continue;
				const decision = await this.maintain(scan, item);
				if (decision === "queued") ready.push(item);
				else if (decision === "run" && enabled) {
					// A work wait with news keeps its slot and runner: no admission, but the guards still apply.
					if (await this.guard(scan, item)) continue;
					this.startDrive(scan, item);
				}
			}
			candidates.set(scan.desk, ready);
		}
		if (!enabled) return;

		// Admission: oldest project first within a desk, desks in rotation (D11/D12).
		const start = scans.length > 0 ? this.nextDeskIndex % scans.length : 0;
		let admitted = 0;
		for (let offset = 0; offset < scans.length; offset++) {
			const scan = scans[(start + offset) % scans.length];
			if (!scan) continue;
			const ready = (candidates.get(scan.desk) ?? []).sort(compareByStart);
			for (const item of ready) {
				if (executing >= MAX_EXECUTING_TASKS) break;
				if ((executingByDesk.get(scan.desk) ?? 0) >= MAX_EXECUTING_TASKS_PER_DESK) break;
				if (this.ctx.live.get(taskKey(scan.desk, item.entry.id))?.driving) continue;
				const notBefore = this.backoff.get(taskKey(scan.desk, item.entry.id))?.notBefore;
				if (notBefore !== undefined && notBefore > this.ctx.now()) {
					this.noteHorizon(notBefore);
					continue;
				}
				if (await this.guard(scan, item)) continue;
				this.startDrive(scan, item);
				executingByDesk.set(scan.desk, (executingByDesk.get(scan.desk) ?? 0) + 1);
				executing++;
				admitted++;
			}
		}
		if (admitted > 0) this.nextDeskIndex = (start + 1) % Math.max(1, scans.length);
	}

	/**
	 * Zero-token upkeep of one reachable task (D7/D9). Returns `queued` when the task is waiting
	 * its turn, `run` when a work wait has news and runs again in its own slot, `idle` otherwise.
	 */
	private async maintain(scan: DeskScan, item: Seen): Promise<"queued" | "run" | "idle"> {
		const { fields } = item.entry;
		const live = this.ctx.live.get(taskKey(scan.desk, item.entry.id));
		if (live?.driving) return "idle";
		if (isTaskArchiving(scan.deskDir, item.entry.id)) {
			this.noteHorizon(this.ctx.now() + 60_000);
			return "idle";
		}
		const history = await readTaskLog(scan.deskDir, item.entry.id);
		// A user's cancel pauses before writing close. A crash in between close and archive
		// preparation must finish that close; a later explicit/error pause still takes precedence.
		const lastBoundary = [...history].reverse().find((record) => record.kind === "close" || record.kind === "pause");
		const committedAfterPause = lastBoundary?.kind === "close";
		if (fields.state !== "paused" || committedAfterPause) {
			const records = history;
			const close = pendingTaskClose(records);
			if (close) {
				await this.closeForLeader(
					{
						key: taskKey(scan.desk, item.entry.id),
						desk: scan.desk,
						deskDir: scan.deskDir,
						taskId: item.entry.id,
						channelId: fields.channel ?? "",
						seq: lastStep(records)?.step.seq ?? 0,
						intent: { reports: 0 },
						driving: false,
					},
					item.entry.title,
					{ reports: 0, close },
				);
				return "idle";
			}
		}
		if (fields.state === "queued") return "queued";
		if (fields.state === "running") {
			// Marked running with no step in this process: repaired like a restart would (D10).
			if (await this.reconcile(scan.desk, scan.deskDir, item.entry, item.pendingWork)) this.rescan = true;
			return "idle";
		}
		if (fields.state !== "waiting" || !fields.waiting) return "idle";

		const records = await readTaskLog(scan.deskDir, item.entry.id);
		const decision = evaluateWaiting({
			waiting: fields.waiting,
			inputs: newInputs(records),
			pendingWork: item.pendingWork,
			now: this.ctx.now(),
		});
		if (fields.waiting.kind === "time") this.noteHorizon(parseLocalTime(fields.waiting.until));
		if (decision === "stay") {
			if (fields.waiting.kind === "user")
				await this.deliverQuestion(scan.desk, scan.deskDir, item.entry.id, fields.channel);
			return "idle";
		}
		if (decision === "run") return "run";
		const requeued = await requeueWaiting(scan.deskDir, item.entry.id);
		return requeued ? "queued" : "idle";
	}

	/** Stop a task the guards say must not run again: pause it and tell the user why (D16). True when it was stopped. */
	private async guard(scan: DeskScan, item: Seen): Promise<boolean> {
		const doc = await readStoredTask(scan.deskDir, item.entry.id);
		if (!doc) return true;
		const records = await readTaskLog(scan.deskDir, item.entry.id);
		const verdict = checkGuards(doc.fields, records);
		if (!verdict) return false;
		await this.pauseForGuard(scan.desk, scan.deskDir, item.entry.id, doc.fields.channel, doc.body, verdict);
		return true;
	}

	private async pauseForGuard(
		desk: string,
		deskDir: string,
		taskId: string,
		channel: string | undefined,
		body: string,
		verdict: GuardVerdict,
	): Promise<void> {
		const paused = await pauseTask(deskDir, taskId, { by: "runtime", reason: verdict.reason });
		if (!paused) return;
		log.logWarn("tasks.task.paused", "Task paused by a runtime guard", {
			channelId: channel,
			reason: verdict.reason,
			fields: { taskId, desk, cause: verdict.breach },
		});
		if (!channel) return;
		await this.options
			.deliver(desk, channel, pausedReceipt(taskId, extractTaskTitle(body, taskId), verdict.reason, verdict.breach))
			.catch((error: unknown) =>
				log.logWarn("tasks.task.receipt_failed", "Task pause receipt failed", {
					channelId: channel,
					reason: errorMessage(error),
					fields: { taskId, desk },
				}),
			);
	}

	// === Execution ===

	private startDrive(scan: DeskScan, item: Seen): void {
		const drives = [...this.ctx.live.values()].filter((task) => task.driving);
		if (
			drives.length >= MAX_EXECUTING_TASKS ||
			drives.filter((task) => task.desk === scan.desk).length >= MAX_EXECUTING_TASKS_PER_DESK
		)
			return;
		const key = taskKey(scan.desk, item.entry.id);
		let live = this.ctx.live.get(key);
		if (!live) {
			live = {
				key,
				desk: scan.desk,
				deskDir: scan.deskDir,
				taskId: item.entry.id,
				channelId: item.entry.fields.channel ?? "",
				seq: 0,
				intent: { reports: 0 },
				driving: false,
			};
			this.ctx.live.set(key, live);
		}
		if (live.driving) return;
		live.driving = true;
		live.channelId = item.entry.fields.channel ?? live.channelId;
		const task = this.drive(live).catch((error: unknown) => {
			log.logWarn("tasks.step.failed", "Task step failed", {
				channelId: live.channelId,
				reason: errorMessage(error),
				fields: { taskId: live.taskId, desk: live.desk },
			});
		});
		const tracked = task.finally(() => {
			this.options.activeTasks.delete(tracked);
			this.drives.delete(tracked);
			live.driving = false;
			if (this.stopped) void this.dispose(live);
			else this.notify();
		});
		this.options.activeTasks.add(tracked);
		live.done = tracked;
		this.drives.add(tracked);
	}

	/** Steps in a row while the task has something to do and a slot (D8: `continue` opens the next at once). */
	private async drive(live: LiveTask): Promise<void> {
		while (!this.stopped) {
			const document = await readStoredTask(live.deskDir, live.taskId);
			if (
				!document ||
				isFrozen(this.ctx, live.desk, document.fields) ||
				this.options.isEnabled?.() === false ||
				this.isBackingOff(live.key) ||
				(await this.guardLive(live))
			) {
				await this.dispose(live);
				return;
			}
			const report = await executeStep(this.ctx, live);
			if (report.kind === "interrupted") return;
			if (report.kind === "skipped") {
				await this.dispose(live);
				return;
			}
			if ((await this.afterStep(live, report)) !== "again") return;
		}
	}

	/** Act on a finished step: close, ask, pause, wait — or open the next. */
	private async afterStep(live: LiveTask, report: Extract<StepReport, { kind: "ended" }>): Promise<"again" | "done"> {
		const { ended, derivation, result } = report;
		if (!ended) {
			// The task was cancelled or removed while the step ran.
			await this.dispose(live);
			return "done";
		}
		const title = extractTaskTitle(ended.document.body, live.taskId);
		const previous = this.backoff.get(live.key);
		const errors = result === "error" ? (previous?.errors ?? 0) + 1 : 0;
		if (errors === 0) this.backoff.delete(live.key);
		else this.backoff.set(live.key, { errors, notBefore: this.backoffUntil(errors) });
		switch (derivation.next) {
			case "closed":
				this.backoff.delete(live.key);
				await this.closeForLeader(live, title, report.intent);
				return "done";
			case "paused":
			case "time":
				await this.dispose(live);
				return "done";
			case "user":
				await this.deliverQuestion(live.desk, live.deskDir, live.taskId, live.channelId);
				await this.dispose(live);
				return "done";
			case "work":
				// Results that arrived while the step ran wake the task at once instead of after a scan (D8).
				return (await this.reevaluate(live)) === "run" ? "again" : "done";
			case "continue":
				// A failed step is re-run after a pause, and the third failure in a row stops the task (D16).
				if (await this.guardLive(live)) {
					await this.dispose(live);
					return "done";
				}
				if (result !== "ok") {
					await this.dispose(live);
					return "done";
				}
				// Switching tasks off stops the next step, not the one in flight.
				if (this.options.isEnabled?.() === false) {
					await this.dispose(live);
					return "done";
				}
				return "again";
		}
	}

	private isBackingOff(key: string): boolean {
		const until = this.backoff.get(key)?.notBefore;
		if (until === undefined || until <= this.ctx.now()) return false;
		this.noteHorizon(until);
		return true;
	}

	private readonly questionRetry = new Map<string, number>();
	private async deliverQuestion(
		desk: string,
		deskDir: string,
		id: string,
		channel: string | undefined,
	): Promise<void> {
		const key = taskKey(desk, id);
		if (!channel || (this.questionRetry.get(key) ?? 0) > this.ctx.now()) {
			this.noteHorizon(this.questionRetry.get(key));
			return;
		}
		const doc = await readStoredTask(deskDir, id);
		if (
			!doc ||
			doc.fields.state !== "waiting" ||
			doc.fields.waiting?.kind !== "user" ||
			isFrozen(this.ctx, desk, doc.fields)
		)
			return;
		const question = doc.fields.waiting.question;
		const records = await readTaskLog(deskDir, id);
		const seq = lastStep(records)?.step.seq ?? 0;
		if (records.some((record) => record.kind === "ask_delivered" && record.seq === seq)) return;
		this.questionRetry.set(key, this.ctx.now() + 60_000);
		try {
			if (await this.options.deliver(desk, doc.fields.channel ?? channel, askReceipt(id, question))) {
				await withTaskMutation(deskDir, id, async () => {
					const current = await readStoredTask(deskDir, id);
					if (
						current?.fields.state === "waiting" &&
						current.fields.waiting?.kind === "user" &&
						current.fields.waiting.question === question &&
						current.fields.channel === doc.fields.channel &&
						lastStep(await readTaskLog(deskDir, id))?.step.seq === seq
					) {
						await appendTaskLog(deskDir, id, { kind: "ask_delivered", seq });
					}
				});
				this.questionRetry.delete(key);
			}
		} catch (error) {
			log.logWarn("tasks.question.deliver_failed", "Task question delivery failed", {
				reason: errorMessage(error),
				fields: { taskId: id, desk },
			});
		}
		this.noteHorizon(this.questionRetry.get(key));
	}

	private backoffUntil(errors: number): number | undefined {
		const wait = this.ctx.timing.errorBackoffMs[Math.min(errors - 1, this.ctx.timing.errorBackoffMs.length - 1)];
		return wait === undefined ? undefined : this.ctx.now() + wait;
	}

	/** After a step: the freshest state and log decide whether the task goes on (budget, idle, timeout, error). True when it was stopped. */
	private async guardLive(live: LiveTask): Promise<boolean> {
		const doc = await readStoredTask(live.deskDir, live.taskId);
		if (!doc) return true;
		const records = await readTaskLog(live.deskDir, live.taskId);
		const verdict = checkGuards(doc.fields, records);
		if (!verdict) return false;
		await this.pauseForGuard(live.desk, live.deskDir, live.taskId, doc.fields.channel, doc.body, verdict);
		return true;
	}

	/** Whether a task waiting on work has news right now, and may run (guards included). */
	private async reevaluate(live: LiveTask): Promise<"run" | "stay"> {
		const doc = await readStoredTask(live.deskDir, live.taskId);
		const waiting = doc?.fields.waiting;
		if (!doc || doc.fields.state !== "waiting" || waiting?.kind !== "work") return "stay";
		if (isFrozen(this.ctx, live.desk, doc.fields)) {
			await this.dispose(live);
			return "stay";
		}
		const records = await readTaskLog(live.deskDir, live.taskId);
		const pending = (await listPendingWork(this.options, live.desk, this.ctx.now())).get(live.taskId)?.length ?? 0;
		const decision = evaluateWaiting({
			waiting,
			inputs: newInputs(records),
			pendingWork: pending,
			now: this.ctx.now(),
		});
		if (decision === "stay") return "stay";
		if (decision === "queue") {
			await requeueWaiting(live.deskDir, live.taskId);
			await this.dispose(live);
			return "stay";
		}
		if (checkGuards(doc.fields, records)) {
			await this.guardLive(live);
			await this.dispose(live);
			return "stay";
		}
		return "run";
	}

	private async closeForLeader(live: LiveTask, title: string, intent: TaskStepIntent): Promise<void> {
		this.noteHorizon(
			await finishTaskClose(
				this.ctx,
				live,
				title,
				intent,
				(desk, id) => this.control.cancelBoundWork(desk, id),
				(live) => this.dispose(live),
			),
		);
	}

	private async flushDeliveries(desk: string, deskDir: string): Promise<void> {
		try {
			this.noteHorizon(
				await drainTaskDeliveries(
					deskDir,
					(channel, text) => this.options.deliver(desk, channel, text),
					(channel) => this.options.isBoundTo(channel, desk) && this.options.isReachable(channel),
					this.ctx.now(),
				),
			);
		} catch (error) {
			log.logWarn("tasks.delivery.drain_failed", "Task delivery drain failed", {
				reason: errorMessage(error),
				fields: { desk },
			});
			this.noteHorizon(this.ctx.now() + 60_000);
		}
	}

	/** Let go of a task that left execution — unless a drive loop is still working on it, which then does it itself. */
	private async release(live: LiveTask): Promise<void> {
		if (live.driving && !this.stopped) return;
		await this.dispose(live);
	}

	/** Dispose a task's runner and forget its in-memory state (D13). */
	private async dispose(live: LiveTask): Promise<void> {
		if (this.ctx.live.get(live.key) === live) this.ctx.live.delete(live.key);
		const runner = live.runner;
		live.runner = undefined;
		if (!runner) return;
		try {
			await runner.dispose();
		} catch (error) {
			log.logWarn("tasks.runner.dispose_failed", "Task runner dispose failed", {
				channelId: live.channelId,
				reason: errorMessage(error),
				fields: { taskId: live.taskId, desk: live.desk },
			});
		}
	}
}

function compareByStart(a: Seen, b: Seen): number {
	const start = (seen: Seen) => seen.entry.fields.usage?.startedAt ?? "";
	return start(a) < start(b) ? -1 : start(a) > start(b) ? 1 : a.entry.id.localeCompare(b.entry.id);
}
