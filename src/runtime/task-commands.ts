import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { parseTaskEventName, taskEventPrefix } from "../shared/task-events.js";
import {
	extractTaskTitle,
	missingStandardTaskSections,
	normalizeTaskId,
	readActiveTasks,
	type TaskLedgerEntry,
} from "../shared/task-ledger.js";
import { errorMessage } from "../shared/text-utils.js";
import { taskBudgetViolation } from "../tasks/control.js";
import {
	claimTaskAttempt,
	readStoredTask,
	releaseTaskAttemptClaim,
	taskBodyHash,
	writeStoredTask,
} from "../tasks/store.js";
import { normalizeStoredStatus, resolveTaskTransition } from "../tasks/transitions.js";
import { readVerificationAttestation } from "../tasks/verification.js";
import { parseScheduledEventContent, type ScheduledEvent } from "./events.js";

export interface HandleTasksCommandOptions {
	args: string;
	/** The channel directory; tasks live in `<channelDir>/tasks/`. */
	channelDir: string;
	/** Workspace directory; required for `/tasks doctor` because events are workspace-scoped. */
	workspaceDir?: string;
	channelId?: string;
	/** Direct command issuer; used to create an auditable external-action approval. */
	approver?: string;
	/** Optional immediate task wake, available in the long-lived DingTalk runtime. */
	dispatchTask?: (id: string) => Promise<boolean>;
}

type TasksCommand =
	| { action: "list" }
	| { action: "show"; id: string }
	| { action: "archive" }
	| { action: "doctor" }
	| { action: "approve"; id: string }
	| { action: "pause"; id: string }
	| { action: "resume"; id: string }
	| { action: "run"; id: string }
	| { action: "stats"; id?: string };

function usage(): string {
	return `# Tasks

Usage:

- \`/tasks\` — list active tasks in this channel
- \`/tasks show <id>\` — show a single task file (active or archived)
- \`/tasks archive\` — list archived (closed) tasks
- \`/tasks approve <id>\` — explicitly approve this task's external side effects
- \`/tasks pause <id>\` — stop automatic wake-ups for a task
- \`/tasks resume <id>\` — make a paused task eligible for the next driver scan
- \`/tasks run <id>\` — resume and immediately enqueue one task attempt when the runtime is available
- \`/tasks stats [id]\` — show task-level attempt, token, cost, and verification outcomes
- \`/tasks doctor\` — check task/event consistency without changing files`;
}

function parseTasksCommand(args: string): TasksCommand {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const action = parts[0];

	if (!action || action === "list") {
		if (parts.length > 1) throw new Error("Usage: /tasks list");
		return { action: "list" };
	}
	if (action === "show") {
		const id = parts[1];
		if (!id || parts.length > 2) throw new Error("Usage: /tasks show <id>");
		return { action: "show", id };
	}
	if (action === "archive") {
		if (parts.length > 1) throw new Error("Usage: /tasks archive");
		return { action: "archive" };
	}
	if (action === "doctor") {
		if (parts.length > 1) throw new Error("Usage: /tasks doctor");
		return { action: "doctor" };
	}
	if (action === "approve") {
		const id = parts[1];
		if (!id || parts.length > 2) throw new Error("Usage: /tasks approve <id>");
		return { action: "approve", id };
	}
	if (action === "pause" || action === "resume") {
		const id = parts[1];
		if (!id || parts.length > 2) throw new Error(`Usage: /tasks ${action} <id>`);
		return { action, id };
	}
	if (action === "run") {
		const id = parts[1];
		if (!id || parts.length > 2) throw new Error("Usage: /tasks run <id>");
		return { action: "run", id };
	}
	if (action === "stats") {
		const id = parts[1];
		if (parts.length > 2) throw new Error("Usage: /tasks stats [id]");
		return { action: "stats", id };
	}
	throw new Error(`Unknown /tasks action: ${action}`);
}

function tasksDir(channelDir: string): string {
	return join(channelDir, "tasks");
}

