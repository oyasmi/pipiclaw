import { Type } from "typebox";
import { SETTABLE_TASK_STATUSES } from "../../tasks/transitions.js";
import { RecoverableToolError } from "../tool-details.js";
import type { TaskManageAction } from "./types.js";

export const SETTABLE_STATUSES = SETTABLE_TASK_STATUSES;

const taskControlSchema = Type.Object({
	priority: Type.Optional(
		Type.Union([Type.Literal("low"), Type.Literal("normal"), Type.Literal("high"), Type.Literal("critical")]),
	),
	deadline: Type.Optional(Type.String({ description: "ISO8601 deadline; empty string clears it." })),
	nextAction: Type.Optional(Type.String({ description: "Concrete next executable step; empty string clears it." })),
	lastOutcome: Type.Optional(
		Type.Union([
			Type.Literal("pending"),
			Type.Literal("running"),
			Type.Literal("progress"),
			Type.Literal("blocked"),
			Type.Literal("failed"),
			Type.Literal("verified"),
		]),
	),
	blockedReason: Type.Optional(Type.String({ description: "Why work cannot currently proceed; empty clears it." })),
	parent: Type.Optional(Type.String({ description: "Parent task id; empty clears it." })),
	dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Task ids that must be done first." })),
	isolation: Type.Optional(Type.Union([Type.Literal("shared"), Type.Literal("worktree")])),
	sideEffects: Type.Optional(
		Type.Union([Type.Literal("read-only"), Type.Literal("workspace"), Type.Literal("external")]),
	),
	externalApproval: Type.Optional(
		Type.Union([Type.Literal("not-required"), Type.Literal("required")], {
			description: 'External approval can only be granted by a user with "/tasks approve <id>".',
		}),
	),
	maxAttempts: Type.Optional(Type.Integer({ minimum: 1 })),
	maxTokens: Type.Optional(Type.Number({ minimum: 0, description: "0 clears this budget." })),
	maxCostUsd: Type.Optional(Type.Number({ minimum: 0, description: "0 clears this budget." })),
	maxWallTimeMinutes: Type.Optional(Type.Number({ minimum: 0, description: "0 clears this budget." })),
	verificationMode: Type.Optional(
		Type.Union([Type.Literal("evidence"), Type.Literal("independent")], {
			description:
				'On create, defaults to "evidence" (maker self-checks the DoD against concrete evidence). Set "independent" only when the task produces a checkable artifact (code, config, a runnable command) that a separate read-only verifier sub-agent can inspect — for research/writing/reminder-style tasks, "evidence" is cheaper and just as trustworthy.',
		}),
	),
	worktreePath: Type.Optional(Type.String({ description: "Owned worktree path; empty clears it." })),
	worktreeBranch: Type.Optional(Type.String()),
});

export const taskManageSchema = Type.Object({
	label: Type.String({ description: "Brief description of the ledger change (shown to the user)" }),
	action: Type.Union(
		[
			Type.Literal("create"),
			Type.Literal("progress"),
			Type.Literal("set"),
			Type.Literal("verify"),
			Type.Literal("done"),
			Type.Literal("cancel"),
			Type.Literal("candidate"),
			Type.Literal("list"),
		],
		{
			description:
				'"create" writes a governed task; "progress" atomically checkpoints work; "candidate" requests independent verification; "set" repairs metadata; "verify" imports an independent verifier attestation; "done" closes verified work; "cancel" closes abandoned work; "list" returns tasks. Recurring cycles are reopened automatically by the runtime.',
		},
	),
	id: Type.Optional(
		Type.String({ description: "Task id (filename without .md). Required for create/progress/set/done." }),
	),
	title: Type.Optional(Type.String({ description: "Required for create: task title used as the H1 heading." })),
	goal: Type.Optional(Type.String({ description: "Required for create: concise task goal." })),
	dod: Type.Optional(
		Type.String({
			description:
				'Required for create: acceptance criteria as Markdown checklist items, one per line, e.g. "- [ ] <criterion>". Plain prose or a numbered list without checkboxes is rejected — candidate/done can only verify items that are checkable.',
		}),
	),
	manual: Type.Optional(Type.String({ description: "Optional for create: initial operating steps or checklist." })),
	verificationPlan: Type.Optional(
		Type.String({ description: "Optional for create: deterministic checks the verifier must perform." }),
	),
	control: Type.Optional(taskControlSchema),
	status: Type.Optional(
		Type.Union(
			SETTABLE_STATUSES.map((status) => Type.Literal(status)),
			{ description: "New status for create/progress/set. To close a task use action done, not status." },
		),
	),
	wake: Type.Optional(
		Type.String({
			description:
				"ISO8601 earliest-recheck time for create/progress/set; empty string clears it. The native task driver resumes it; no .checkin event is needed.",
		}),
	),
	schedule: Type.Optional(
		Type.String({
			description:
				"Five-field cron cadence (host timezone) that makes this a recurring task; empty string clears it. " +
				"On done, the driver sleeps the task until the next occurrence and reopens the next cycle automatically. Min every 30 minutes.",
		}),
	),
	recurrence: Type.Optional(
		Type.String({ description: "Human annotation only (e.g. 每周一); empty string clears it." }),
	),
	note: Type.Optional(
		Type.String({
			description:
				"Required for progress: concise Current Cycle entry covering what changed, evidence observed, and the next step.",
		}),
	),
	verifierRunId: Type.Optional(
		Type.String({ description: "Required for verify: run id returned by a purpose=verify sub-agent." }),
	),
	summary: Type.Optional(Type.String({ description: "Required for done: concise completion summary." })),
	evidence: Type.Optional(
		Type.String({
			description:
				"Required for done: verification evidence (tests, commands, review result, external confirmation, or a clear not-run reason).",
		}),
	),
	residualRisk: Type.Optional(Type.String({ description: "Optional for done: remaining risk or follow-up note." })),
	reason: Type.Optional(Type.String({ description: "Required for cancel: why the task was abandoned." })),
});

export function parseAction(action: string): TaskManageAction {
	if (
		action === "create" ||
		action === "progress" ||
		action === "candidate" ||
		action === "set" ||
		action === "verify" ||
		action === "done" ||
		action === "cancel" ||
		action === "list"
	) {
		return action;
	}
	throw new RecoverableToolError(
		"Unsupported task action. Use create, progress, candidate, set, verify, done, cancel, or list.",
	);
}
