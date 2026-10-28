import { Type } from "typebox";

const idField = Type.String({ description: "Task id (filename without .md)." });

const budgetField = Type.Optional(
	Type.Object(
		{
			steps: Type.Optional(Type.Integer({ minimum: 1, description: "Max model steps for the whole task." })),
			usd: Type.Optional(
				Type.Number({ description: "Max attributable cost for the whole task, including bound delegations." }),
			),
		},
		{ description: "Per-task budget; omitted keys fall back to the runtime defaults." },
	),
);

export const taskListSchema = Type.Object({});

export const taskCreateSchema = Type.Object({
	id: idField,
	title: Type.String({ description: "Task title (H1 heading)." }),
	goal: Type.String({ description: "The result, its scope, the external actions allowed, key constraints." }),
	dod: Type.String({
		description: 'Checklist items, e.g. "- [ ] <criterion>"; plain prose is rejected.',
	}),
	items: Type.Optional(
		Type.Array(
			Type.Object({ text: Type.String({ description: "One independently deliverable, checkable piece." }) }),
			{
				description: "Initial Work Items, numbered W1…Wn in order.",
			},
		),
	),
	budget: budgetField,
});

export const taskCloseSchema = Type.Object({
	id: idField,
	outcome: Type.Union([Type.Literal("complete"), Type.Literal("cancel")], {
		description: "complete (DoD all checked, nothing in flight) or cancel (abandon).",
	}),
	note: Type.String({
		description: "complete: what was achieved and the evidence. cancel: why it was abandoned.",
	}),
});

export const taskLogSchema = Type.Object({
	id: idField,
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Most recent N records; default 20." })),
});

export const taskMessageSchema = Type.Object({
	id: idField,
	text: Type.String({ description: "What the user said to the task, passed on verbatim." }),
});

export const taskPauseSchema = Type.Object({
	id: idField,
	reason: Type.String({ description: "Why the task is being paused, in the user's terms." }),
});

export const taskResumeSchema = Type.Object({
	id: idField,
	steps: Type.Optional(Type.Integer({ minimum: 1, description: "Extra steps on top of those already used." })),
	usd: Type.Optional(
		Type.Number({ exclusiveMinimum: 0, description: "Extra budget on top of the cost already spent." }),
	),
});

export const taskReportSchema = Type.Object({
	text: Type.String({ description: "The message to send the user now: a deliverable, important progress, a risk." }),
});

export const taskAskSchema = Type.Object({
	question: Type.String({
		minLength: 1,
		maxLength: 500,
		description: "A specific question the user can answer directly; include your recommended option.",
	}),
});

export const taskWaitSchema = Type.Object({
	until: Type.String({
		description: 'When to continue: "+30m", "+2h", "+1d" or a local timestamp. Between 1 minute and 30 days ahead.',
	}),
});