/** Resolve `<tasksDir>/[archive/]<id>.md`, rejecting any path that escapes the tasks dir. */
function resolveTaskPath(dir: string, id: string, subdir?: string): string {
	const base = resolve(dir);
	const target = resolve(base, subdir ?? "", `${id}.md`);
	const expected = subdir ? join(base, subdir, `${id}.md`) : join(base, `${id}.md`);
	if (target !== expected || !target.startsWith(`${base}${sep}`)) {
		throw new Error(`Invalid task id: ${id}`);
	}
	return target;
}

function relativeWake(wakeMs: number | undefined, now: number): string {
	if (wakeMs === undefined) return "—";
	const iso = new Date(wakeMs).toISOString();
	const diffMs = wakeMs - now;
	if (diffMs <= 0) return `${iso} (due)`;
	const minutes = Math.round(diffMs / 60000);
	const rel =
		minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1440)}d`;
	return `${iso} (${rel})`;
}

interface TaskEventInfo {
	filename: string;
	name: string;
	id?: string;
	use?: string;
	event?: ScheduledEvent;
	error?: string;
}

function eventDir(workspaceDir: string): string {
	return join(workspaceDir, "events");
}

async function readArchivedTaskIds(channelDir: string): Promise<Set<string>> {
	const archiveDir = join(tasksDir(channelDir), "archive");
	const ids = new Set<string>();
	if (!existsSync(archiveDir)) return ids;
	for (const filename of await readdir(archiveDir)) {
		if (filename.endsWith(".md")) ids.add(filename.slice(0, -".md".length));
	}
	return ids;
}

async function readTaskEvents(workspaceDir: string, channelId: string): Promise<TaskEventInfo[]> {
	const dir = eventDir(workspaceDir);
	if (!existsSync(dir)) return [];
	const prefix = taskEventPrefix(channelId);
	const events: TaskEventInfo[] = [];
	for (const filename of (await readdir(dir)).filter((name) => name.endsWith(".json")).sort()) {
		const name = filename.slice(0, -".json".length);
		if (!name.startsWith(prefix)) continue;
		const split = parseTaskEventName(name, channelId);
		const info: TaskEventInfo = { filename, name, ...(split ?? {}) };
		try {
			info.event = parseScheduledEventContent(await readFile(join(dir, filename), "utf-8"), filename);
		} catch (error) {
			info.error = errorMessage(error);
		}
		events.push(info);
	}
	return events;
}

function validWakeMs(entry: TaskLedgerEntry): number | undefined {
	const wake = entry.frontmatter.wake;
	if (!wake) return undefined;
	const ms = new Date(wake).getTime();
	return Number.isFinite(ms) ? ms : undefined;
}

function issue(problem: string, nextStep: string): string {
	return `- ${problem}\n  Next step: ${nextStep}`;
}

function relationCycles(graph: Map<string, string[]>): string[][] {
	const visited = new Set<string>();
	const active = new Set<string>();
	const stack: string[] = [];
	const cycles = new Map<string, string[]>();
	const visit = (id: string): void => {
		if (active.has(id)) {
			const start = stack.indexOf(id);
			const cycle = [...stack.slice(start), id];
			const key = [...new Set(cycle)].sort().join("\0");
			cycles.set(key, cycle);
			return;
		}
		if (visited.has(id)) return;
		visited.add(id);
		active.add(id);
		stack.push(id);
		for (const next of graph.get(id) ?? []) {
			if (graph.has(next)) visit(next);
		}
		stack.pop();
		active.delete(id);
	};
	for (const id of graph.keys()) visit(id);
	return Array.from(cycles.values());
}

async function readActiveTaskContent(channelDir: string, id: string): Promise<string | undefined> {
	try {
		return await readFile(join(tasksDir(channelDir), `${id}.md`), "utf-8");
	} catch {
		return undefined;
	}
}

async function listTasks(channelDir: string): Promise<string> {
	const dir = tasksDir(channelDir);
	const now = Date.now();
	const entries = await readActiveTasks(dir, now);
	if (entries.length === 0) {
		return "# Tasks\n\nNo active tasks.";
	}

	const blocks = entries.map((entry) => {
		const status = entry.frontmatter.readable ? (entry.frontmatter.status ?? "active") : "⚠ unreadable frontmatter";
		const detail = [`  status: ${status}`, `next wake: ${relativeWake(entry.wakeMs, now)}`];
		const control = entry.frontmatter.control;
		if (control) {
			detail.push(`priority: ${control.priority}`);
			detail.push(`attempts: ${control.usage.attempts}/${control.budget.maxAttempts}`);
			detail.push(`verify: ${control.verification.mode}/${control.verification.status}`);
			if (control.isolation !== "shared") detail.push(`isolation: ${control.isolation}`);
			if (control.sideEffects !== "workspace") {
				detail.push(`effects: ${control.sideEffects}/${control.externalApproval}`);
			}
			if (control.deadline) detail.push(`deadline: ${control.deadline}`);
			if (control.parent) detail.push(`parent: ${control.parent}`);
			if (control.dependsOn.length > 0) detail.push(`depends: ${control.dependsOn.join(",")}`);
			if (control.nextAction) detail.push(`next: ${control.nextAction}`);
			if (control.worktree?.branch) detail.push(`branch: ${control.worktree.branch}`);
			if (control.cycleId) {
				detail.push(`${status === "done" ? "last" : "current"} cycle: ${control.cycleId}`);
			}
		}
		if (entry.frontmatter.recurrence) detail.push(`recurrence: ${entry.frontmatter.recurrence}`);
		if (entry.frontmatter.schedule) {
			detail.push(`schedule timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone} (host)`);
		}
		return `- ${entry.id} — ${entry.title}\n${detail.join("   ")}`;
	});
	return `# Tasks: ${entries.length} active\n\n${blocks.join("\n")}`;
}

