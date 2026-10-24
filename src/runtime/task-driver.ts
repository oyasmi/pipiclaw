import { createHash } from "node:crypto";
import { join } from "node:path";
import type { WakeEvent } from "../channel/channel-event.js";
import { type PipiclawTaskDriverSettings, TASK_DRIVER_SETTINGS } from "../config/settings.js";
import * as log from "../log.js";
import { PLAYBOOKS_DIR } from "../paths.js";
import { errorMessage } from "../shared/text-utils.js";
import { type BudgetBreach, checkBudget, IDLE_STEP_LIMIT } from "../tasks/budget.js";
import { readActiveTasks, type TaskLedgerEntry } from "../tasks/contract.js";
import { taskStateLabel } from "../tasks/frontmatter.js";
import { readTaskLog } from "../tasks/loop-log.js";
import { expireTicket, pauseTask, redeemTicket } from "../tasks/store.js";

export interface TaskDriverOptions {
	/** The desks this driver scans — the active ones (spec 058, D6). A dormant desk's tasks are never touched. */
	getActiveDesks: () => ReadonlyArray<{ desk: string; deskDir: string }>;
	/**
	 * Whether a delivery channel is bound to a desk right now. A task whose `channel` is missing or
	 * not bound to its own desk is suspended: frozen entirely, not merely undelivered (D8).
	 */
	isBoundTo: (channelId: string, desk: string) => boolean;
	/**
	 * Whether the delivery channel's transport is switched on in this process. A task delivering to
	 * a transport that is off is suspended the same way (spec 061, INV-8): nothing could be said to
	 * its channel, so the task waits, untouched, until the transport is back.
	 */
	isReachable: (channelId: string) => boolean;
	isChannelActive: (channelId: string) => boolean;
	dispatch: (event: WakeEvent) => boolean | Promise<boolean>;
	/** Optional observability hook. It runs after every production dispatch attempt. */
	onDispatch?: (event: WakeEvent, accepted: boolean) => void;
	/** Test-only override; production uses `TASK_DRIVER_SETTINGS`. */
	settings?: PipiclawTaskDriverSettings;
	/** Master autonomy switch (`tools.tasks.enabled`); re-read every tick. Defaults to on. */
	isEnabled?: () => boolean;
	/** Test-only override for the idle-sleep cap; production uses `settings.maxSleepMinutes`. */
	intervalMs?: number;
	/** Direct, non-LLM receipt for deterministic runtime stops. */
	notify?: (event: WakeEvent) => boolean | Promise<boolean>;
}

/** Short debounce so a burst of nudges collapses into a single rescan. */
const NUDGE_DEBOUNCE_MS = 50;
/** Never schedule a scan closer than this, so near-now horizons cannot spin the loop. */
const MIN_SLEEP_MS = 250;
/** A task dispatched this recently is assumed still in flight; do not queue it twice. */
const REDISPATCH_GUARD_MS = 30_000;

function attemptKey(desk: string, taskId: string): string {
	return `${desk}\0${taskId}`;
}

/**
 * Stable, provenance-derived dispatch id for a task step (spec 031, D1; spec 051 keeps the shape).
 * Each step is genuinely new work, so the dispatch moment disambiguates it; collapsing two steps
 * onto one durable record would silently drop the later one.
 */
function stepDispatchId(desk: string, entry: TaskLedgerEntry, nowMs: number): string {
	return `task:${desk}:${entry.id}:${nowMs}`;
}

/** The task a `[TASK_DRIVER:<id>]` dispatch text names, if it is one. */
export function parseDriverTaskId(text: string | undefined): string | undefined {
	return /^\[TASK_DRIVER:([A-Za-z0-9._-]+)\]/.exec(text ?? "")?.[1];
}

