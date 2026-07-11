import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import * as log from "../log.js";
import { PLAYBOOKS_DIR } from "../paths.js";
import type { PipiclawTaskDriverSettings } from "../settings.js";
import { taskEventName } from "../shared/task-events.js";
import { readActiveTasks, type TaskLedgerEntry } from "../shared/task-ledger.js";
import { errorMessage } from "../shared/text-utils.js";
import { taskBudgetViolation } from "../tasks/control.js";
import { claimTaskAttempt, dependencyState, escalateTask, releaseTaskAttemptClaim } from "../tasks/store.js";
import type { DingTalkEvent } from "./dingtalk.js";
import { parseScheduledEventContent } from "./events.js";

export interface TaskDriverOptions {
	workspaceDir: string;
	getKnownChannelIds?: () => Iterable<string>;
	isChannelActive: (channelId: string) => boolean;
	dispatch: (event: DingTalkEvent) => boolean | Promise<boolean>;
	getSettings: () => PipiclawTaskDriverSettings;
	intervalMs?: number;
}

interface DispatchAttempt {
	fingerprint: string;
	atMs: number;
	accepted: boolean;
}

const DEFAULT_SCAN_INTERVAL_MS = 60_000;
const LEGACY_CHECKIN_HANDOFF_GRACE_MS = 2 * 60_000;
const CHANNEL_ID_PATTERN = /^(dm|group)_[A-Za-z0-9._:-]+$/;

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

async function hasLiveLegacyCheckin(
	workspaceDir: string,
	channelId: string,
	taskId: string,
	nowMs: number,
): Promise<boolean> {
	const name = taskEventName(channelId, taskId, "checkin");
	const path = join(workspaceDir, "events", `${name}.json`);
	try {
		const event = parseScheduledEventContent(await readFile(path, "utf-8"), `${name}.json`);
		if (event.type !== "one-shot") return false;
		const atMs = new Date(event.at).getTime();
		return Number.isFinite(atMs) && atMs >= nowMs - LEGACY_CHECKIN_HANDOFF_GRACE_MS;
	} catch {
		return false;
	}
}

export function createTaskDriverEvent(channelId: string, entry: TaskLedgerEntry, nowMs: number): DingTalkEvent {
	const verification = entry.frontmatter.control?.verification;
	const verificationInstruction =
		entry.frontmatter.status === "verifying"
			? verification?.status === "passed"
				? " Independent verification already passed; preserve its body/artifact hashes and follow the closeout playbook."
				: " This is a checker-only turn: read the closeout playbook and do not continue implementation."
			: "";
	const repair = entry.frontmatter.readable
		? ""
		: ` Its frontmatter is unreadable: also read ${join(PLAYBOOKS_DIR, "task-repair.md")}.`;
	const control = entry.frontmatter.control;
	const capsule = [
		`Task capsule: title=${entry.title}; status=${entry.frontmatter.status ?? "open"};`,
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
			`If complete or waiting, use the matching task_manage lifecycle/checkpoint action from the playbook.${verificationInstruction}`,
		ts: String(nowMs),
		conversationId: "",
		conversationType: channelId.startsWith("group_") ? "2" : "1",
	};
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
		reason?.includes(" is escalated") ||
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
	private timer: ReturnType<typeof setInterval> | null = null;
	private running = false;
	private nextChannelIndex = 0;
	private readonly attempts = new Map<string, DispatchAttempt>();

	constructor(private readonly options: TaskDriverOptions) {}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			void this.runOnce().catch((error) => {
				log.logWarning("Task driver tick failed", errorMessage(error));
			});
		}, this.options.intervalMs ?? DEFAULT_SCAN_INTERVAL_MS);
		this.timer.unref?.();
	}

	stop(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = null;
	}

	async runOnce(now = new Date()): Promise<void> {
		const settings = this.options.getSettings();
		if (!settings.enabled || this.running) return;

		this.running = true;
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
				const entries = await readActiveTasks(join(channelDir, "tasks"), now.getTime());
				for (const entry of entries) seen.add(attemptKey(channelId, entry.id));

				if (dispatched >= settings.maxDispatchesPerTick || this.options.isChannelActive(channelId)) continue;
				let governanceHandled = false;
				for (const candidate of entries) {
					const status = candidate.frontmatter.status;
					const control = candidate.frontmatter.control;
					if (
						!control ||
						status === "done" ||
						status === "cancelled" ||
						status === "escalated" ||
						status === "paused"
					)
						continue;
					const dependencies = await dependencyState(channelDir, control.dependsOn, candidate.id);
					const escalationReason =
						taskBudgetViolation(control, now.getTime()) ?? terminalDependencyReason(dependencies.reason);
					if (!escalationReason) continue;
					governanceHandled = true;
					const accepted = await this.options.dispatch(
						taskEscalationEvent(channelId, candidate, escalationReason, now.getTime()),
					);
					if (accepted && (await escalateTask(channelDir, candidate.id, escalationReason))) {
						dispatched++;
						lastDispatchOffset = offset;
						log.logWarning(`[${channelId}] Task driver escalated ${candidate.id}`, escalationReason);
					}
					break;
				}
				if (governanceHandled) continue;
				const candidates = entries.filter((candidate) => candidate.actionable);
				if (candidates.length === 0) continue;
				let entry: TaskLedgerEntry | undefined;
				for (const candidate of candidates) {
					const control = candidate.frontmatter.control;
					if (!control) {
						entry = candidate;
						break;
					}
					const dependencies = await dependencyState(channelDir, control.dependsOn, candidate.id);
					if (!dependencies.ready) continue;
					entry = candidate;
					break;
				}
				if (!entry || dispatched >= settings.maxDispatchesPerTick) continue;
				// Upgrade compatibility: while a legacy task-owned one-shot is still
				// about to deliver this same wake, let it own the handoff. Once it is
				// consumed (or stale for >2m), the native driver becomes the recovery path.
				if (await hasLiveLegacyCheckin(this.options.workspaceDir, channelId, entry.id, now.getTime())) {
					continue;
				}
				const key = attemptKey(channelId, entry.id);
				let fingerprint = await taskFingerprint(channelDir, entry);
				if (!isEligible(this.attempts.get(key), fingerprint, now.getTime(), settings)) continue;

				const claim = entry.frontmatter.control ? await claimTaskAttempt(channelDir, entry.id, now) : undefined;
				if (claim) {
					fingerprint = await taskFingerprint(channelDir, entry);
				}
				const accepted = await this.options.dispatch(createTaskDriverEvent(channelId, entry, now.getTime()));
				if (!accepted && claim) await releaseTaskAttemptClaim(channelDir, entry.id, claim, now);
				this.attempts.set(key, { fingerprint, atMs: now.getTime(), accepted });
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
			this.nextChannelIndex = (start + (lastDispatchOffset >= 0 ? lastDispatchOffset + 1 : 1)) % channels.length;
		} finally {
			this.running = false;
		}
	}
}