async function approveTask(options: HandleTasksCommandOptions, idInput: string): Promise<string> {
	const id = normalizeTaskId(idInput);
	const task = await readStoredTask(options.channelDir, id);
	if (!task) return `Task not found: ${id}`;
	const control = task.fields.control;
	if (!control) return `Task ${id} has no governed control metadata. Ask the agent to normalize it before approval.`;
	if (task.fields.status === "done" || task.fields.status === "cancelled") {
		return `Task ${id} is ${task.fields.status} and cannot receive a new external-action approval.`;
	}
	if (control.sideEffects !== "external") {
		return `Task ${id} is not marked for external side effects; no approval is required.`;
	}
	if (control.externalApproval === "granted") {
		return `Task ${id} was already approved by ${control.approvalBy ?? "a user"} at ${control.approvedAt ?? "an unknown time"}.`;
	}
	control.externalApproval = "granted";
	control.approvalBy = options.approver?.trim() || "unknown-user";
	control.approvedAt = new Date().toISOString();
	control.approvalBodyHash = taskBodyHash(task.body);
	await writeStoredTask(task);
	return `Approved external side effects for task ${id}. Approval is recorded for ${control.approvalBy}.`;
}

export async function pauseTask(options: HandleTasksCommandOptions, idInput: string): Promise<string> {
	const id = normalizeTaskId(idInput);
	const task = await readStoredTask(options.channelDir, id);
	if (!task) return `Task not found: ${id}`;
	const from = normalizeStoredStatus(task.fields.status);
	if (from === "paused") return `Task ${id} is already paused.`;
	try {
		resolveTaskTransition("pause", id, from);
	} catch (error) {
		return errorMessage(error);
	}
	task.fields.status = "paused";
	task.fields.wake = undefined;
	if (task.fields.control) {
		task.fields.control.pausedBy = "user";
		task.fields.control.lastOutcome = "blocked";
		task.fields.control.blockedReason = `Paused by ${options.approver?.trim() || "a user"}.`;
	}
	await writeStoredTask(task);
	return `Paused task ${id}. Use /tasks resume ${id} when it should continue.`;
}

