import { Type } from "typebox";

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

const scheduleField = Type.Optional(
	Type.String({
		description: "Five-field cron cadence; makes this recurring. Empty string clears it. Min every 30 minutes.",
	}),
);

const budgetField = Type.Optional(
	Type.Object(
		{
			steps: Type.Optional(Type.Number({ description: "Max model steps in one cycle." })),
			wallMin: Type.Optional(
				Type.Number({ description: "Max elapsed minutes in one cycle, including parked waits." }),
			),
			usd: Type.Optional(Type.Number({ description: "Max attributable cost in one cycle." })),
			rounds: Type.Optional(Type.Number({ description: "Max delegate→verify rework rounds in one cycle." })),
			until: Type.Optional(Type.String({ description: "Hard local-time stop, e.g. 2026-09-06T18:00:00+08:00." })),
		},
		{ description: "Per-task budget; omitted keys fall back to the runtime defaults." },
	),
);

/**
 * The waiting ticket a park must carry (spec 051, D2). Every field the runtime cannot derive is
 * here and nothing else: `by` is stamped by the runtime, never by the model, because a backstop
 * the model can choose is a backstop it can choose not to have.
 */
const ticketField = Type.Object(
	{
		kind: Type.Union(
			[Type.Literal("time"), Type.Literal("run"), Type.Literal("job"), Type.Literal("ask"), Type.Literal("signal")],
			{ description: "What will wake this task." },
		),
		at: Type.Optional(Type.String({ description: 'kind=time: when, e.g. "+2h" or a local timestamp.' })),
		id: Type.Optional(Type.String({ description: "kind=run/job: the run or job id this task is waiting on." })),
		asked: Type.Optional(Type.String({ description: "kind=ask: the question the user must answer." })),
		event: Type.Optional(Type.String({ description: "kind=signal: the task-owned periodic event name." })),
	},
	{ description: "Ticket describing what will resume this task." },
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
		Type.Boolean({ description: "Whether done requires an independent verifier PASS. Default false." }),
	),
	schedule: scheduleField,
	budget: budgetField,
});

export const taskUpdateSchema = Type.Object({
	id: idField,
	planSteps: planStepsField,
	schedule: scheduleField,
	budget: budgetField,
	verificationRequired: Type.Optional(
		Type.Boolean({ description: "Whether done requires an independent verifier PASS." }),
	),
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

export const taskLogSchema = Type.Object({
	id: idField,
	cycle: Type.Optional(Type.String({ description: "Only this cycle's records, e.g. c-2026-09-05." })),
	limit: Type.Optional(Type.Number({ description: "Most recent N records; default 20." })),
});

export const taskStepEndSchema = Type.Object({
	outcome: Type.Union(
		[Type.Literal("continue"), Type.Literal("park"), Type.Literal("done"), Type.Literal("blocked")],
		{
			description:
				"continue = more work now; park = wait on a ticket; done = close the cycle; blocked = ask the user.",
		},
	),
	note: Type.String({ description: "What this step did, the evidence, and the next step. Goes to the loop log." }),
	planSteps: planStepsField,
	ticket: Type.Optional(ticketField),
	notify: Type.Optional(Type.String({ description: "Message to send the user. Omit to stay silent." })),
	summary: Type.Optional(Type.String({ description: "Required for outcome=done: what was achieved." })),
	evidence: Type.Optional(Type.String({ description: "Required for outcome=done: concrete proof." })),
	residualRisk: Type.Optional(Type.String({ description: "Remaining risk after outcome=done." })),
	reason: Type.Optional(Type.String({ description: "Required for outcome=blocked: what is blocking." })),
});
