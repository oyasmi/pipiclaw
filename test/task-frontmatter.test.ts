import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	normalizeTaskFrontmatter,
	parseTaskFrontmatterV4,
	renderTaskFrontmatter,
	type TaskFrontmatterV4,
} from "../src/tasks/frontmatter.js";
import { renderTaskDocument } from "../src/tasks/ledger.js";
import { resetTaskLogAppenders } from "../src/tasks/log.js";
import { MAX_CONTRACT_BYTES, readStoredTask, writeStoredTask } from "../src/tasks/store.js";
import type { Ticket } from "../src/tasks/ticket.js";

const TICKET: Ticket = { kind: "ask", asked: "merge?", by: "2099-01-01T00:00:00+08:00" };

afterEach(async () => {
	await resetTaskLogAppenders();
});

describe("v4 frontmatter contract (spec 051, §12.2)", () => {
	it("round-trips every field in a stable order", () => {
		const fields: TaskFrontmatterV4 = {
			state: "parked",
			paused: { by: "runtime", reason: "budget", at: "2026-09-05T10:00:00+08:00" },
			schedule: "0 3 * * *",
			ticket: TICKET,
			cycle: {
				id: "c-2026-09-05",
				startedAt: "2026-09-05T09:00:00+08:00",
				steps: 3,
				rounds: 1,
				usd: 1.5,
				usdEstimated: true,
				expired: 0,
			},
			budget: { steps: 10 },
			verify: "required",
		};
		const rendered = renderTaskFrontmatter(fields);
		expect(
			rendered
				.split("\n")
				.slice(1, -1)
				.map((line) => line.split(":")[0]),
		).toEqual(["state", "paused", "schedule", "ticket", "cycle", "budget", "verify"]);
		expect(parseTaskFrontmatterV4(`${rendered}\n# T\n`).fields).toEqual(fields);
	});

	// INV-1. v3 needed `/tasks doctor` to find `enabled:false` disagreeing with `control.stop`, or
	// `active` carrying a future wake. v4 makes the pair unrepresentable instead of diagnosable.
	// Mutation check (2026-09-05): drop the two lockstep lines in `normalizeTaskFrontmatter` → red.
	it("keeps `parked` and `ticket` in lockstep in both directions", () => {
		expect(normalizeTaskFrontmatter({ state: "parked" }).state).toBe("open");
		expect(normalizeTaskFrontmatter({ state: "open", ticket: TICKET }).ticket).toBeUndefined();
		const parsed = parseTaskFrontmatterV4(`${renderTaskFrontmatter({ state: "parked", ticket: TICKET })}\n# T\n`);
		expect(parsed.fields.state).toBe("parked");
		expect(parsed.fields.ticket).toEqual(TICKET);
	});

	it("drops a park that survives into an archived document", () => {
		const fields = normalizeTaskFrontmatter({ state: "parked", ticket: TICKET, outcome: "completed" });
		expect(fields).toMatchObject({ state: "done", ticket: undefined, paused: undefined });
	});

	it("reads a v3 file as legacy rather than as an unreadable one", () => {
		const v3 = '---\nstatus: waiting\nenabled: true\ncontrol: {"version":3}\n---\n# T\n';
		const parsed = parseTaskFrontmatterV4(v3);
		expect(parsed).toMatchObject({ legacy: true, readable: true });
		// Fail-open: the migrator has not run yet, so the task must still be visible as live work.
		expect(parsed.fields.state).toBe("open");
	});

	it("fails open to a live task when the block is missing or corrupt", () => {
		for (const content of ["# no frontmatter\n", "---\nnot: closed\n"]) {
			const parsed = parseTaskFrontmatterV4(content);
			expect(parsed.readable, content).toBe(false);
			expect(parsed.fields.state, content).toBe("open");
		}
	});

	it("ignores a ticket whose backstop is unreadable instead of trusting it", () => {
		const parsed = parseTaskFrontmatterV4('---\nstate: parked\nticket: {"kind":"ask","asked":"x"}\n---\n# T\n');
		expect(parsed.fields.ticket).toBeUndefined();
		expect(parsed.fields.state).toBe("open");
	});
});

describe("contract size budget (INV-6)", () => {
	it("truncates a body that would push the file past 4 KB and leaves a pointer", async () => {
		const dir = await mkdtemp(join(tmpdir(), "task-frontmatter-"));
		const { mkdir } = await import("node:fs/promises");
		await mkdir(join(dir, "tasks"), { recursive: true });
		const path = join(dir, "tasks", "big.md");
		await writeFile(path, renderTaskDocument({ state: "open" }, "# Big\n"));

		const document = await readStoredTask(dir, "big");
		expect(document).toBeDefined();
		document!.body = `# Big\n\n## Goal\n${"x".repeat(20_000)}\n`;
		await writeStoredTask(document!);

		const written = await readFile(path, "utf-8");
		expect(Buffer.byteLength(written, "utf-8")).toBeLessThanOrEqual(MAX_CONTRACT_BYTES);
		expect(written).toContain("task_log");
	});
});
