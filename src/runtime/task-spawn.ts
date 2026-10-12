import { existsSync } from "node:fs";
import type { SpawnTaskRequest, SpawnTaskResult } from "../events/events.js";
import * as log from "../log.js";
import { readActiveTasks } from "../tasks/contract.js";
import { createTaskDocument, instanceStamp } from "../tasks/create.js";
import { taskStateLabel } from "../tasks/frontmatter.js";
import { archivedTaskPath, taskPath, tasksDir } from "../tasks/store.js";

export interface TaskSpawnerOptions {
	/** The channel's directory under the workspace. */
	getChannelDir: (channelId: string) => string;
	/** Wake the driver so the new instance's first step is queued promptly. */
	nudge: () => void;
	/** Direct, non-LLM message to the channel — used for the "previous instance still running" receipt. */
	notify: (channelId: string, text: string) => Promise<unknown>;
}

/**
 * Create the task instance a template event asks for (spec 052, D2).
 *
 * The instance id is `<event>-<YYYYMMDD>-<HHmm>` of the occurrence, so it is a pure function of
 * *which occurrence this is*: a replay after a crash lands on the same id and is recognized as
 * already spawned. That check comes first — otherwise the replay would find the instance it just
 * made and misreport it as a still-running predecessor.
 *
 * A second instance of the same event never runs alongside the first: two copies of the same
 * recurring job mostly duplicate work or collide. The occurrence is skipped and the user is told
 * every time (INV-7) — a stuck instance is something they need to know about, not something to
 * hide behind a quiet skip. The stuck instance itself is bounded by its budget, idle detection and
 * ticket backstops, so the skipping cannot go on forever.
 */
export function createTaskSpawner(
	options: TaskSpawnerOptions,
): (request: SpawnTaskRequest) => Promise<SpawnTaskResult> {
	return async (request) => {
		const channelDir = options.getChannelDir(request.channelId);
		const id = `${request.eventName}-${instanceStamp(request.occurrence)}`;

		if (existsSync(taskPath(channelDir, id)) || existsSync(archivedTaskPath(channelDir, id))) {
			return { outcome: "exists", id };
		}

		const active = (await readActiveTasks(tasksDir(channelDir))).find(
			(entry) => entry.fields.origin === request.eventName && !entry.fields.outcome,
		);
		if (active) {
			const state = `${taskStateLabel(active.fields.state)}${active.fields.paused ? "，已暂停" : ""}`;
			await options
				.notify(
					request.channelId,
					`⚠️ 周期任务 \`${request.eventName}\` 本次（${instanceStamp(request.occurrence)}）未启动：上一个实例 \`${active.id}\` 仍未结束（${state}）。\n查看：\`/tasks show ${active.id}\``,
				)
				.catch((error: unknown) => {
					log.logWarn("tasks.spawn.receipt_failed", "Skip receipt delivery failed", {
						channelId: request.channelId,
						reason: String(error),
						fields: { event: request.eventName },
					});
				});
			return { outcome: "skipped", id: active.id };
		}

		await createTaskDocument({
			channelDir,
			id,
			input: request.template,
			origin: request.eventName,
			now: request.occurrence,
		});
		log.logInfoEvent("tasks.spawn.created", "Event spawned a task instance", {
			channelId: request.channelId,
			fields: { event: request.eventName, taskId: id },
		});
		options.nudge();
		return { outcome: "spawned", id };
	};
}