export async function resumeTask(options: HandleTasksCommandOptions, idInput: string): Promise<string> {
	const id = normalizeTaskId(idInput);
	const task = await readStoredTask(options.channelDir, id);
	if (!task) return `Task not found: ${id}`;
	const from = normalizeStoredStatus(task.fields.status);
	if (from !== "paused") return `Task ${id} is ${from}, not paused.`;
	resolveTaskTransition("resume", id, from);
	task.fields.status = "active";
	task.fields.wake = undefined;
	if (task.fields.control) {
		task.fields.control.pausedBy = undefined;
		task.fields.control.lastOutcome = "pending";
		task.fields.control.blockedReason = undefined;
	}
	await writeStoredTask(task);
	return `Resumed task ${id}; the task driver will pick it up on its next scan.`;
}

async function runTask(options: HandleTasksCommandOptions, idInput: string): Promise<string> {
	const id = normalizeTaskId(idInput);
	const task = await readStoredTask(options.channelDir, id);
	if (!task) return `Task not found: ${id}`;
	const from = normalizeStoredStatus(task.fields.status);
	try {
		resolveTaskTransition("run", id, from);
	} catch (error) {
		return errorMessage(error);
	}
	task.fields.status = "active";
	task.fields.wake = undefined;
	if (task.fields.control) {
		task.fields.control.pausedBy = undefined;
		task.fields.control.lastOutcome = "pending";
		task.fields.control.blockedReason = undefined;
	}
	await writeStoredTask(task);
	const now = new Date();
	const claim = task.fields.control ? await claimTaskAttempt(options.channelDir, id, now) : undefined;
	const enqueued = await options.dispatchTask?.(id);
	if (!enqueued && claim) await releaseTaskAttemptClaim(options.channelDir, id, claim, now);
	return enqueued
		? `Enqueued task ${id} for an immediate attempt.`
		: `Task ${id} is ready. Start or use the DingTalk daemon for automatic dispatch, or send a normal prompt in this session to advance it.`;
}

function renderUsageLine(entry: TaskLedgerEntry): string {
	const control = entry.frontmatter.control;
	if (!control) return `- ${entry.id}: legacy task (no governed usage recorded)`;
	const verification = control.verification;
	const cycleCost = control.usage.costKnown ? `$${control.usage.costUsd.toFixed(4)}` : "unavailable";
	const lifetimeCost = control.lifetimeUsage.costKnown
		? `$${control.lifetimeUsage.costUsd.toFixed(4)}`
		: "unavailable";
	return [
		`- ${entry.id} — ${entry.title}`,
		`  this cycle: ${control.usage.attempts}/${control.budget.maxAttempts} attempts, ${control.usage.tokens} tokens, ${cycleCost}, ${control.usage.wallTimeMinutes.toFixed(1)}m`,
		`  recorded lifetime: ${control.lifetimeUsage.attempts} attempts, ${control.lifetimeUsage.tokens} tokens, ${lifetimeCost}, ${control.lifetimeUsage.wallTimeMinutes.toFixed(1)}m`,
		`  last outcome: ${control.lastOutcome}`,
		`  verification: ${verification.mode}/${verification.status}`,
	].join("\n");
}