export function createTaskDriverEvent(
	desk: string,
	channelId: string,
	entry: TaskLedgerEntry,
	nowMs: number,
): WakeEvent {
	const repairOnly = !entry.readable;
	const repair = repairOnly
		? ` Task metadata is not readable; repair only the frontmatter in tasks/${entry.id}.md, then stop. ` +
			`Do not execute the task goal or any external action. Read ${join(PLAYBOOKS_DIR, "task-lead.md")} for the repair path.`
		: "";
	const capsule = [
		`Task capsule: title=${entry.title}; state=${entry.fields.state};`,
		entry.fields.usage ? `${entry.fields.usage.steps} steps so far;` : "",
		entry.items
			? `items=${entry.items.done}/${entry.items.total} done, current=${entry.items.current?.id ?? "none"};`
			: "",
	]
		.filter(Boolean)
		.join(" ");
	return {
		source: "wake",
		channelId,
		producer: "TASK_DRIVER",
		text:
			`[TASK_DRIVER:${entry.id}] Resume task ${entry.id}. ${capsule}${repair} ` +
			`Open tasks/${entry.id}.md and read ${join(PLAYBOOKS_DIR, "task-lead.md")} before acting. ` +
			(repairOnly
				? "After the metadata is repaired, leave task work for a later step. "
				: "Advance the next concrete step under the task's current goal, work items and acceptance state. ") +
			"End the step with task_step_end (continue / park / done).",
		ts: String(nowMs),
		dispatchId: stepDispatchId(desk, entry, nowMs),
		desk,
	};
}

/**
 * The deterministic receipt a runtime stop produces (spec 051, D11). It is delivered directly,
 * without opening a model turn: the user needs to know their task stopped, and spending an LLM
 * call to phrase that is exactly the kind of cost this design removes. A budget stop also says
 * how to resume with more of the dimension that ran out (spec 053, D6).
 */
export function taskStopReceipt(
	desk: string,
	channelId: string,
	entry: TaskLedgerEntry,
	reason: string,
	nowMs: number,
	breach?: BudgetBreach,
): WakeEvent {
	const usage = entry.fields.usage ? ` · 已用 ${entry.fields.usage.steps} 步` : "";
	const grant = breach === "steps" ? " +steps 10" : breach === "usd" ? " +usd 5" : "";
	const resumeLabel = grant ? "继续并追加预算" : "继续";
	return {
		source: "wake",
		channelId,
		producer: "TASK_DRIVER",
		text:
			`🛑 任务 \`${entry.id}\`（${entry.title}）已停止自动执行：${reason}。\n` +
			`状态：${taskStateLabel(entry.fields.state)}${usage}\n` +
			`查看：\`/tasks show ${entry.id}\`；${resumeLabel}：\`/tasks resume ${entry.id}${grant}\`\n` +
			"不再需要：直接告诉我取消该任务。",
		ts: String(nowMs),
		// Keyed on the cause, not the moment: re-detecting the same stop before the user has acted
		// must not queue a second identical receipt, while a different cause still does.
		dispatchId: `task:${desk}:${entry.id}:stop:${createHash("sha256").update(reason).digest("hex").slice(0, 12)}`,
		desk,
	};
}

/** A task the driver may touch this scan, with the delivery channel that made it eligible. */
interface LiveTask {
	entry: TaskLedgerEntry;
	channelId: string;
}

/**
 * Native, ticket-driven scheduler for the persistent task ledger (spec 051, D9; spec 052).
 *
 * Three jobs, in this order per desk: redeem due `time` tickets, apply the backstop to expired
 * ones, and queue one step for a runnable task. `work` and `ask` tickets are never polled — their
 * owners push them (a settling delegation or job, `/tasks reply`) — so the scan stays a cheap read
 * of a handful of frontmatters. Recurring work is not the driver's business: an event spawns a
 * fresh task instance each time (spec 052, D2).
 *
 * What is deliberately *not* here any more: the ten-field ledger fingerprint, the process-local
 * effect ledger, the futile-wake and wake-per-cycle counters, and the three-tier backoff table.
 * They existed to guess whether a wake had accomplished anything; in production they fired twice
 * in four months while the failure that actually happened — a task parked with no redeemable
 * source, silent for 13 days — was invisible to all of them. Stopping is now the loop's own job
 * (a budget it can see) and liveness is the ticket's (a backstop the runtime enforces).
 */
