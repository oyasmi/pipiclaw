import { describe, expect, it } from "vitest";
import {
	buildChannelIndexForBootstrap,
	clipJournalTailForBootstrap,
	clipWorkspaceMemoryForBootstrap,
} from "../src/memory/index-budget.js";
import type { MemoryEntry } from "../src/memory/store.js";

function entry(name: string, type: MemoryEntry["type"], updated: string): MemoryEntry {
	return {
		name,
		description: `${name} ${"detail ".repeat(12)}`,
		body: "",
		type,
		source: "agent",
		created: "2026-01-01",
		updated,
		malformed: false,
	};
}

describe("index-budget — channel index tiering", () => {
	it("returns the full index when it fits", () => {
		const result = buildChannelIndexForBootstrap([entry("a", "project", "2026-09-01")], 1_400);
		expect(result.overBudget).toBe(false);
		expect(result.omittedCount).toBe(0);
		expect(result.text).toContain("- a —");
	});

	it("keeps all user/feedback, drops oldest project/reference, adds an omitted line", () => {
		const entries = [
			entry("u1", "user", "2026-01-01"),
			entry("f1", "feedback", "2026-01-01"),
			...Array.from({ length: 40 }, (_, i) =>
				entry(`p${String(i).padStart(2, "0")}`, "project", `2026-${String((i % 12) + 1).padStart(2, "0")}-01`),
			),
		];
		const result = buildChannelIndexForBootstrap(entries, 300);
		expect(result.overBudget).toBe(true);
		expect(result.includedNames).toContain("u1");
		expect(result.includedNames).toContain("f1");
		expect(result.omittedCount).toBeGreaterThan(0);
		expect(result.text).toMatch(/\[- \d+ more entries omitted; use memory_search\]/);
		// The newest project entries (later `updated` month) survive; the oldest are dropped.
		expect(result.includedNames).toContain("p11");
		expect(result.includedNames).not.toContain("p00");
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
		expect(clipped).toContain("more section(s) omitted");
		expect(clipped).not.toContain("## Section 29");
	});
});

describe("index-budget — journal tail", () => {
	it("keeps the newest lines", () => {
		const journal = `# 2026-09-04\n\n${Array.from({ length: 60 }, (_, i) => `- 0${i % 10}:00 event ${i}`).join("\n")}`;
		const tail = clipJournalTailForBootstrap(journal, 80);
		expect(tail).toContain("event 59");
		expect(tail).not.toContain("event 0\n");
	});
});