async function taskStats(options: HandleTasksCommandOptions, idInput?: string): Promise<string> {
	if (idInput) {
		const id = normalizeTaskId(idInput);
		const task = await readStoredTask(options.channelDir, id, true, true);
		if (!task) return `Task not found: ${id}`;
		const entry: TaskLedgerEntry = {
			id,
			title: extractTaskTitle(task.body, id),
			frontmatter: {
				readable: true,
				status: task.fields.status,
				wake: task.fields.wake,
				recurrence: task.fields.recurrence,
				control: task.fields.control,
			},
			actionable: false,
		};
		return `# Task Stats\n\n${renderUsageLine(entry)}`;
	}
	const entries = await readActiveTasks(tasksDir(options.channelDir));
	const governed = entries.filter((entry) => entry.frontmatter.control);
	const totals = governed.reduce(
		(total, entry) => {
			const usage = entry.frontmatter.control!.usage;
			const lifetime = entry.frontmatter.control!.lifetimeUsage;
			total.attempts += usage.attempts;
			total.tokens += usage.tokens;
			total.costUsd += usage.costUsd;
			total.costKnown &&= usage.costKnown;
			total.wallTimeMinutes += usage.wallTimeMinutes;
			total.lifetimeAttempts += lifetime.attempts;
			total.lifetimeTokens += lifetime.tokens;
			total.lifetimeCostUsd += lifetime.costUsd;
			total.lifetimeCostKnown &&= lifetime.costKnown;
			total.lifetimeWallTimeMinutes += lifetime.wallTimeMinutes;
			return total;
		},
		{
			attempts: 0,
			tokens: 0,
			costUsd: 0,
			costKnown: true,
			wallTimeMinutes: 0,
			lifetimeAttempts: 0,
			lifetimeTokens: 0,
			lifetimeCostUsd: 0,
			lifetimeCostKnown: true,
			lifetimeWallTimeMinutes: 0,
		},
	);
	const verified = governed.filter((entry) => entry.frontmatter.control?.verification.status === "passed").length;
	const stalled = governed.filter((entry) => entry.frontmatter.control?.lastOutcome === "failed").length;
	return [
		"# Task Stats",
		"",
		`governed tasks: ${governed.length}/${entries.length}`,
		`this cycle: ${totals.attempts} attempts, ${totals.tokens} tokens, ${totals.costKnown ? `$${totals.costUsd.toFixed(4)}` : "cost unavailable"}, ${totals.wallTimeMinutes.toFixed(1)}m`,
		`recorded lifetime: ${totals.lifetimeAttempts} attempts, ${totals.lifetimeTokens} tokens, ${totals.lifetimeCostKnown ? `$${totals.lifetimeCostUsd.toFixed(4)}` : "cost unavailable"}, ${totals.lifetimeWallTimeMinutes.toFixed(1)}m`,
		`verification PASS: ${verified}`,
		`last-run failures: ${stalled}`,
		"",
		...governed.map(renderUsageLine),
	].join("\n");
}

async function showTask(channelDir: string, id: string): Promise<string> {
	const dir = tasksDir(channelDir);
	const taskId = normalizeTaskId(id);
	const activePath = resolveTaskPath(dir, taskId);
	const archivePath = resolveTaskPath(dir, taskId, "archive");

	const path = existsSync(activePath) ? activePath : existsSync(archivePath) ? archivePath : undefined;
	if (!path) {
		return `Task not found: ${taskId}`;
	}
	const location = path === archivePath ? " (archived)" : "";
	const content = await readFile(path, "utf-8");
	return `# Task: ${taskId}${location}\n\n\`\`\`markdown\n${content}\n\`\`\``;
}

async function listArchive(channelDir: string): Promise<string> {
	const dir = join(tasksDir(channelDir), "archive");
	if (!existsSync(dir)) {
		return "# Archived Tasks\n\nNo archived tasks.";
	}
	const filenames = (await readdir(dir)).filter((filename) => filename.endsWith(".md")).sort();
	if (filenames.length === 0) {
		return "# Archived Tasks\n\nNo archived tasks.";
	}
	const blocks: string[] = [];
	for (const filename of filenames) {
		const id = filename.slice(0, -".md".length);
		try {
			const content = await readFile(join(dir, filename), "utf-8");
			blocks.push(`- ${id} — ${extractTaskTitle(content, id)}`);
		} catch {
			blocks.push(`- ${id}`);
		}
	}
	return `# Archived Tasks: ${blocks.length}\n\n${blocks.join("\n")}`;
}

