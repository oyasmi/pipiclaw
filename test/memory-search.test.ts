import { describe, expect, it } from "vitest";
import { searchMemory } from "../src/memory/search.js";
import {
	descriptionSimilarity,
	findNearDuplicateEntries,
	tokenizeRecallText,
} from "../src/memory/search.js";
import type { MemoryEntry } from "../src/memory/store.js";

function entry(name: string, description: string, body = ""): MemoryEntry {
	return {
		name,
		description,
		body,
		type: "project",
		source: "agent",
		created: "2026-09-01",
		updated: "2026-09-01",
		malformed: false,
	};
}

describe("memory search — tokenizer", () => {
	it("splits ascii identifiers and keeps Chinese bigrams/trigrams", () => {
		const tokens = tokenizeRecallText("部署窗口 deploy-window is Thursday");
		expect(tokens).toContain("deploy");
		expect(tokens).toContain("window");
		expect(tokens).toContain("thursday");
		expect(tokens).toContain("部署");
	});
});

describe("memory search — near-duplicate guard", () => {
	it("flags a reworded restatement above the Jaccard bar", () => {
		const score = descriptionSimilarity(
			"do not treat single-source claims as independently confirmed in the briefing",
			"the briefing must not treat single-source claims as independently confirmed facts",
		);
		expect(score).toBeGreaterThanOrEqual(0.6);
	});

	it("treats a normalized-equal description as a duplicate", () => {
		expect(descriptionSimilarity("Deploy   window", "deploy window")).toBe(1);
	});

	it("does not flag unrelated descriptions", () => {
		const dupes = findNearDuplicateEntries("user prefers Chinese", [entry("x", "prod deploy window is Thursday")]);
		expect(dupes).toEqual([]);
	});
});

describe("memory search — searchMemory", () => {
	const entries = [
		entry("deploy-window-thursday", "prod deploy window is Thursday 20:00", "emergency hotfix allowed any time"),
		entry("user-prefers-chinese", "speak Chinese, call the user 淇澳"),
	];

	it("matches memory descriptions and bodies", () => {
		const hits = searchMemory({ query: "deploy window", entries });
		expect(hits[0]).toMatchObject({ kind: "memory", label: "deploy-window-thursday" });
	});

	it("matches journal lines and workspace sections", () => {
		const hits = searchMemory({
			query: "briefing weekday",
			entries,
			journal: [{ date: "2026-09-04", content: "# 2026-09-04\n\n- 04:20 briefing switched to weekdays only" }],
			workspaceMemory: "# Workspace\n\n## Briefing\n\nThe briefing runs on weekdays.",
		});
		expect(hits.some((h) => h.kind === "journal" && h.date === "2026-09-04")).toBe(true);
		expect(hits.some((h) => h.kind === "workspace" && h.label === "Briefing")).toBe(true);
	});

	it("returns nothing for a blank query", () => {
		expect(searchMemory({ query: "   ", entries })).toEqual([]);
	});
});
