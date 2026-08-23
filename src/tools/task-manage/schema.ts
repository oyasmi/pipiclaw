import { Type } from "typebox";
import { SETTABLE_TASK_STATUSES } from "../../tasks/transitions.js";
import { RecoverableToolError } from "../tool-details.js";
import type { TaskManageAction } from "./types.js";

export const SETTABLE_STATUSES = SETTABLE_TASK_STATUSES;

const taskControlSchema = Type.Object({
	priority: Type.Optional(
		Type.Union([Type.Literal("low"), Type.Literal("normal"), Type.Literal("high"), Type.Literal("critical")]),
	),
	deadline: Type.Optional(
		Type.String({
			description:
				"Local time deadline, e.g. 2026-07-27T18:00:00+08:00 (host timezone if no offset given); empty string clears it.",
		}),
	),
	nextAction: Type.Optional(Type.String({ description: "Concrete next executable step; empty string clears it." })),
	blockedReason: Type.Optional(Type.String({ description: "Why work cannot currently proceed; empty clears it." })),
	waitingFor: Type.Optional(
		Type.Union(
			[
				Type.Literal("time"),
				Type.Literal("user"),
				Type.Literal("job"),
				Type.Literal("verification"),
				Type.Literal("external-signal"),
			],
			{ description: "Diagnostic recovery source; it does not create a new lifecycle status." },
		),
	),
	maxAttempts: Type.Optional(
		Type.Integer({
			minimum: 1,
			description:
				"Attempt stop-loss; the only per-task budget. Default 12, spent over the whole task (recurring: per cycle) — raise it on create for long multi-step work.",
		}),
	),
	verificationRequired: Type.Optional(
		Type.Boolean({
			description:
				"Whether complete requires an independent verifier attestation. Default false; set true only when the task produces a checkable artifact (code, config, a runnable command) a read-only verifier sub-agent can inspect.",
		}),
	),
});

export const taskManageSchema = Type.Object({
	label: Type.String({ description: "Brief description of the ledger change (shown to the user)" }),
	action: Type.Union(
		[
			Type.Literal("create"),
			Type.Literal("progress"),
			Type.Literal("set"),
			Type.Literal("request-verification"),
			Type.Literal("verify"),
			Type.Literal("complete"),
			Type.Literal("skip"),
			Type.Literal("cancel"),
			Type.Literal("list"),
		],
		{
			description:
				'"create" writes a persistent task; "progress" checkpoints work; "request-verification" parks active work and schedules an independent checker; "set" repairs metadata; "verify" imports an attestation; "complete" closes a task; "skip" closes one recurring occurrence without claiming completion; "cancel" archives abandoned work; "list" returns tasks. Recurring tasks sleep between occurrences.',
		},
	),
	id: Type.Optional(
		Type.String({ description: "Task id (filename without .md). Required for create/progress/set/complete." }),
	),
	title: Type.Optional(Type.String({ description: "Required for create: task title used as the H1 heading." })),
	goal: Type.Optional(Type.String({ description: "Required for create: concise task goal." })),
	dod: Type.Optional(
		Type.String({
			description:
				'Required for create: acceptance criteria as Markdown checklist items, one per line, e.g. "- [ ] <criterion>". Plain prose or a numbered list without checkboxes is rejected — verification/complete can only verify items that are checkable.',
		}),
	),
	manual: Type.Optional(Type.String({ description: "Optional for create: initial operating steps or checklist." })),
	verificationPlan: Type.Optional(
		Type.String({ description: "Optional for create: deterministic checks the verifier must perform." }),
	),
	plan: Type.Optional(
		Type.String({
			description:
				'Optional for create: initial "## Plan" steps, one per line — the means, not the DoD. A step without a ' +
				'leading "P<n>" id gets one auto-assigned in order. Update step status/text later via progress\'s planSteps, not by editing this at create time.',
		}),
	),
	planSteps: Type.Optional(
		Type.Array(
			Type.Object({
				id: Type.String({
					description: 'Plan step id, e.g. "P2". An id not yet present is appended as a new step.',
				}),
				status: Type.Optional(
					Type.Union(
						[Type.Literal("todo"), Type.Literal("done"), Type.Literal("blocked"), Type.Literal("dropped")],
						{ description: "New status for this step; omit to leave it unchanged." },
					),
				),
				text: Type.Optional(
					Type.String({ description: "New step text; required when appending a step with an unseen id." }),
				),
			}),
			{
				description:
					"For progress: update or append Plan steps by id, e.g. mark P2 done, P3 blocked, and add a new P5. " +
					'Requires the task to already have a "## Plan" section, or this call is the one that creates it.',
			},
		),
	),
	control: Type.Optional(taskControlSchema),
	status: Type.Optional(
		Type.Union(
			SETTABLE_STATUSES.map((status) => Type.Literal(status)),
			{ description: "New status for create/progress/set. Use complete/skip/cancel for lifecycle close-out." },
		),
	),
	wake: Type.Optional(
		Type.String({
			description:
				"Earliest-recheck time for create/progress/set; empty string clears it. Local time, e.g. " +
				"2026-07-27T07:30:00+08:00 (host timezone if no offset given), or a relative offset from now " +
				"like +2h / +45m / +3d — never do the local-to-UTC conversion by hand. The native task driver " +
				"resumes it; no .checkin event is needed.",
		}),
	),
	schedule: Type.Optional(
		Type.String({
			description:
				"Five-field cron cadence (host timezone) that makes this a recurring task; empty string clears it. " +
				"Changing this on an existing task recomputes wake to the new cadence's next occurrence unless this " +
				"same call also sets wake explicitly. Recurring creation starts in sleeping and opens cycles at occurrences. Min every 30 minutes.",
		}),
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
	summary: Type.Optional(Type.String({ description: "Required for complete: concise completion summary." })),
	evidence: Type.Optional(
		Type.String({
			description:
				"Required for complete: verification evidence (tests, commands, review result, external confirmation, or a clear not-run reason).",
		}),
	),
	residualRisk: Type.Optional(
		Type.String({ description: "Optional for complete: remaining risk or follow-up note." }),
	),
	reason: Type.Optional(
		Type.String({ description: "Required for skip/cancel: why this occurrence was skipped or the task abandoned." }),
	),
});

export function parseAction(action: string): TaskManageAction {
	if (
		action === "create" ||
		action === "progress" ||
		action === "request-verification" ||
		action === "set" ||
		action === "verify" ||
		action === "complete" ||
		action === "skip" ||
		action === "cancel" ||
		action === "list"
	) {
		return action;
	}
	throw new RecoverableToolError(
		"Unsupported task action. Next step: use create, progress, request-verification, set, verify, complete, skip, cancel, or list.",
	);
}