async function doctor(options: HandleTasksCommandOptions): Promise<string> {
	if (!options.workspaceDir || !options.channelId) {
		return "# Task Doctor\n\nNot available: workspaceDir and channelId are required.";
	}

	const now = Date.now();
	const entries = await readActiveTasks(tasksDir(options.channelDir), now);
	const activeIds = new Set(entries.map((entry) => entry.id));
	const archivedIds = await readArchivedTaskIds(options.channelDir);
	const events = await readTaskEvents(options.workspaceDir, options.channelId);
	const issues: string[] = [];

	for (const entry of entries) {
		const status = entry.frontmatter.status ?? "active";
		if (!entry.frontmatter.readable) {
			issues.push(
				issue(
					`tasks/${entry.id}.md has unreadable frontmatter; wake/status cannot be trusted.`,
					`Fix tasks/${entry.id}.md so it starts with readable status/wake/recurrence frontmatter.`,
				),
			);
			continue;
		}
		if (entry.frontmatter.controlReadable === false) {
			issues.push(
				issue(
					`tasks/${entry.id}.md has invalid control metadata; governance is fail-open but cannot be enforced.`,
					`Use task_manage set or repair the one-line control JSON before allowing the task to run.`,
				),
			);
			continue;
		}

		const control = entry.frontmatter.control;
		if (control) {
			const storedTask = await readStoredTask(options.channelDir, entry.id);
			const violation = taskBudgetViolation(control, now);
			if (violation) {
				issues.push(
					issue(
						`tasks/${entry.id}.md exceeds its control limit: ${violation}.`,
						`Review the task, then explicitly raise its budget/deadline or cancel it; the driver will escalate it.`,
					),
				);
			}
			for (const relatedId of [control.parent, ...control.dependsOn].filter((value): value is string =>
				Boolean(value),
			)) {
				if (!activeIds.has(relatedId) && !archivedIds.has(relatedId)) {
					issues.push(
						issue(
							`tasks/${entry.id}.md points to missing related task ${relatedId}.`,
							`Create ${relatedId}, or remove it from parent/dependsOn with task_manage set.`,
						),
					);
				}
			}
			if (control.sideEffects === "external" && control.externalApproval === "required") {
				issues.push(
					issue(
						`tasks/${entry.id}.md requires external side effects but has no user approval.`,
						`After reviewing the proposed action, a user must run /tasks approve ${entry.id}.`,
					),
				);
			}
			if (
				control.externalApproval === "granted" &&
				storedTask &&
				control.approvalBodyHash !== taskBodyHash(storedTask.body)
			) {
				issues.push(
					issue(
						`tasks/${entry.id}.md changed after external-action approval was granted.`,
						`Review the current action and run /tasks approve ${entry.id} again.`,
					),
				);
			}
			if (control.worktree && !existsSync(control.worktree.path)) {
				issues.push(
					issue(
						`tasks/${entry.id}.md records a missing worktree path: ${control.worktree.path}.`,
						`Clear the stale worktree metadata or create/reassign an isolated worktree.`,
					),
				);
			}
			if (status !== "done" && control.verification.status === "passed" && control.verification.bodyHash) {
				if (storedTask && taskBodyHash(storedTask.body) !== control.verification.bodyHash) {
					issues.push(
						issue(
							`tasks/${entry.id}.md changed after its recorded independent PASS.`,
							`Run a fresh purpose=verify sub-agent and import its attestation before completion.`,
						),
					);
				} else if (control.verification.mode === "independent") {
					const attestationOk = control.verification.runId
						? await readVerificationAttestation(options.channelDir, control.verification.runId)
								.then((attestation) => attestation.taskId === entry.id && attestation.verdict === "pass")
								.catch(() => false)
						: false;
					if (!attestationOk) {
						issues.push(
							issue(
								`tasks/${entry.id}.md records an independent PASS with no matching verifier attestation on disk.`,
								`Run a fresh purpose=verify sub-agent and import its attestation with task_manage verify before completion.`,
							),
						);
					}
				}
			}
		}

		const recurring = Boolean(entry.frontmatter.schedule);
		if (status === "done" && !recurring) {
			issues.push(
				issue(
					`tasks/${entry.id}.md is done but still in the active directory.`,
					`Archive one-shot task ${entry.id}, or add a schedule cron with task_manage set if it is recurring.`,
				),
			);
		}

		const content = await readActiveTaskContent(options.channelDir, entry.id);
		if (content === undefined) {
			issues.push(
				issue(
					`tasks/${entry.id}.md could not be read during doctor checks.`,
					`Open tasks/${entry.id}.md manually and repair permissions or file contents.`,
				),
			);
		} else {
			const missing = missingStandardTaskSections(content);
			if (missing.length > 0) {
				issues.push(
					issue(
						`tasks/${entry.id}.md is missing standard section(s): ${missing.join(", ")}.`,
						`Ask the agent to normalize tasks/${entry.id}.md to the standard task skeleton.`,
					),
				);
			}
		}

		if (entry.frontmatter.wake && validWakeMs(entry) === undefined) {
			issues.push(
				issue(
					`tasks/${entry.id}.md has an invalid wake value (${entry.frontmatter.wake}); the native driver will treat it as due.`,
					`Use task_manage set or progress to replace wake with ISO8601, or clear it if the task should continue now.`,
				),
			);
		}
	}

	const parentGraph = new Map<string, string[]>();
	const dependencyGraph = new Map<string, string[]>();
	for (const entry of entries) {
		const control = entry.frontmatter.control;
		if (!control) continue;
		parentGraph.set(entry.id, control.parent ? [control.parent] : []);
		dependencyGraph.set(entry.id, control.dependsOn);
	}
	for (const cycle of relationCycles(parentGraph)) {
		issues.push(
			issue(
				`Task parent cycle detected: ${cycle.join(" → ")}.`,
				`Use task_manage set to clear or correct one parent link in this cycle.`,
			),
		);
	}
	for (const cycle of relationCycles(dependencyGraph)) {
		issues.push(
			issue(
				`Task dependency cycle detected: ${cycle.join(" → ")}.`,
				`Use task_manage set to remove one dependsOn edge before the driver can continue these tasks.`,
			),
		);
	}

	for (const event of events) {
		if (!event.id || !event.use) {
			issues.push(
				issue(
					`events/${event.filename} does not follow task.<channelId>.<taskId>.<use>.json.`,
					"Rename the event to the task-owned naming convention or manage it as a normal event.",
				),
			);
			continue;
		}
		if (event.error) {
			issues.push(
				issue(
					`events/${event.filename} is not parseable: ${event.error}`,
					`Fix or delete events/${event.filename}; invalid task-owned events cannot be trusted.`,
				),
			);
			continue;
		}
		if (!activeIds.has(event.id) && !archivedIds.has(event.id)) {
			issues.push(
				issue(
					`events/${event.filename} points to missing task ${event.id}.`,
					`Delete events/${event.filename}, or recreate tasks/${event.id}.md if that task still exists conceptually.`,
				),
			);
			continue;
		}
		if (archivedIds.has(event.id)) {
			issues.push(
				issue(
					`events/${event.filename} points to archived task ${event.id}; closed tasks should have no live events.`,
					`Delete events/${event.filename}; archived tasks should not wake the agent.`,
				),
			);
		}
	}

	if (issues.length === 0) {
		return "# Task Doctor\n\nNo task ledger issues found.";
	}
	return `# Task Doctor\n\nFound ${issues.length} issue${issues.length === 1 ? "" : "s"}:\n\n${issues.join("\n")}`;
}

export async function handleTasksCommand(options: HandleTasksCommandOptions): Promise<string> {
	let command: TasksCommand;
	try {
		command = parseTasksCommand(options.args);
	} catch (error) {
		const message = errorMessage(error);
		return `${message}\n\n${usage()}`;
	}

	try {
		switch (command.action) {
			case "list":
				return await listTasks(options.channelDir);
			case "show":
				return await showTask(options.channelDir, command.id);
			case "archive":
				return await listArchive(options.channelDir);
			case "approve":
				return await approveTask(options, command.id);
			case "pause":
				return await pauseTask(options, command.id);
			case "resume":
				return await resumeTask(options, command.id);
			case "run":
				return await runTask(options, command.id);
			case "stats":
				return await taskStats(options, command.id);
			case "doctor":
				return await doctor(options);
		}
	} catch (error) {
		const message = errorMessage(error);
		return `Could not ${command.action} tasks: ${message}`;
	}
}