export class TaskDriver {
	private timer: ReturnType<typeof setTimeout> | null = null;
	private nudgeTimer: ReturnType<typeof setTimeout> | null = null;
	private loopActive = false;
	private running = false;
	private nextDeskIndex = 0;
	/** Absolute ms of the next moment worth waking for, recomputed each scan. */
	private nextWakeMs: number | undefined;
	/** Last dispatch time per task, so one in-flight step is not queued again on the next tick. */
	private readonly lastDispatchMs = new Map<string, number>();
	/**
	 * Last task id dispatched per desk. Starting the search just after it gives every ready task in
	 * a desk the same round-robin fairness an actively-progressing task would otherwise monopolise.
	 */
	private readonly lastDispatchedTaskId = new Map<string, string>();
	/** Tasks currently suspended (D8), so the transition is logged once rather than every scan. */
	private readonly suspended = new Set<string>();

	constructor(private readonly options: TaskDriverOptions) {}

	private observeDispatch(event: WakeEvent, accepted: boolean): void {
		try {
			this.options.onDispatch?.(event, accepted);
		} catch (error) {
			log.logWarn("taskdriver.observer.failed", "Task driver dispatch observer failed", {
				reason: errorMessage(error),
			});
		}
	}

	start(): void {
		if (this.loopActive) return;
		this.loopActive = true;
		log.logInfoEvent("taskdriver.started", "Task driver started", {
			fields: { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
		});
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
	 * In-process wake: after a step ends or a task file is written, re-scan promptly instead of
	 * waiting out the current sleep. This is what makes `outcome: continue` cost nothing — the
	 * next step is queued on the same nudge rather than after a continuation delay.
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
			log.logWarn("taskdriver.tick.failed", "Task driver tick failed", { reason: errorMessage(error) });
		}
		this.scheduleNext();
	}

