// Uses the same deterministic units as the runtime; these are not billed model tokens.
import { readdirSync, readFileSync } from "node:fs";
import { countPromptUnits } from "../src/shared/prompt-units.ts";

const directory = new URL("../src/playbooks/", import.meta.url);
const rows = readdirSync(directory)
	.filter((file) => file.endsWith(".md"))
	.sort()
	.map((file) => {
		const text = readFileSync(new URL(file, directory), "utf-8");
		return { file, units: countPromptUnits(text), bytes: Buffer.byteLength(text) };
	});
console.table(rows);
console.log(`all guides: ${rows.reduce((sum, row) => sum + row.units, 0)} units`);
for (const [label, files] of [
	["chat task management", ["task-manage.md"]],
	["task lead", ["task-lead.md"]],
	["task + delegation", ["task-lead.md", "agent-delegation.md"]],
	["task + verify + delegation", ["task-lead.md", "task-verify.md", "agent-delegation.md"]],
	["routine event reminder", []],
	["event scheduling", ["event-scheduling.md"]],
	["event task template", ["event-task-template.md"]],
	["event sensor", ["event-sensors.md"]],
	["inline delegation", ["delegation-inline.md"]],
	["delegation recovery", ["agent-delegation.md", "delegation-recovery.md"]],
	["orientation + file map", ["runtime-orientation.md", "runtime-files.md"]],
	["memory + skill authoring", ["memory-and-learning.md", "memory-learning.md"]],
]) {
	const subset = files.map((file) => {
		const row = rows.find((entry) => entry.file === file);
		if (!row) throw new Error(`Missing playbook in measurement path: ${file}`);
		return row;
	});
	console.log(`${label}: ${subset.reduce((sum, row) => sum + row.units, 0)} units`);
}
