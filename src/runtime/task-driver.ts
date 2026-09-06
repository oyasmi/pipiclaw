import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ChannelEvent } from "../channel/channel-event.js";
import { discoverWorkspaceChannelIds } from "../channel/channel-index.js";
import { dedupeChannelIdsByDirectory, getChannelDir, isChannelId } from "../channel/channel-paths.js";
import * as log from "../log.js";
import { PLAYBOOKS_DIR } from "../paths.js";
import type { PipiclawTaskDriverSettings } from "../settings.js";
import { errorMessage } from "../shared/text-utils.js";
import { checkBudget, IDLE_STEP_LIMIT } from "../tasks/budget.js";
import { readActiveTasks, type TaskLedgerEntry } from "../tasks/ledger.js";
import { readTaskLog } from "../tasks/log.js";
import { expireTicket, openCycle, pauseTask, redeemTicket } from "../tasks/store.js";

export interface TaskDriverOptions {
	workspaceDir: string;
	getKnownChannelIds?: () => Iterable<string>;
	isChannelActive: (channelId: string) => boolean;
	dispatch: (event: ChannelEvent) => boolean | Promise<boolean>;
	/** Optional observability hook. It runs after every production dispatch attempt. */
	onDispatch?: (event: ChannelEvent, accepted: boolean) => void;
	getSettings: () => PipiclawTaskDriverSettings;
	/** Master autonomy switch (`tools.tasks.enabled`); re-read every tick. Defaults to on. */
	isEnabled?: () => boolean;
	/** Test-only override for the idle-sleep cap; production uses `settings.maxSleepMinutes`. */
	intervalMs?: number;
	/** Direct, non-LLM receipt for deterministic runtime stops. */
	notify?: (event: ChannelEvent) => boolean | Promise<boolean>;
}

/** Short debounce so a burst of nudges collapses into a single rescan. */
const NUDGE_DEBOUNCE_MS = 50;
/** Never schedule a scan closer than this, so near-now horizons cannot spin the loop. */
const MIN_SLEEP_MS = 250;
/** A task dispatched this recently is assumed still in flight; do not queue it twice. */
const REDISPATCH_GUARD_MS = 30_000;

/**
 * Channels this driver should scan. Live ids come first so a channel discovered on disk under
 * its escaped directory name never displaces the real id the runner map already knows.
 */
export async function discoverTaskChannels(
	workspaceDir: string,
	knownChannelIds: Iterable<string> = [],
): Promise<string[]> {
	return dedupeChannelIdsByDirectory([
		...[...knownChannelIds].filter(isChannelId),
		...(await discoverWorkspaceChannelIds(workspaceDir)),
	]);
}

function attemptKey(channelId: string, taskId: string): string {
	return `${channelId}\0${taskId}`;
}

function channelType(channelId: string): { type: ChannelEvent["type"]; conversationType: string } {
	return channelId.startsWith("group_")
		? { type: "group", conversationType: "2" }
		: { type: "dm", conversationType: "1" };
}

/**
 * Stable, provenance-derived dispatch id for a task step (spec 031, D1; spec 051 keeps the shape).
 * A step inside a cycle is genuinely new work each time, so the dispatch moment disambiguates it;
 * collapsing two steps onto one durable record would silently drop the later one.
 */
function stepDispatchId(channelId: string, entry: TaskLedgerEntry, nowMs: number): string {
	return `task:${channelId}:${entry.id}:${entry.fields.cycle?.id ?? "-"}:${nowMs}`;
}

export function createTaskDriverEvent(channelId: string, entry: TaskLedgerEntry, nowMs: number): ChannelEvent {
	const repairOnly = !entry.readable || entry.legacy;
	const repair = repairOnly
		? ` Task metadata is not readable; repair only the frontmatter in tasks/${entry.id}.md, then stop. ` +
			`Do not execute the task goal or any external action. Read ${join(PLAYBOOKS_DIR, "task-loop.md")} for the repair path.`
		: "";
	const capsule = [
		`Task capsule: title=${entry.title}; state=${entry.fields.state};`,
		entry.fields.cycle ? `cycle=${entry.fields.cycle.id} (${entry.fields.cycle.steps} steps);` : "",
		entry.plan
			? `plan=${entry.plan.done}/${entry.plan.total} done, current=${entry.plan.current?.id ?? "none"};`
			: "",
	]
		.filter(Boolean)
		.join(" ");
	return {
		...channelType(channelId),
		channelId,
		user: "TASK_DRIVER",
		userName: "TASK_DRIVER",
		text:
			`[TASK_DRIVER:${entry.id}] Resume task ${entry.id}. ${capsule}${repair} ` +
			`Open tasks/${entry.id}.md and read ${join(PLAYBOOKS_DIR, "task-loop.md")} before acting. ` +
			(repairOnly
				? "After the metadata is repaired, leave task work for a later step. "
				: "Advance the next concrete step under the task's current goal, plan and acceptance state. ") +
			"End the step with task_step_end (continue / park / done / blocked).",
		ts: String(nowMs),
		dispatchId: stepDispatchId(channelId, entry, nowMs),
	};
}

