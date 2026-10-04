import { RecoverableToolError } from "../shared/recoverable-error.js";
import { isPlainObject } from "../shared/type-guards.js";
import type { TaskBudget } from "./frontmatter.js";
import { renderStandardTaskBody, type TaskContractInput, uncheckedTaskAcceptanceItems } from "./ledger.js";

/**
 * Everything a task is created from. `task_create` takes exactly this plus an `id`, and an event
 * template (`task` in a scheduled event, spec 052, D2) is exactly this — one shape, one
 * validator, so a template that passes admission is a task that can be created. This module is
 * pure (no I/O) so the events subsystem can validate templates without touching the task store.
 */
export interface TaskCreateInput extends TaskContractInput {
	budget?: Partial<TaskBudget>;
}

function requiredText(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new RecoverableToolError(`task.${field} is required and must be a non-empty string.`);
	}
	return value.trim();
}

/** Validate a budget object; positive numbers only. Returns `undefined` when it carries nothing. */
export function normalizeTaskBudget(budget: unknown): Partial<TaskBudget> | undefined {
	if (budget === undefined || budget === null) return undefined;
	if (!isPlainObject(budget)) throw new RecoverableToolError("budget must be an object with steps and/or usd.");
	const next: Partial<TaskBudget> = {};
	for (const key of ["steps", "usd"] as const) {
		const value = budget[key];
		if (value === undefined) continue;
		if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
			throw new RecoverableToolError(`budget.${key} must be a positive number.`);
		}
		next[key] = value;
	}
	return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * Pure validation of one task contract (spec 052, D2/D10). Throws `RecoverableToolError` with a
 * message the model (or the person editing an event file) can act on; has no I/O, which is what
 * lets the events subsystem call it at admission time without depending on the task store.
 */
export function validateTaskContractInput(input: unknown): TaskCreateInput {
	if (!isPlainObject(input)) throw new RecoverableToolError("task must be an object with title, goal and dod.");
	const title = requiredText(input.title, "title");
	const goal = requiredText(input.goal, "goal");
	const dod = requiredText(input.dod, "dod");

	const rawItems = input.items;
	let items: Array<{ text: string }> | undefined;
	if (rawItems !== undefined) {
		if (!Array.isArray(rawItems)) throw new RecoverableToolError("task.items must be an array of { text }.");
		items = rawItems.map((entry, index) => {
			if (!isPlainObject(entry)) throw new RecoverableToolError(`task.items[${index}] must be an object with text.`);
			return { text: requiredText(entry.text, `items[${index}].text`) };
		});
	}

	const body = renderStandardTaskBody({ title, goal, dod, items });
	const badDod = uncheckedTaskAcceptanceItems(body).find((item) => item.startsWith("DoD has no checklist items"));
	if (badDod) throw new RecoverableToolError(badDod);

	return { title, goal, dod, items, budget: normalizeTaskBudget(input.budget) };
}