	private scheduleNext(): void {
		if (!this.loopActive || this.timer || this.nudgeTimer) return;
		const settings = this.options.settings ?? TASK_DRIVER_SETTINGS;
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

	/** Stop one task and notify. Delivery failure is logged, never fatal: the durable stop already happened. */
	private async notifyStop(
		desk: string,
		channelId: string,
		entry: TaskLedgerEntry,
		reason: string,
		nowMs: number,
		breach?: BudgetBreach,
	): Promise<void> {
		try {
			await this.options.notify?.(taskStopReceipt(desk, channelId, entry, reason, nowMs, breach));
		} catch (error) {
			log.logWarn("taskdriver.receipt.failed", "Task stop receipt failed", {
				channelId: channelId,
				reason: errorMessage(error),
			});
		}
	}

	/**
	 * Deterministic, zero-token maintenance for one desk's live tasks: redeem due tickets and apply
	 * expiry backstops. Runs whether or not the delivery channel is busy — only model dispatch is
	 * gated on an idle channel.
	 */
	private async maintain(desk: string, deskDir: string, entries: LiveTask[], now: Date): Promise<boolean> {
		const nowMs = now.getTime();
		let changed = false;
		for (const { entry, channelId } of entries) {
			if (entry.fields.paused || entry.fields.state !== "parked") continue;
			const ticket = entry.fields.ticket;
			if (!ticket) continue;

			// A due timer redeems into an open task.
			if (entry.dueMs !== undefined && entry.dueMs <= nowMs) {
				if (await redeemTicket(deskDir, entry.id, (current) => current.kind === ticket.kind)) changed = true;
				continue;
			}

			if (entry.expired) {
				const expiry = await expireTicket(deskDir, entry.id);
				if (!expiry) continue;
				changed = true;
				if (expiry.outcome === "paused") {
					log.logWarn("taskdriver.task.paused", "Task paused: ticket expired twice", {
						channelId: channelId,
						reason: expiry.ticket,
						fields: { taskId: entry.id, desk, cause: "ticket_expired" },
					});
					await this.notifyStop(
						desk,
						channelId,
						entry,
						`等待条件一直未满足（${expiry.ticket}），已连续两次超过最晚检查时间`,
						nowMs,
					);
				} else {
					log.logInfoEvent("taskdriver.task.reopened", "Task reopened after its ticket expired", {
						channelId: channelId,
						reason: expiry.ticket,
						fields: { taskId: entry.id, desk },
					});
				}
				continue;
			}

			this.noteHorizon(entry.dueMs, nowMs);
			this.noteHorizon(new Date(ticket.by).getTime(), nowMs);
		}
		return changed;
	}

	/**
	 * Stop a loop that is talking to itself: two consecutive steps that produced no tool call at
	 * all. This is the honest replacement for v3's futile-wake counter — the loop log records what
	 * each step actually did, so "no progress" is an observed fact rather than a fingerprint
	 * comparison a `echo x` could defeat.
	 */
	private async detectIdleLoop(desk: string, deskDir: string, entries: LiveTask[], nowMs: number): Promise<boolean> {
		let paused = false;
		for (const { entry, channelId } of entries) {
			const usage = entry.fields.usage;
			if (!usage || usage.steps < IDLE_STEP_LIMIT) continue;
			const steps = (await readTaskLog(deskDir, entry.id, { kinds: ["step"] })).slice(-IDLE_STEP_LIMIT);
			if (steps.length < IDLE_STEP_LIMIT) continue;
			const idle = steps.every((record) => record.kind === "step" && record.tools.length === 0);
			if (!idle) continue;
			const reason = `连续 ${IDLE_STEP_LIMIT} 步没有任何工具调用，已停下等你确认`;
			if (await pauseTask(deskDir, entry.id, { by: "runtime", reason })) {
				paused = true;
				log.logWarn("taskdriver.task.paused", "Task paused: idle loop", {
					channelId: channelId,
					reason: reason,
					fields: { taskId: entry.id, desk, cause: "idle" },
				});
				await this.notifyStop(desk, channelId, entry, reason, nowMs);
			}
		}
		return paused;
	}

	/**
	 * The tasks of one desk the driver may touch at all (spec 058, D8): those whose delivery channel
	 * is bound to this desk and reachable. Every other task — no `channel`, or a channel bound elsewhere or nowhere, or on a transport that is off
	 * — is frozen: no ticket redemption, no backstop, no budget or idle check, no step, no receipt.
	 * Freezing reads nothing back into the file, so a rebound task resumes from exactly where it was.
	 */
	private liveTasks(desk: string, entries: TaskLedgerEntry[]): LiveTask[] {
		const live: LiveTask[] = [];
		for (const entry of entries) {
			const key = attemptKey(desk, entry.id);
			const channelId = entry.fields.channel;
			if (channelId && this.options.isBoundTo(channelId, desk) && this.options.isReachable(channelId)) {
				if (this.suspended.delete(key)) {
					log.logInfoEvent("taskdriver.task.resumed", "Task resumed: delivery channel bound again", {
						channelId,
						fields: { taskId: entry.id, desk },
					});
				}
				live.push({ entry, channelId });
				continue;
			}
			if (!this.suspended.has(key)) {
				this.suspended.add(key);
				log.logInfoEvent("taskdriver.task.suspended", "Task suspended: delivery channel not usable", {
					channelId,
					fields: {
						taskId: entry.id,
						desk,
						reason: !channelId
							? "channel_missing"
							: this.options.isBoundTo(channelId, desk)
								? "channel_unreachable"
								: "channel_not_bound",
					},
				});
			}
		}
		return live;
	}

	async runOnce(now = new Date()): Promise<void> {
		if (this.options.isEnabled?.() === false || this.running) return;
		const settings = this.options.settings ?? TASK_DRIVER_SETTINGS;
		const nowMs = now.getTime();

		this.running = true;
		this.nextWakeMs = undefined;
		try {
			const desks = this.options.getActiveDesks();
			if (desks.length === 0) {
				this.lastDispatchMs.clear();
				return;
			}

			const seen = new Set<string>();
			const start = this.nextDeskIndex % desks.length;
			let dispatched = 0;
			let lastDispatchOffset = -1;
			for (let offset = 0; offset < desks.length; offset++) {
				const target = desks[(start + offset) % desks.length];
				if (!target) continue;
				const { desk, deskDir } = target;
				const tasksDir = join(deskDir, "tasks");
				const readLive = async () => this.liveTasks(desk, await readActiveTasks(tasksDir, nowMs));
				let live = await readLive();
				for (const { entry } of live) seen.add(attemptKey(desk, entry.id));

				if (await this.maintain(desk, deskDir, live, now)) live = await readLive();

				if (dispatched >= settings.maxDispatchesPerTick) continue;

				// A task that has already run out of budget must not spend one more model call to
				// discover that (D6). Checked before dispatch, and paired with a receipt so the user
				// learns why it stopped and what to type to give it more rope.
				const budgeted: LiveTask[] = [];
				for (const task of live) {
					const { entry, channelId } = task;
					if (!entry.runnable) continue;
					const status = checkBudget(entry.fields);
					if (!status.breach || !status.reason) {
						budgeted.push(task);
						continue;
					}
					if (await pauseTask(deskDir, entry.id, { by: "runtime", reason: status.reason })) {
						log.logWarn("taskdriver.task.paused", "Task paused: budget exhausted", {
							channelId: channelId,
							reason: status.reason,
							fields: { taskId: entry.id, desk, cause: `budget_${status.breach}` },
						});
						await this.notifyStop(desk, channelId, entry, status.reason, nowMs, status.breach);
					}
				}
				const idled = await this.detectIdleLoop(desk, deskDir, budgeted, nowMs);
				const ready = idled ? (await readLive()).filter(({ entry }) => entry.runnable) : budgeted;
				// The busy check is per task: a desk's tasks may deliver to different channels.
				const candidates = ready.filter(
					({ entry, channelId }) => !entry.fields.paused && !this.options.isChannelActive(channelId),
				);
				if (candidates.length === 0) continue;
				const lastId = this.lastDispatchedTaskId.get(desk);
				const lastIndex = lastId ? candidates.findIndex(({ entry }) => entry.id === lastId) : -1;
				const rotated =
					lastIndex >= 0
						? [...candidates.slice(lastIndex + 1), ...candidates.slice(0, lastIndex + 1)]
						: candidates;

				// One step per delivery channel per pass: a desk's tasks may deliver to different channels,
				// whose queues run independently, so one channel's step must not hold back another's.
				// Tasks sharing a channel still take turns (D6 rotation).
				const usedChannels = new Set<string>();
				for (const { entry, channelId } of rotated) {
					if (dispatched >= settings.maxDispatchesPerTick) break;
					if (usedChannels.has(channelId)) continue;
					const previous = this.lastDispatchMs.get(attemptKey(desk, entry.id));
					if (previous !== undefined && nowMs - previous < REDISPATCH_GUARD_MS) {
						this.noteHorizon(previous + REDISPATCH_GUARD_MS, nowMs);
						continue;
					}
					usedChannels.add(channelId);
					const event = createTaskDriverEvent(desk, channelId, entry, nowMs);
					const accepted = await this.options.dispatch(event);
					this.observeDispatch(event, accepted);
					this.lastDispatchMs.set(attemptKey(desk, entry.id), nowMs);
					this.lastDispatchedTaskId.set(desk, entry.id);
					if (accepted) {
						dispatched++;
						lastDispatchOffset = offset;
						log.logDebugEvent("taskdriver.step.enqueued", "Task step enqueued", {
							channelId: channelId,
							fields: { taskId: entry.id, desk },
						});
					} else {
						log.logWarn("taskdriver.step.enqueue_failed", "Task step not enqueued: channel queue unavailable", {
							channelId: channelId,
							fields: { taskId: entry.id, desk },
						});
					}
				}
			}

			for (const key of this.lastDispatchMs.keys()) {
				if (!seen.has(key)) this.lastDispatchMs.delete(key);
			}
			const deskSet = new Set(desks.map((target) => target.desk));
			for (const desk of this.lastDispatchedTaskId.keys()) {
				if (!deskSet.has(desk)) this.lastDispatchedTaskId.delete(desk);
			}
			this.nextDeskIndex = (start + (lastDispatchOffset >= 0 ? lastDispatchOffset + 1 : 1)) % desks.length;
		} finally {
			this.running = false;
		}
	}
}
