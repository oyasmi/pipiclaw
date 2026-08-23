import { mkdir, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import * as log from "../log.js";
import { formatLocalTime } from "../shared/local-time.js";
import { errorMessage } from "../shared/text-utils.js";
import { createDefaultTaskControl, parseLegacyTaskControl, type TaskControl } from "../tasks/control.js";
import { appendCurrentCycleNote, parseTaskFrontmatter, type TaskFrontmatter } from "../tasks/ledger.js";
import { withTaskMutation } from "../tasks/mutation-lock.js";
import { readStoredTask, updateStoredTask, writeStoredTask } from "../tasks/store.js";
import { parseTaskEventName, taskEventPrefix } from "../tasks/task-events.js";
import { TASK_STATUSES, type TaskStatus } from "../tasks/transitions.js";
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

/** Legacy v1 status vocabulary, mapped to the current status/archive/stop model. Migration-only. */
interface LegacyStatusMigration {
	status: TaskStatus;
	archiveOutcome?: "completed" | "cancelled";
	stopActor?: "user" | "governor";
}

function legacyStatusMigration(rawStatus: string | undefined, recurring: boolean): LegacyStatusMigration {
	switch (rawStatus) {
		case "done":
			return recurring ? { status: "sleeping" } : { status: "active", archiveOutcome: "completed" };
		case "cancelled":
			return { status: "active", archiveOutcome: "cancelled" };
		case "paused":
			return { status: "active", stopActor: "user" };
		case "escalated":
			return { status: "active", stopActor: "governor" };
		case "awaiting-user":
		case "blocked":
			return { status: "waiting" };
		default:
			return {
				status:
					rawStatus !== undefined && (TASK_STATUSES as readonly string[]).includes(rawStatus)
						? (rawStatus as TaskStatus)
						: "active",
			};
	}
}

/** Whether the control block needs a durable upgrade: absent, or not strict-v3-parseable. */
function needsControlMigration(frontmatter: TaskFrontmatter): boolean {
	return frontmatter.controlReadable === false || !frontmatter.control;
}

/** Whether the raw on-disk status needs a durable rewrite into the current vocabulary. */
function needsStatusMigration(frontmatter: TaskFrontmatter): boolean {
	const raw = frontmatter.rawStatus;
	return raw !== undefined && !(TASK_STATUSES as readonly string[]).includes(raw);
}

/**
 * Reconstruct a v3 control block for a file the strict reader rejected. Returns `undefined` only
 * when the stored control is genuinely unparseable (neither v3, nor legacy v1/v2) — that file is
 * left untouched for `/tasks doctor` to report, exactly like before this migration ran.
 */
function resolveMigratedControl(frontmatter: TaskFrontmatter): TaskControl | undefined {
	if (frontmatter.controlReadable === false) {
		if (!frontmatter.controlRaw) return createDefaultTaskControl();
		try {
			return parseLegacyTaskControl(frontmatter.controlRaw);
		} catch {
			return undefined;
		}
	}
	return createDefaultTaskControl();
}

/**
 * Deterministically upgrade every active task file to the current (v3) control contract and
 * status vocabulary (spec 043, phase 5). Unlike the earlier marker-gated pass, this scans and
 * self-heals on every startup: each file is judged independently by what it actually contains
 * (`control.version` and the raw `status` value), not by whether a one-time marker was written.
 * A hand-edited or freshly-restored legacy file is repaired the next time the daemon starts, no
 * matter how it got there. It never dispatches a task or performs an external action, and every
 * file is protected by the same per-task mutation lock as normal lifecycle writes.
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

					const controlNeedsMigration = needsControlMigration(frontmatter);
					if (!controlNeedsMigration && !needsStatusMigration(frontmatter)) return; // already v3

					let migratedControl = frontmatter.control;
					if (controlNeedsMigration) {
						migratedControl = resolveMigratedControl(frontmatter);
						if (!migratedControl) return; // genuinely corrupt; leave for doctor
					}

					const document = await readStoredTask(channelDir, id, false, true);
					if (!document) return;
					document.fields.control = migratedControl;

					const legacy = legacyStatusMigration(frontmatter.rawStatus, Boolean(frontmatter.schedule));
					document.fields.status = legacy.status;
					if (legacy.archiveOutcome) document.fields.outcome = legacy.archiveOutcome;
					if (legacy.stopActor) {
						document.fields.enabled = false;
						if (document.fields.control && !document.fields.control.stop) {
							document.fields.control.stop = {
								by: legacy.stopActor,
								reason: `Task stopped by ${legacy.stopActor}.`,
								at: formatLocalTime(),
							};
						}
					}

					// Very old hand-written tasks may have parked without ever recording a wake. Give the
					// waiting state an explicit note before any active driver wake can act on it silently.
					if (
						legacy.status === "waiting" &&
						!document.fields.wake &&
						document.fields.control &&
						!document.fields.control.waitingFor
					) {
						document.fields.control.waitingFor = "external-signal";
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
					log.logInfo(`Migrated task ${id} to TaskControl v3`, channelId);
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
