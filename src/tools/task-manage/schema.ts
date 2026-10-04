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

/** Update or append Work Items by id. `id` is always required: a new id appends an item (then `text` too). */
const itemsPatchField = Type.Optional(
	Type.Array(
		Type.Object({
			id: Type.String({ description: 'Work item id, e.g. "W2"; an unseen id appends a new item.' }),
			status: Type.Optional(
				Type.Union([Type.Literal("todo"), Type.Literal("done"), Type.Literal("blocked"), Type.Literal("dropped")], {
					description: "New status for this item. Only you mark an item done — after checking its result.",
				}),
			),
			text: Type.Optional(Type.String({ description: "Item text; required when appending a new id." })),
		}),
		{ description: "Update or append Work Items by id." },
	),
);

/**
 * The waiting ticket a park must carry (spec 051, D2; spec 052, D3). Every field the runtime
 * cannot derive is here and nothing else: `by` is stamped by the runtime, never by the model,
 * because a backstop the model can choose is a backstop it can choose not to have, and a `work`
 * ticket needs no id — it waits for whatever this task has in flight.
 */
const ticketField = Type.Object(
	{
		kind: Type.Union([Type.Literal("time"), Type.Literal("work"), Type.Literal("ask")], {
			description:
				"time = wait for a moment; work = wait for this task's in-flight delegations/jobs (the first to settle wakes you); ask = wait for the user.",
		}),
		at: Type.Optional(Type.String({ description: 'kind=time: when, e.g. "+2h" or a local timestamp.' })),
		asked: Type.Optional(Type.String({ description: "kind=ask: the question the user must answer." })),
	},
	{ description: "Ticket describing what will resume this task." },
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

export const taskUpdateSchema = Type.Object({
	id: idField,
	items: itemsPatchField,
	budget: budgetField,
});

export const taskCloseSchema = Type.Object({
	id: idField,
	outcome: Type.Union([Type.Literal("complete"), Type.Literal("cancel")], {
		description: "complete (DoD all checked) or cancel (abandon).",
	}),
	note: Type.String({
		description: "complete: what was achieved and the evidence. cancel: why it was abandoned.",
	}),
});

export const taskLogSchema = Type.Object({
	id: idField,
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Most recent N records; default 20." })),
});

export const taskStepEndSchema = Type.Object({
	outcome: Type.Union([Type.Literal("continue"), Type.Literal("park"), Type.Literal("done")], {
		description: "continue = more work now; park = wait on a ticket; done = the project is finished.",
	}),
	note: Type.String({
		description:
			"What this step did, the evidence, and the next step. Goes to the loop log; for done, what was achieved and the proof.",
	}),
	items: itemsPatchField,
	ticket: Type.Optional(ticketField),
	report: Type.Optional(
		Type.String({ description: "Message to send the user (results, delivery, a question). Omit to stay silent." }),
	),
});
