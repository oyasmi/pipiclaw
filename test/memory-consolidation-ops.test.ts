import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/memory/sidecar-worker.js", () => ({
	runSidecarTask: vi.fn(),
	runRetriedSidecarTask: vi.fn(),
	SidecarParseError: class SidecarParseError extends Error {},
}));

import {
	cleanupChannelMemory,
	MemoryCleanupRejectedError,
	runInlineConsolidation,
} from "../src/memory/consolidation.js";
import { applyChannelMemoryOps, parseChannelMemoryEntries, readChannelMemory } from "../src/memory/files.js";
import { readMemoryMetadata } from "../src/memory/metadata.js";
import { runRetriedSidecarTask, runSidecarTask } from "../src/memory/sidecar-worker.js";
import { useTempDirs } from "./helpers/fixtures.js";

const createTempChannel = useTempDirs("pipiclaw-consol-ops-");

afterEach(() => {
	vi.clearAllMocks();
});

const fakeModel = { id: "test" } as never;
const resolveApiKey = async () => "key";

const messages = [
	{ role: "user", content: "please switch our deploy strategy" },
	{ role: "assistant", content: [{ type: "text", text: "done, using blue-green now" }] },
] as never[];

describe("runInlineConsolidation with ops", () => {
	it("applies a supersede op emitted by the consolidation worker", async () => {
		const channelDir = createTempChannel();
		await applyChannelMemoryOps(channelDir, [{ op: "add", content: "Deploy strategy is rolling" }]);
		const [entry] = parseChannelMemoryEntries(await readChannelMemory(channelDir));

		// The real sidecar runs the task's own `parse`; mirror that so the mock exercises the
		// shared extraction parser and its confidence gate.
		vi.mocked(runRetriedSidecarTask).mockImplementation(async (task) => {
			const json = JSON.stringify({
				memoryOps: [
					{
						op: "supersede",
						targetId: entry.id,
						content: "Deploy strategy is blue-green",
						kind: "decision",
						confidence: 0.95,
						necessity: "high",
						reason: "deploy strategy changed",
					},
				],
				historyBlock: "- Switched deploy strategy to blue-green.",
			});
			return { rawText: json, output: task.parse(json) } as never;
		});

		const result = await runInlineConsolidation({
			channelDir,
			model: fakeModel,
			resolveApiKey,
			messages,
			sourceWindow: {
				sourceKind: "idle",
				entries: [{ id: "session-42" }] as never[],
				messages,
				windowId: "window-deploy-42",
				hasExternalToolContent: false,
			},
			mode: "boundary",
		});

		expect(result.skipped).toBe(false);
		const memory = await readChannelMemory(channelDir);
		expect(memory).toContain("blue-green");
		expect(memory).not.toContain("rolling");
		expect((await readMemoryMetadata(channelDir)).entries[entry.id]).toMatchObject({
			sourceEntryIds: ["session-42"],
			sourceCorrelationIds: ["window-deploy-42"],
		});
	});

	it("holds consolidation to the same auto-write bar as the growth review", async () => {
		const channelDir = createTempChannel();
		vi.mocked(runRetriedSidecarTask).mockImplementation(async (task) => {
			const json = JSON.stringify({
				memoryOps: [
					{
						op: "add",
						content: "Durable deploy constraint",
						kind: "constraint",
						confidence: 0.95,
						necessity: "high",
					},
					{ op: "add", content: "Transient debugging note", kind: "fact", confidence: 0.4, necessity: "low" },
					{
						op: "add",
						content: "Plausible but not load-bearing",
						kind: "fact",
						confidence: 0.95,
						necessity: "medium",
					},
				],
				historyBlock: "- Discussed deploys.",
			});
			return { rawText: json, output: task.parse(json) } as never;
		});

		const result = await runInlineConsolidation({
			channelDir,
			model: fakeModel,
			resolveApiKey,
			messages,
			mode: "idle",
		});

		const memory = await readChannelMemory(channelDir);
		expect(memory).toContain("Durable deploy constraint");
		expect(memory).not.toContain("Transient debugging note");
		expect(memory).not.toContain("Plausible but not load-bearing");
		// Rejected candidates stay visible to the review log rather than vanishing.
		expect(result.rejectedMemoryOps.map((candidate) => candidate.content)).toEqual([
			"Transient debugging note",
			"Plausible but not load-bearing",
		]);
	});
});

describe("cleanupChannelMemory shrink guard", () => {
	const bigMemory = `# Channel Memory\n\n## Preferences\n\n${Array.from(
		{ length: 90 },
		(_, i) => `- Durable preference number ${i} that should be retained across future cleanup passes.`,
	).join("\n")}`;

	it("rejects a cleanup that shrinks below the guard ratio", async () => {
		const channelDir = createTempChannel();
		vi.mocked(runSidecarTask).mockResolvedValue({ output: "# Channel Memory\n\n## Preferences\n\n- one" } as never);

		await expect(
			cleanupChannelMemory({ channelDir, model: fakeModel, resolveApiKey, messages: [] }, bigMemory, {
				cleanupShrinkGuardMinRatio: 0.4,
				cleanupShrinkGuardMinChars: 2_000,
			}),
		).rejects.toBeInstanceOf(MemoryCleanupRejectedError);
	});

	it("allows a reasonable cleanup", async () => {
		const channelDir = createTempChannel();
		const trimmed = `# Channel Memory\n\n## Preferences\n\n${Array.from(
			{ length: 60 },
			(_, i) => `- Durable preference number ${i} that should be retained across future cleanup passes.`,
		).join("\n")}`;
		vi.mocked(runSidecarTask).mockResolvedValue({ output: trimmed } as never);

		await expect(
			cleanupChannelMemory({ channelDir, model: fakeModel, resolveApiKey, messages: [] }, bigMemory, {
				cleanupShrinkGuardMinRatio: 0.4,
				cleanupShrinkGuardMinChars: 2_000,
			}),
		).resolves.toBe(true);
	});
});
