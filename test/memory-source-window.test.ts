import { describe, expect, it } from "vitest";
import { buildCompactionMemorySourceWindow, buildIncrementalMemorySourceWindow } from "../src/memory/source-window.js";

const entries = [
	{ id: "e1", type: "message", message: { role: "user", content: "old request" } },
	{ id: "e2", type: "message", message: { role: "assistant", content: [{ type: "text", text: "old reply" }] } },
	{ id: "e3", type: "message", message: { role: "user", content: "new request" } },
	{ id: "e4", type: "message", message: { role: "assistant", content: [{ type: "text", text: "new reply" }] } },
] as never[];

describe("memory source windows", () => {
	it("windows entries and worker messages by cursor, intersecting a compaction boundary with the durable cursor", () => {
		const incremental = buildIncrementalMemorySourceWindow({
			entries,
			lastEntryId: "e2",
			sourceKind: "idle",
		});
		expect(incremental.entries.map((entry) => entry.id)).toEqual(["e3", "e4"]);
		expect(JSON.stringify(incremental.messages)).toContain("new request");
		expect(JSON.stringify(incremental.messages)).not.toContain("old request");
		expect(incremental.throughEntryId).toBe("e4");

		const compaction = buildCompactionMemorySourceWindow({
			entries,
			messagesToSummarize: [
				{ role: "user", content: "old request" },
				{ role: "assistant", content: [{ type: "text", text: "old reply" }] },
				{ role: "user", content: "new request" },
			] as never[],
			firstKeptEntryId: "e4",
			lastEntryId: "e2",
		});
		expect(compaction.entries.map((entry) => entry.id)).toEqual(["e3"]);
		expect(JSON.stringify(compaction.messages)).toContain("new request");
		expect(JSON.stringify(compaction.messages)).not.toContain("old request");
	});
});
