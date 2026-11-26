import { describe, expect, it } from "vitest";
import {
	buildJournalBlocksForBootstrap,
	buildMemoryIndexForBootstrap,
	clipJournalTailForBootstrap,
	clipWorkspaceMemoryForBootstrap,
} from "../src/memory/index-budget.js";
import type { MemoryEntry } from "../src/memory/store.js";
import { countPromptUnits } from "../src/shared/prompt-units.js";

function entry(name: string, type: MemoryEntry["type"], updated: string, confirmed?: string): MemoryEntry {
	return {
		name,
		description: `${name} ${"detail ".repeat(12)}`,
		body: "",
		type,
		source: "agent",
		created: "2026-01-01",
		updated,
		confirmed,
		malformed: false,
	};
}

describe("index-budget — memory index tiering", () => {
	it("keeps all user/feedback, drops oldest project/reference, adds an omitted line", () => {
		const entries = [
			entry("u1", "user", "2026-01-01"),
			entry("f1", "feedback", "2026-01-01"),
			...Array.from({ length: 40 }, (_, i) =>
				entry(`p${String(i).padStart(2, "0")}`, "project", `2026-${String((i % 12) + 1).padStart(2, "0")}-01`),
			),
		];
		const full = buildMemoryIndexForBootstrap(entries, 10_000);
		expect(full.overBudget).toBe(false);
		expect(full.omittedCount).toBe(0);
		expect(full.includedNames.slice().sort()).toEqual(entries.map((e) => e.name).sort());
		const result = buildMemoryIndexForBootstrap(entries, 300);
		expect(result.overBudget).toBe(true);
		expect(result.includedNames).toContain("u1");
		expect(result.includedNames).toContain("f1");
		expect(result.omittedCount).toBeGreaterThan(0);
		expect(result.text).toMatch(/\[- \d+ more entries omitted; use memory_search\]/);
		// The newest project entries (later `updated` month) survive; the oldest are dropped.
		expect(result.includedNames).toContain("p11");
		expect(result.includedNames).not.toContain("p00");

		// A frequently touched permanent entry (`confirmed` newer than other entries' `updated`)
		// survives over-budget tiering ahead of untouched entries.
		const confirmedEntries = [
			entry("core-old-but-used", "project", "2026-01-01", "2026-12-31"),
			...Array.from({ length: 30 }, (_, i) => entry(`newer-${i}`, "project", "2026-06-01")),
		];
		const confirmedResult = buildMemoryIndexForBootstrap(confirmedEntries, 200);
		expect(confirmedResult.overBudget).toBe(true);
		expect(confirmedResult.includedNames).toContain("core-old-but-used");
	});
});

describe("index-budget — workspace clip", () => {
	it("keeps whole H2 sections from the top and flags the omitted tail", () => {
		const workspace = `# Workspace\n\n${Array.from(
			{ length: 30 },
			(_, i) => `## Section ${i}\n\n${"word ".repeat(40)}`,
		).join("\n\n")}`;
		const clipped = clipWorkspaceMemoryForBootstrap(workspace, 200);
		expect(clipped).toContain("## Section 0");
		expect(clipped).toMatch(/read.*MEMORY\.md/);
		expect(clipped).not.toContain("## Section 29");
		for (const text of [workspace, `${"很长的前言".repeat(1500)}\n\n## Rules\nUse pnpm`]) {
			const result = clipWorkspaceMemoryForBootstrap(text, 200);
			expect(countPromptUnits(result)).toBeLessThanOrEqual(200);
			expect(result.length).toBeLessThanOrEqual(4000);
			expect(result).toMatch(/read.*MEMORY\.md/);
		}
	});
});

describe("index-budget — journal tail", () => {
	it("keeps the newest lines and backfills the previous day when today is empty or short", () => {
		const journal = `# 2026-09-04\n\n${Array.from({ length: 60 }, (_, i) => `- 0${i % 10}:00 event ${i}`).join("\n")}`;
		const tail = clipJournalTailForBootstrap(journal, 80);
		expect(tail).toContain("event 59");
		expect(tail).not.toContain("event 0\n");

		// Empty today backfills yesterday; short today includes both in chronological order.
		const morning = buildJournalBlocksForBootstrap({
			todayDate: "2026-09-05",
			todayText: "",
			previous: { date: "2026-09-04", text: "# 2026-09-04\n- 22:00 wrapped up refactor" },
		});
		expect(morning).toEqual([{ date: "2026-09-04", text: "# 2026-09-04\n- 22:00 wrapped up refactor" }]);

		const shortToday = buildJournalBlocksForBootstrap({
			todayDate: "2026-09-05",
			todayText: "# 2026-09-05\n- 08:10 morning check",
			previous: { date: "2026-09-04", text: "# 2026-09-04\n- 22:00 wrapped up refactor" },
		});
		expect(shortToday.map((b) => b.date)).toEqual(["2026-09-04", "2026-09-05"]);

		// Full today (>= 150 units) omits yesterday.
		const busyToday = buildJournalBlocksForBootstrap({
			todayDate: "2026-09-05",
			todayText: `# 2026-09-05\n${Array.from({ length: 20 }, (_, i) => `- 10:${String(i).padStart(2, "0")} completed long engineering milestone step number ${i} with full details`).join("\n")}`,
			previous: { date: "2026-09-04", text: "# 2026-09-04\n- 22:00 old" },
		});
		expect(busyToday.map((b) => b.date)).toEqual(["2026-09-05"]);
	});
});