/**
 * The deterministic receipt a runtime stop produces (spec 051, D11). It is delivered directly,
 * without opening a model turn: the user needs to know their task stopped, and spending an LLM
 * call to phrase that is exactly the kind of cost this design removes.
 */
export function taskStopReceipt(
	channelId: string,
	entry: TaskLedgerEntry,
	reason: string,
	nowMs: number,
): ChannelEvent {
	return {
		...channelType(channelId),
		channelId,
		user: "TASK_DRIVER",
		userName: "TASK_DRIVER",
		text:
			`任务 ${entry.id}（${entry.title}）已停止自动执行：${reason}\n` +
			`当前阶段：${entry.fields.state}${entry.fields.cycle ? `；周期：${entry.fields.cycle.id}` : ""}\n` +
			`查看：/tasks show ${entry.id}\n继续：/tasks resume ${entry.id}\n不再需要：让 Agent cancel 该任务。`,
		ts: String(nowMs),
		// Keyed on the cause, not the moment: re-detecting the same stop before the user has acted
		// must not queue a second identical receipt, while a different cause still does.
		dispatchId: `task:${channelId}:${entry.id}:stop:${createHash("sha256").update(reason).digest("hex").slice(0, 12)}`,
	};
}

/**
 * Native, ticket-driven scheduler for the persistent task ledger (spec 051, D9).
 *
 * Four jobs, in this order per channel: redeem due `time`/`schedule` tickets, apply the backstop
 * to expired ones, open cycles for recurring tasks, and queue one step for a runnable task.
 * `run`/`job`/`ask`/`signal` tickets are never polled — their owners push them — so the scan
 * stays a cheap read of a handful of frontmatters.
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
	private nextChannelIndex = 0;
	/** Absolute ms of the next moment worth waking for, recomputed each scan. */
	private nextWakeMs: number | undefined;
	/** Last dispatch time per task, so one in-flight step is not queued again on the next tick. */
	private readonly lastDispatchMs = new Map<string, number>();
	/**
	 * Last task id dispatched per channel. Starting the search just after it gives every ready
	 * task in a channel the same round-robin fairness an actively-progressing task would
	 * otherwise monopolise.
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

	/** Stop one task and notify. Delivery failure is logged, never fatal: the durable stop already happened. */
	private async notifyStop(channelId: string, entry: TaskLedgerEntry, reason: string, nowMs: number): Promise<void> {
		try {
			await this.options.notify?.(taskStopReceipt(channelId, entry, reason, nowMs));
		} catch (error) {
			log.logWarning(`[${channelId}] Task stop receipt failed`, errorMessage(error));
		}
	}

	/**
	 * Deterministic, zero-token maintenance for one channel: redeem due tickets, apply expiry
	 * backstops, open recurring cycles. Runs whether or not the channel is busy — only model
	 * dispatch is gated on an idle channel.
	 */
	private async maintain(
		channelDir: string,
		channelId: string,
		entries: TaskLedgerEntry[],
		now: Date,
	): Promise<boolean> {
		const nowMs = now.getTime();
		let changed = false;
		for (const entry of entries) {
			if (entry.fields.paused || entry.fields.state !== "parked") continue;
			const ticket = entry.fields.ticket;
			if (!ticket) continue;

			// A due timer redeems into an open task; a due schedule opens the next cycle outright.
			if (entry.dueMs !== undefined && entry.dueMs <= nowMs) {
				if (ticket.kind === "schedule") {
					const opened = await openCycle(channelDir, entry.id, now).catch((error: unknown) => {
						log.logWarning(`[${channelId}] Could not open next cycle for ${entry.id}`, errorMessage(error));
						return undefined;
					});
					if (opened) {
						changed = true;
						log.logInfo(`[${channelId}] Task driver opened cycle ${opened.cycleId} for ${entry.id}`);
					}
				} else if (await redeemTicket(channelDir, entry.id, (current) => current.kind === ticket.kind)) {
					changed = true;
				}
				continue;
			}

			if (entry.expired) {
				const expiry = await expireTicket(channelDir, entry.id);
				if (!expiry) continue;
				changed = true;
				if (expiry.outcome === "paused") {
					log.logWarning(`[${channelId}] Task ${entry.id} paused: ticket expired twice`, expiry.ticket);
					await this.notifyStop(channelId, entry, `等待未兑现（${expiry.ticket}），已连续两次超过兜底时限`, nowMs);
				} else {
					log.logInfo(`[${channelId}] Task ${entry.id} reopened after its ticket expired`, expiry.ticket);
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
	private async detectIdleLoop(
		channelDir: string,
		channelId: string,
		entries: TaskLedgerEntry[],
		nowMs: number,
	): Promise<boolean> {
		let paused = false;
		for (const entry of entries) {
			const cycle = entry.fields.cycle;
			if (!cycle || cycle.steps < IDLE_STEP_LIMIT) continue;
			const steps = (await readTaskLog(channelDir, entry.id, { cycle: cycle.id, kinds: ["step"] })).slice(
				-IDLE_STEP_LIMIT,
			);
			if (steps.length < IDLE_STEP_LIMIT) continue;
			const idle = steps.every((record) => record.kind === "step" && record.tools.length === 0);
			if (!idle) continue;
			const reason = `连续 ${IDLE_STEP_LIMIT} 步没有任何工具调用，循环已停下等你确认`;
			if (await pauseTask(channelDir, entry.id, { by: "runtime", reason })) {
				paused = true;
				log.logWarning(`[${channelId}] Task ${entry.id} paused: idle loop`, reason);
				await this.notifyStop(channelId, entry, reason, nowMs);
			}
		}
		return paused;
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
				this.lastDispatchMs.clear();
				return;
			}

			const seen = new Set<string>();
			const start = this.nextChannelIndex % channels.length;
			let dispatched = 0;
			let lastDispatchOffset = -1;
			for (let offset = 0; offset < channels.length; offset++) {
				const channelId = channels[(start + offset) % channels.length];
				if (!channelId) continue;
				// `channelId` is the raw id, which for a DingTalk group routinely contains `/`;
				// only `getChannelDir` folds it into the escaped directory name that exists on disk.
				const channelDir = getChannelDir(this.options.workspaceDir, channelId);
				let entries = await readActiveTasks(join(channelDir, "tasks"), nowMs);
				for (const entry of entries) seen.add(attemptKey(channelId, entry.id));

				if (await this.maintain(channelDir, channelId, entries, now)) {
					entries = await readActiveTasks(join(channelDir, "tasks"), nowMs);
				}

				if (dispatched >= settings.maxDispatchesPerTick || this.options.isChannelActive(channelId)) continue;

				// A task that has already run out of budget must not spend one more model call to
				// discover that (D6). Checked before dispatch, and paired with a receipt so the user
				// learns why it stopped and what to type to give it more rope.
				const budgeted: TaskLedgerEntry[] = [];
				for (const entry of entries) {
					if (!entry.runnable) continue;
					const status = checkBudget(entry.fields, now);
					if (!status.breach || !status.reason) {
						budgeted.push(entry);
						continue;
					}
					if (await pauseTask(channelDir, entry.id, { by: "runtime", reason: status.reason })) {
						log.logWarning(`[${channelId}] Task ${entry.id} paused: budget ${status.breach}`, status.reason);
						await this.notifyStop(channelId, entry, status.reason, nowMs);
					}
				}
				const idled = await this.detectIdleLoop(channelDir, channelId, budgeted, nowMs);
				const ready = idled
					? (await readActiveTasks(join(channelDir, "tasks"), nowMs)).filter((entry) => entry.runnable)
					: budgeted;
				const candidates = ready.filter((entry) => !entry.fields.paused);
				if (candidates.length === 0) continue;
				const lastId = this.lastDispatchedTaskId.get(channelId);
				const lastIndex = lastId ? candidates.findIndex((candidate) => candidate.id === lastId) : -1;
				const rotated =
					lastIndex >= 0
						? [...candidates.slice(lastIndex + 1), ...candidates.slice(0, lastIndex + 1)]
						: candidates;

				const entry = rotated.find((candidate) => {
					const previous = this.lastDispatchMs.get(attemptKey(channelId, candidate.id));
					return previous === undefined || nowMs - previous >= REDISPATCH_GUARD_MS;
				});
				if (!entry) {
					for (const candidate of rotated) {
						const previous = this.lastDispatchMs.get(attemptKey(channelId, candidate.id));
						if (previous !== undefined) this.noteHorizon(previous + REDISPATCH_GUARD_MS, nowMs);
					}
					continue;
				}

				const event = createTaskDriverEvent(channelId, entry, nowMs);
				const accepted = await this.options.dispatch(event);
				this.observeDispatch(event, accepted);
				this.lastDispatchMs.set(attemptKey(channelId, entry.id), nowMs);
				this.lastDispatchedTaskId.set(channelId, entry.id);
				if (accepted) {
					dispatched++;
					lastDispatchOffset = offset;
					log.logInfo(`[${channelId}] Task driver enqueued ${entry.id}`);
				} else {
					log.logWarning(`[${channelId}] Task driver could not enqueue ${entry.id}`, "channel queue unavailable");
				}
			}

			for (const key of this.lastDispatchMs.keys()) {
				if (!seen.has(key)) this.lastDispatchMs.delete(key);
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
