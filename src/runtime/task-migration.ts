import { readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import * as log from "../log.js";
import { parseTaskEventName, taskEventPrefix } from "../shared/task-events.js";
import { errorMessage } from "../shared/text-utils.js";
import { updateStoredTask } from "../tasks/store.js";
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
