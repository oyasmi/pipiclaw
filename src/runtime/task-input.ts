import { MAX_USER_MESSAGE_CHARS } from "../agent/types.js";
import * as log from "../log.js";
import { errorMessage } from "../shared/text-utils.js";
import { isTaskArchiving } from "../tasks/archive.js";
import { BRIEF_INPUT_LIMIT, renderTaskInputs } from "../tasks/brief.js";
import { pendingTaskClose } from "../tasks/completion.js";
import { newInputs, readTaskLog } from "../tasks/loop-log.js";
import { withTaskMutation } from "../tasks/mutation-lock.js";
import { readStoredTask } from "../tasks/store.js";
import { type LaneContext, type LiveTask, taskKey } from "./task-lane-types.js";

function eligible(ctx: LaneContext, live: LiveTask, step: NonNullable<LiveTask["step"]>): boolean {
	return (
		live.step === step &&
		!step.ending &&
		!step.abort &&
		!live.quarantined &&
		!ctx.isStopped() &&
		ctx.options.isEnabled?.() !== false &&
		ctx.options.isBoundTo(live.channelId, live.desk) &&
		ctx.options.isReachable(live.channelId) &&
		!live.intent.ask &&
		!live.intent.waitUntil &&
		!live.intent.close
	);
}

/** Serialize submission with task control writes and step teardown. Acceptance is never an ack. */
export async function submitTaskInput(
	ctx: LaneContext,
	live: LiveTask,
	text: string,
	ids: string[],
	from?: string,
): Promise<boolean> {
	const step = live.step;
	const runner = live.runner;
	if (!step || !runner || !eligible(ctx, live, step)) return false;
	const previous = step.submitting;
	const operation = (async () => {
		await previous;
		return withTaskMutation(live.deskDir, live.taskId, async () => {
			const document = await readStoredTask(live.deskDir, live.taskId);
			const records = await readTaskLog(live.deskDir, live.taskId);
			if (
				!document ||
				document.fields.outcome ||
				document.fields.channel !== live.channelId ||
				document.fields.state === "paused" ||
				isTaskArchiving(live.deskDir, live.taskId) ||
				pendingTaskClose(records) ||
				!eligible(ctx, live, step) ||
				live.runner !== runner
			)
				return false;
			const result = await runner.queueSteer(text, from, undefined, {
				seq: step.seq,
				isCurrent: () => eligible(ctx, live, step) && live.runner === runner,
			});
			if (result === "stale") return false;
			for (const id of ids) step.submittedInputIds.add(id);
			log.logInfoEvent("tasks.input.submitted", "Task inputs submitted", {
				fields: { desk: live.desk, taskId: live.taskId, seq: step.seq, generation: runner.generation, ids },
			});
			return true;
		});
	})();
	step.submitting = operation.then(
		() => undefined,
		() => undefined,
	);
	return operation;
}

/** Notifications collapse per task; a producer never waits on the running session. */
export class TaskInputDelivery {
	private readonly dirty = new Set<string>();
	private timer?: ReturnType<typeof setTimeout>;
	constructor(private readonly ctx: LaneContext) {}

	notify(desk: string, taskId: string): void {
		if (this.ctx.isStopped()) return;
		this.dirty.add(taskKey(desk, taskId));
		this.ctx.notify();
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			const keys = [...this.dirty];
			this.dirty.clear();
			for (const key of keys)
				void this.deliver(key).catch((error) =>
					log.logWarn("tasks.input.submit_failed", "Task input submission failed", {
						reason: errorMessage(error),
						fields: { key },
					}),
				);
		}, this.ctx.timing.notifyDebounceMs);
		this.timer.unref?.();
	}

	stop(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		this.dirty.clear();
	}

	private async deliver(key: string): Promise<void> {
		const live = this.ctx.live.get(key);
		const step = live?.step;
		if (!live || !step || !eligible(this.ctx, live, step)) return;
		if (step.injecting) {
			step.inputDirty = true;
			return;
		}
		step.injecting = true;
		try {
			const records = await readTaskLog(live.deskDir, live.taskId);
			const inputs = newInputs(records)
				.filter(
					(input) => input.kind === "settle" && !input.inline && input.id && !step.submittedInputIds.has(input.id),
				)
				.slice(0, BRIEF_INPUT_LIMIT);
			if (!inputs.length || !eligible(this.ctx, live, step)) return;
			let text = renderTaskInputs(records, inputs);
			// Preserve complete result blocks and receipt ids instead of clipping the middle of a burst.
			while (inputs.length > 1 && text && text.length + 32 > MAX_USER_MESSAGE_CHARS) {
				inputs.pop();
				text = renderTaskInputs(records, inputs);
			}
			if (
				text &&
				(await submitTaskInput(
					this.ctx,
					live,
					`<task_inputs>\n${text}\n</task_inputs>`,
					inputs.flatMap((input) => (input.id ? [input.id] : [])),
				))
			) {
				// More than one batch stays durable and is submitted on a later combined pass.
				this.notify(live.desk, live.taskId);
			}
		} finally {
			step.injecting = false;
			if (step.inputDirty) {
				step.inputDirty = false;
				this.notify(live.desk, live.taskId);
			}
		}
	}
}
