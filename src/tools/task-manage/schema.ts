import { Type } from "typebox";
import { SETTABLE_TASK_STATUSES } from "../../tasks/transitions.js";

export const SETTABLE_STATUSES = SETTABLE_TASK_STATUSES;

const idField = Type.String({ description: "Task id (filename without .md)." });

const planStepsField = Type.Optional(
	Type.Array(
		Type.Object({
			id: Type.String({ description: 'Plan step id, e.g. "P2"; new ids append a step.' }),
			status: Type.Optional(
				Type.Union([Type.Literal("todo"), Type.Literal("done"), Type.Literal("blocked"), Type.Literal("dropped")], {
					description: "New status for this step.",
				}),
			),
			text: Type.Optional(Type.String({ description: "Step text; required when appending a new id." })),
		}),
		{ description: "Update or append Plan steps by id." },
	),
);

const wakeField = Type.Optional(
	Type.String({
		description:
			"Earliest-recheck time; empty string clears it. Local time e.g. 2026-07-27T07:30:00+08:00, or relative +2h/+45m/+3d.",
	}),
);

const scheduleField = Type.Optional(
	Type.String({
		description: "Five-field cron cadence; makes this recurring. Empty string clears it. Min every 30 minutes.",
	}),
);

export const taskListSchema = Type.Object({});

export const taskCreateSchema = Type.Object({
	id: idField,
	title: Type.String({ description: "Task title (H1 heading)." }),
	goal: Type.String({ description: "Concise task goal." }),
	dod: Type.String({
		description: 'Checklist items, e.g. "- [ ] <criterion>"; plain prose is rejected.',
	}),
	plan: Type.Optional(
		Type.String({
			description: 'Initial "## Plan" steps, one per line — the means, not the DoD.',
		}),
	),
	manual: Type.Optional(Type.String({ description: "Initial operating steps or checklist." })),
	verificationPlan: Type.Optional(Type.String({ description: "Deterministic checks the verifier must perform." })),
	verificationRequired: Type.Optional(
		Type.Boolean({ description: "Whether complete requires a verifier attestation. Default false." }),
	),
	status: Type.Optional(
		Type.Union(
			SETTABLE_STATUSES.map((status) => Type.Literal(status)),
			{ description: "Initial status; default active." },
		),
	),
	wake: wakeField,
	schedule: scheduleField,
	deadline: Type.Optional(Type.String({ description: "Local time deadline, e.g. 2026-07-27T18:00:00+08:00." })),
});

const taskControlSchema = Type.Object({
	deadline: Type.Optional(
		Type.String({
			description: "Local time deadline, e.g. 2026-07-27T18:00:00+08:00; empty string clears it.",
		}),
	),
	nextAction: Type.Optional(Type.String({ description: "Concrete next executable step; empty string clears it." })),
	waitingFor: Type.Optional(
		Type.Union([Type.Literal("time"), Type.Literal("user"), Type.Literal("job"), Type.Literal("external-signal")], {
			description: "Diagnostic recovery source; record-only.",
		}),
	),
	verificationRequired: Type.Optional(
		Type.Boolean({ description: "Whether complete requires a verifier attestation. Default false." }),
	),
});

export const taskUpdateSchema = Type.Object({
	id: idField,
	note: Type.Optional(
		Type.String({
			description: "Current Cycle checkpoint — what changed, evidence, next step.",
		}),
	),
	planSteps: planStepsField,
	status: Type.Optional(
		Type.Union(
			SETTABLE_STATUSES.map((status) => Type.Literal(status)),
			{ description: "New status; use task_close for lifecycle close-out." },
		),
	),
	wake: wakeField,
	schedule: scheduleField,
	control: Type.Optional(taskControlSchema),
});

export const taskCloseSchema = Type.Object({
	id: idField,
	outcome: Type.Union([Type.Literal("complete"), Type.Literal("skip"), Type.Literal("cancel")], {
		description: "complete / skip (recurring only) / cancel.",
	}),
	summary: Type.Optional(Type.String({ description: "Concise completion summary; required for outcome=complete." })),
	evidence: Type.Optional(
		Type.String({
			description: "Verification evidence, or a clear not-run reason. Required for outcome=complete.",
		}),
	),
	residualRisk: Type.Optional(Type.String({ description: "Remaining risk or follow-up note; optional." })),
	reason: Type.Optional(
		Type.String({ description: "Why this occurrence was skipped or the task abandoned; required for skip/cancel." }),
	),
});

export const taskVerifySchema = Type.Object({
	id: idField,
	verifierRunId: Type.String({ description: "Run id returned by a purpose=verify sub-agent." }),
});
