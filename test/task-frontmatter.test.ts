import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	normalizeTaskFrontmatter,
	parseTaskFrontmatter,
	renderTaskFrontmatter,
	type TaskFrontmatter,
} from "../src/tasks/frontmatter.js";
import { renderTaskDocument } from "../src/tasks/ledger.js";
import { resetTaskLogAppenders } from "../src/tasks/log.js";
import { readStoredTask, writeStoredTask } from "../src/tasks/store.js";
import type { Ticket } from "../src/tasks/ticket.js";

const TICKET: Ticket = { kind: "ask", asked: "merge?", by: "2099-01-01T00:00:00+08:00" };

afterEach(async () => {
	await resetTaskLogAppenders();
});

describe("task frontmatter contract (spec 052, §3.3)", () => {
	it("round-trips every field in a stable order", () => {
		const fields: TaskFrontmatter = {
			state: "parked",
			paused: { by: "runtime", reason: "budget", at: "2026-09-05T10:00:00+08:00" },
			origin: "weekly-report",
			ticket: { kind: "work", refs: ["run_a", "job_b"], by: "2099-01-01T00:00:00+08:00" },
			usage: { startedAt: "2026-09-05T09:00:00+08:00", steps: 3, usd: 1.5, usdEstimated: true, expired: 1 },
			budget: { steps: 10, usd: 5 },
		};
		const rendered = renderTaskFrontmatter(fields);
		expect(
			rendered
				.split("\n")
				.slice(1, -1)
				.map((line) => line.split(":")[0]),
		).toEqual(["state", "paused", "origin", "ticket", "usage", "budget"]);
		expect(parseTaskFrontmatter(`${rendered}\n# T\n`).fields).toEqual(fields);
	});

	// INV-1: the pair cannot be written wrong, so nothing has to diagnose it afterwards.
	it("keeps `parked` and `ticket` in lockstep in both directions", () => {
		expect(normalizeTaskFrontmatter({ state: "parked" }).state).toBe("open");
		expect(normalizeTaskFrontmatter({ state: "open", ticket: TICKET }).ticket).toBeUndefined();
		const parsed = parseTaskFrontmatter(`${renderTaskFrontmatter({ state: "parked", ticket: TICKET })}\n# T\n`);
		expect(parsed.fields).toMatchObject({ state: "parked", ticket: TICKET });
	});

	it("drops a park that survives into an archived document", () => {
		const fields = normalizeTaskFrontmatter({ state: "parked", ticket: TICKET, outcome: "completed" });
		expect(fields).toMatchObject({ state: "done", ticket: undefined, paused: undefined });
	});

	it("reads a v4 file as legacy (not unreadable), and a park on a retired ticket falls back to open", () => {
		const v4 =
			'---\nstate: parked\nticket: {"kind":"run","id":"r","by":"2099-01-01T00:00:00+08:00"}\ncycle: {"id":"c-1"}\n---\n# T\n';
		const parsed = parseTaskFrontmatter(v4);
		expect(parsed).toMatchObject({ legacy: true, readable: true });
		expect(parsed.fields.state).toBe("open");
	});

	it("fails open to a live task when the block is missing or corrupt", () => {
		for (const content of ["# no frontmatter\n", "---\nnot: closed\n"]) {
			const parsed = parseTaskFrontmatter(content);
			expect(parsed.readable, content).toBe(false);
			expect(parsed.fields.state, content).toBe("open");
		}
	});

	it("ignores a ticket whose backstop is unreadable instead of trusting it", () => {
		const parsed = parseTaskFrontmatter('---\nstate: parked\nticket: {"kind":"ask","asked":"x"}\n---\n# T\n');
		expect(parsed.fields.ticket).toBeUndefined();
		expect(parsed.fields.state).toBe("open");
	});
});

describe("the runtime never rewrites the body (INV-6)", () => {
	it("writes an over-long contract as authored, and keeps every section", async () => {
		const dir = await mkdtemp(join(tmpdir(), "task-frontmatter-"));
		await mkdir(join(dir, "tasks"), { recursive: true });
		const path = join(dir, "tasks", "verbose.md");
		const body = `# Verbose\n\n## Goal\n${"g".repeat(6_000)}\n\n## DoD\n- [ ] done\n\n## Work Items\n- [ ] W1 thing\n`;
		await writeFile(path, renderTaskDocument({ state: "open" }, body));

		const document = await readStoredTask(dir, "verbose");
		document!.fields.usage = {
			startedAt: "2026-09-05T09:00:00+08:00",
			steps: 1,
			usd: 0,
			usdEstimated: false,
			expired: 0,
		};
		await writeStoredTask(document!);

		const written = await readFile(path, "utf-8");
		for (const heading of ["## Goal", "## DoD", "## Work Items"]) expect(written, heading).toContain(heading);
		expect(written).toContain("g".repeat(6_000));
	});
});
