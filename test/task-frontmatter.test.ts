import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderTaskDocument } from "../src/tasks/contract.js";
import {
	normalizeTaskFrontmatter,
	parseTaskFrontmatter,
	renderTaskFrontmatter,
	type TaskFrontmatter,
} from "../src/tasks/frontmatter.js";
import { resetTaskLogAppenders } from "../src/tasks/loop-log.js";
import { readStoredTask, writeStoredTask } from "../src/tasks/store.js";
import { useTempDirs } from "./helpers/fixtures.js";

const tempDir = useTempDirs("task-frontmatter-");

afterEach(async () => {
	await resetTaskLogAppenders();
});

describe("task frontmatter contract (spec 064, D2)", () => {
	it("round-trips every field without loss", () => {
		const fields: TaskFrontmatter = {
			state: "waiting",
			waiting: { kind: "user", question: "merge?", since: "2026-09-05T10:00:00+08:00" },
			// A real group id is base64: `/`, `+` and `=` must survive as plain text (spec 058, D13).
			channel: "dingtalk:group:cidL1/dcU8u+SV7I9YuUXLeXg==",
			origin: "weekly-report",
			usage: { startedAt: "2026-09-05T09:00:00+08:00", steps: 3, usd: 1.5, usdEstimated: true },
			budget: { steps: 10, usd: 5 },
		};
		const rendered = renderTaskFrontmatter(fields);
		expect(parseTaskFrontmatter(`${rendered}\n# T\n`).fields).toEqual(fields);
	});

	// INV-3: the pairs cannot be written wrong, so nothing has to diagnose them afterwards.
	it("keeps `waiting` / `paused` in lockstep with their state in both directions", () => {
		const waiting = { kind: "work" as const, since: "2026-09-05T10:00:00+08:00" };
		const paused = { by: "user" as const, reason: "hold", at: "2026-09-05T10:00:00+08:00" };
		expect(normalizeTaskFrontmatter({ state: "waiting" }).state).toBe("queued");
		expect(normalizeTaskFrontmatter({ state: "paused" }).state).toBe("queued");
		expect(normalizeTaskFrontmatter({ state: "running", waiting, paused })).toMatchObject({
			waiting: undefined,
			paused: undefined,
		});
		expect(normalizeTaskFrontmatter({ state: "paused", paused })).toMatchObject({ state: "paused", paused });
	});

	it("drops live fields from an archived document, keeping its report channel", () => {
		const fields = normalizeTaskFrontmatter({
			state: "waiting",
			waiting: { kind: "work", since: "2026-09-05T10:00:00+08:00" },
			outcome: "completed",
		});
		expect(fields).toMatchObject({ waiting: undefined, paused: undefined });
		const archived = renderTaskFrontmatter({ state: "queued", outcome: "cancelled", channel: "dingtalk:dm:1" });
		expect(archived).not.toContain("state:");
		expect(parseTaskFrontmatter(`${archived}\n# T\n`).fields.channel).toBe("dingtalk:dm:1");
	});

	it("fails open to a listed but unreadable task when the block is missing or in a retired shape", () => {
		for (const content of [
			"# no frontmatter\n",
			"---\nnot: closed\n",
			"---\nstate: parked\nticket: {}\n---\n# T\n",
		]) {
			const parsed = parseTaskFrontmatter(content);
			expect(parsed.readable, content).toBe(false);
			expect(parsed.fields.state, content).toBe("queued");
		}
	});
});

describe("the runtime never rewrites the body (INV-6)", () => {
	it("writes an over-long contract as authored, and keeps every section", async () => {
		const dir = tempDir();
		await mkdir(join(dir, "tasks"), { recursive: true });
		const path = join(dir, "tasks", "verbose.md");
		const body = `# Verbose\n\n## Goal\n${"g".repeat(6_000)}\n\n## DoD\n- [ ] done\n\n## Work Items\n- [ ] W1 thing\n`;
		await writeFile(path, renderTaskDocument({ state: "queued" }, body));

		const document = await readStoredTask(dir, "verbose");
		document!.fields.usage = {
			startedAt: "2026-09-05T09:00:00+08:00",
			steps: 1,
			usd: 0,
			usdEstimated: false,
		};
		await writeStoredTask(document!);

		const written = await readFile(path, "utf-8");
		expect(written.slice(written.indexOf("# Verbose"))).toBe(body);
	});
});
