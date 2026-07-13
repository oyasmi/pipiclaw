import { describe, expect, it } from "vitest";
import { buildCompactionMemorySourceWindow, buildIncrementalMemorySourceWindow } from "../src/memory/source-window.js";

const entries = [
	{ id: "e1", type: "message", message: { role: "user", content: "old request" } },
	{ id: "e2", type: "message", message: { role: "assistant", content: [{ type: "text", text: "old reply" }] } },
	{ id: "e3", type: "message", message: { role: "user", content: "new request" } },
	{ id: "e4", type: "message", message: { role: "assistant", content: [{ type: "text", text: "new reply" }] } },
] as never[];

describe("memory source windows", () => {
	it("uses the cursor for both entries and worker messages", () => {
		const window = buildIncrementalMemorySourceWindow({
			entries,
			lastEntryId: "e2",
			sourceKind: "idle",
		});
		expect(window.entries.map((entry) => entry.id)).toEqual(["e3", "e4"]);
		expect(JSON.stringify(window.messages)).toContain("new request");
		expect(JSON.stringify(window.messages)).not.toContain("old request");
		expect(window.throughEntryId).toBe("e4");
	});

	it("intersects a compaction boundary with the durable cursor", () => {
		const window = buildCompactionMemorySourceWindow({
			entries,
			messagesToSummarize: [
				{ role: "user", content: "old request" },
				{ role: "assistant", content: [{ type: "text", text: "old reply" }] },
				{ role: "user", content: "new request" },
			] as never[],
			firstKeptEntryId: "e4",
			lastEntryId: "e2",
		});
		expect(window.entries.map((entry) => entry.id)).toEqual(["e3"]);
		expect(JSON.stringify(window.messages)).toContain("new request");
		expect(JSON.stringify(window.messages)).not.toContain("old request");
	});

	it("marks windows containing tool results as externally sourced", () => {
		const window = buildIncrementalMemorySourceWindow({
			entries: [
				{ id: "e1", type: "message", message: { role: "user", content: "inspect" } },
				{ id: "e2", type: "message", message: { role: "toolResult", content: [{ type: "text", text: "data" }] } },
			] as never[],
			sourceKind: "growth-review",
		});
		expect(window.hasExternalToolContent).toBe(true);
	});
});
