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
for (const [label, subset] of [
	["all guides", rows],
	["task + delegation", rows.filter((row) => ["task-loop.md", "agent-delegation.md"].includes(row.file))],
]) {
	console.log(`${label}: ${subset.reduce((sum, row) => sum + row.units, 0)} units`);
}
