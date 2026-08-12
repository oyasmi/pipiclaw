import { mkdir, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import * as log from "../log.js";
import { formatLocalTime } from "../shared/local-time.js";
import { errorMessage } from "../shared/text-utils.js";
import { createDefaultTaskControl } from "../tasks/control.js";
import { appendCurrentCycleNote, parseTaskFrontmatter } from "../tasks/ledger.js";
import { withTaskMutation } from "../tasks/mutation-lock.js";
import { readStoredTask, updateStoredTask, writeStoredTask } from "../tasks/store.js";
import { parseTaskEventName, taskEventPrefix } from "../tasks/task-events.js";
import { parseScheduledEventContent } from "./events.js";
import { discoverTaskChannels } from "./task-driver.js";

/**
 * One-time migration closing the 027 window (spec 029, D6).
 *
 * Recurrence cadence now lives solely in a task's `schedule` frontmatter; the driver no
 * longer reads legacy canonical `.schedule` periodic events. On daemon start we fold any
 * residual `task.<channelId>.<id>.schedule.json` cron into the owning task's frontmatter
 * (frontmatter wins if it already has a schedule) and delete the event, so there is never
 * "two sources of truth" for a cadence again. Missing/archived tasks simply have their
 * orphaned event removed. Failures are logged and skipped — this must never block startup.
 */
export async function migrateLegacyTaskScheduleEvents(workspaceDir: string): Promise<void> {
	const eventsDir = join(workspaceDir, "events");
	let filenames: string[];
	try {
		filenames = (await readdir(eventsDir)).filter((name) => name.endsWith(".json"));
	} catch {
		return; // no events directory ⇒ nothing to migrate
	}
	if (filenames.length === 0) return;
	const channels = await discoverTaskChannels(workspaceDir);

	for (const filename of filenames) {
		const name = filename.slice(0, -".json".length);
		const channelId = channels.find((id) => name.startsWith(taskEventPrefix(id)));
		if (!channelId) continue;
		const parsed = parseTaskEventName(name, channelId);
		if (!parsed || parsed.use !== "schedule") continue;

		const eventPath = join(eventsDir, filename);
		let cron: string;
		try {
			const event = parseScheduledEventContent(await readFile(eventPath, "utf-8"), filename);
			if (event.type !== "periodic") continue; // not a cadence event; leave it for /events
			cron = event.schedule;
		} catch {
			continue; // unparseable ⇒ let /tasks doctor / the user handle it
		}

		try {
			let folded = false;
			const document = await updateStoredTask(join(workspaceDir, channelId), parsed.id, (task) => {
				if (!task.fields.schedule) {
					task.fields.schedule = cron;
					folded = true;
				}
			});
			await unlink(eventPath).catch(() => {});
			if (folded) {
				log.logInfo(`Migrated legacy schedule event ${name} into tasks/${parsed.id}.md`, cron);
			} else {
				log.logInfo(
					`Removed legacy schedule event ${name}`,
					document ? "task frontmatter already owns a schedule" : "no active task",
				);
			}
		} catch (error) {
			log.logWarning(`Could not migrate legacy schedule event ${name}`, errorMessage(error));
		}
	}
}

/**
 * Deterministically upgrade active-directory v1 task files to the v2 state vocabulary.
 *
 * The reader already maps old values while a process is running; this pass makes that mapping
 * durable at startup. It only rewrites task metadata/history notes and archives stale terminal
 * files. It never dispatches a task or performs an external action, and every file is protected
 * by the same per-task mutation lock as normal lifecycle writes.
 */
export async function migrateLegacyTaskState(workspaceDir: string): Promise<void> {
	const channels = await discoverTaskChannels(workspaceDir);
	for (const channelId of channels) {
		const channelDir = join(workspaceDir, channelId);
		const dir = join(channelDir, "tasks");
		let filenames: string[];
		try {
			filenames = (await readdir(dir)).filter((name) => name.endsWith(".md")).sort();
		} catch {
			continue;
		}
		for (const filename of filenames) {
			const id = filename.slice(0, -".md".length);
			try {
				await withTaskMutation(channelDir, id, async () => {
					const activePath = join(dir, filename);
					const raw = await readFile(activePath, "utf-8");
					const frontmatter = parseTaskFrontmatter(raw);
					if (!frontmatter.readable) return;
					if (frontmatter.controlReadable === false) return;
					const document = await readStoredTask(channelDir, id, false, true);
					if (!document) return;
					// Very old hand-written tasks may have no control block at all. Give them the
					// v2 default before any active driver wake can spend work without governance.
					document.fields.control ??= createDefaultTaskControl();

					const legacyStatus = frontmatter.rawStatus;
					if (
						(legacyStatus === "waiting" || legacyStatus === "awaiting-user" || legacyStatus === "blocked") &&
						!document.fields.wake &&
						document.fields.control &&
						!document.fields.control.waitingFor
					) {
						document.fields.control.waitingFor = "external-signal";
						document.fields.control.blockedReason ??=
							"Legacy waiting task requires review after the autonomy state upgrade.";
						document.body = appendCurrentCycleNote(
							document.body,
							"Migration note: this task remains waiting after the autonomy state upgrade; review its external condition before resuming.",
						);
					}

					if (document.fields.outcome) {
						const fileStat = await stat(activePath);
						document.fields.closedAt ??= formatLocalTime(new Date(fileStat.mtimeMs));
						await writeStoredTask(document);
						const archiveDir = join(dir, "archive");
						await mkdir(archiveDir, { recursive: true });
						await rename(activePath, join(archiveDir, filename));
						log.logInfo(`Migrated legacy terminal task ${id} to archive`, document.fields.outcome);
						return;
					}

					await writeStoredTask(document);
					if (legacyStatus || frontmatter.rawControl !== undefined || frontmatter.enabled === false) {
						log.logInfo(`Migrated task ${id} to TaskControl v2`, channelId);
					}
				});
			} catch (error) {
				log.logWarning(
					`Could not migrate task ${channelId}/${id}`,
					`${errorMessage(error)}. Use /tasks doctor to repair it.`,
				);
			}
		}
	}
}
