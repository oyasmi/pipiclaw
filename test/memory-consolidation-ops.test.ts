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
import { readMemoryMetadata, syncMemoryMetadata } from "../src/memory/metadata.js";
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

	it("writes durable memory from a window that contains tool results", async () => {
		const channelDir = createTempChannel();
		vi.mocked(runRetriedSidecarTask).mockImplementation(async (task) => {
			const json = JSON.stringify({
				memoryOps: [
					{
						op: "add",
						content: "Releases now ship on Thursday evenings",
						kind: "constraint",
						confidence: 0.95,
						necessity: "high",
						reason: "ops mandated a fixed release window",
					},
				],
				historyBlock: "- Release window fixed to Thursday evenings.",
			});
			return { rawText: json, output: task.parse(json) } as never;
		});

		const windowMessages = [
			{ role: "user", content: "check the release notes" },
			{ role: "toolResult", content: [{ type: "text", text: "release-window.md: Thursday evenings" }] },
			{
				role: "assistant",
				content: [{ type: "text", text: "Releases now ship on Thursday evenings, per ops." }],
			},
		] as never[];

		const result = await runInlineConsolidation({
			channelDir,
			model: fakeModel,
			resolveApiKey,
			messages: windowMessages,
			sourceWindow: {
				sourceKind: "idle",
				entries: [{ id: "session-99" }] as never[],
				messages: windowMessages,
				windowId: "window-tool-99",
			},
			mode: "boundary",
		});

		expect(result.skipped).toBe(false);
		const memory = await readChannelMemory(channelDir);
		expect(memory).toContain("Thursday evenings");
	});

	it("holds consolidation to the same durable bar as the growth review", async () => {
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
						content: "Not confident enough for probation either",
						kind: "fact",
						confidence: 0.7,
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
		expect(memory).not.toContain("Not confident enough for probation either");
		// Rejected candidates stay visible to the review log rather than vanishing.
		expect(result.rejectedMemoryOps.map((candidate) => candidate.content)).toEqual([
			"Transient debugging note",
			"Not confident enough for probation either",
		]);
		expect(result.appendedDurableEntries).toBe(1);
		expect(result.appendedProbationaryEntries).toBe(0);
	});

	it("writes a high-confidence medium-necessity candidate on probation, not durably (spec 037, D6)", async () => {
		const channelDir = createTempChannel();
		vi.mocked(runRetriedSidecarTask).mockImplementation(async (task) => {
			const json = JSON.stringify({
				memoryOps: [
					{
						op: "add",
						content: "The release channel defaults to Thursday cuts",
						kind: "fact",
						confidence: 0.95,
						necessity: "medium",
					},
				],
				historyBlock: "",
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

		expect(result.appendedDurableEntries).toBe(0);
		expect(result.appendedProbationaryEntries).toBe(1);
		const memory = await readChannelMemory(channelDir);
		expect(memory).toContain("The release channel defaults to Thursday cuts");
		const [entry] = parseChannelMemoryEntries(memory);
		expect((await readMemoryMetadata(channelDir)).entries[entry.id]?.probationUntil).toBeTruthy();
	});

	it("caps probationary writes at the per-run limit, rejecting the overflow (spec 037, D6)", async () => {
		const channelDir = createTempChannel();
		vi.mocked(runRetriedSidecarTask).mockImplementation(async (task) => {
			const json = JSON.stringify({
				memoryOps: Array.from({ length: 8 }, (_, index) => ({
					op: "add",
					content: `Medium-necessity operating fact number ${index}`,
					kind: "fact",
					confidence: 0.95,
					necessity: "medium",
				})),
				historyBlock: "",
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

		expect(result.appendedProbationaryEntries).toBe(5);
		expect(result.rejectedMemoryOps).toHaveLength(3);
		const entries = parseChannelMemoryEntries(await readChannelMemory(channelDir));
		expect(entries).toHaveLength(5);
	});
});

describe("cleanupChannelMemory shrink guard", () => {
	const bigMemory = `# Channel Memory\n\n## Preferences\n\n${Array.from(
		{ length: 90 },
		(_, i) => `- Durable preference number ${i} that should be retained across future cleanup passes.`,
	).join("\n")}`;

	const trimmedTo = (lines: number) =>
		`# Channel Memory\n\n## Preferences\n\n${Array.from(
			{ length: lines },
			(_, i) => `- Durable preference number ${i} that should be retained across future cleanup passes.`,
		).join("\n")}`;

	it.each([
		{ label: "rejects a cleanup that shrinks below the guard ratio", output: trimmedTo(1), expected: "rejected" },
		{ label: "allows a reasonable cleanup", output: trimmedTo(60), expected: "allowed" },
	])("$label", async ({ output, expected }) => {
		const channelDir = createTempChannel();
		vi.mocked(runSidecarTask).mockResolvedValue({ output } as never);

		const cleanup = cleanupChannelMemory({ channelDir, model: fakeModel, resolveApiKey, messages: [] }, bigMemory, {
			cleanupShrinkGuardMinRatio: 0.4,
			cleanupShrinkGuardMinChars: 2_000,
		});

		if (expected === "rejected") {
			await expect(cleanup).rejects.toBeInstanceOf(MemoryCleanupRejectedError);
		} else {
			await expect(cleanup).resolves.toMatchObject({ rewritten: true });
		}
	});

	it("rejects a cleanup that collapses many short entries even under the char-size guard floor", async () => {
		const channelDir = createTempChannel();
		// Four short "Update" blocks is the shape that trips `shouldCleanupChannelMemory` via the
		// section-count branch (not the char-length branch) while staying under
		// `cleanupShrinkGuardMinChars` — exactly the input the entry-count guard now protects.
		const smallMemory = `# Channel Memory\n\n${Array.from(
			{ length: 4 },
			(_, i) => `## Update ${i}\n\n- Short preference ${i}.\n- Another short preference ${i}.`,
		).join("\n\n")}`;
		const output = `# Channel Memory\n\n## Update 0\n\n- Short preference 0.\n\n## Update 1\n\n- Short preference 1.`;
		vi.mocked(runSidecarTask).mockResolvedValue({ output } as never);

		const cleanup = cleanupChannelMemory({ channelDir, model: fakeModel, resolveApiKey, messages: [] }, smallMemory, {
			cleanupShrinkGuardMinRatio: 0.4,
			cleanupShrinkGuardMinChars: 2_000,
		});

		await expect(cleanup).rejects.toBeInstanceOf(MemoryCleanupRejectedError);
	});

	it("rejects a cleanup that drops a user-saved entry", async () => {
		const channelDir = createTempChannel();
		await applyChannelMemoryOps(channelDir, [{ op: "add", content: "Always deploy on Thursday" }]);
		const baseMemory = await readChannelMemory(channelDir);
		const [entry] = parseChannelMemoryEntries(baseMemory);
		await syncMemoryMetadata(
			channelDir,
			[{ id: entry.id, content: entry.content, sectionHeading: entry.sectionHeading }],
			[{ id: entry.id, metadata: { sourceType: "user" } }],
		);
		// Pad past MEMORY_CLEANUP_LENGTH_THRESHOLD so the trigger fires regardless of section count.
		const currentMemory = `${baseMemory}\n${"padding ".repeat(700)}`;

		const droppedOutput = "# Channel Memory\n\n## Preferences\n\n";
		vi.mocked(runSidecarTask).mockResolvedValue({ output: droppedOutput } as never);

		const cleanup = cleanupChannelMemory(
			{ channelDir, model: fakeModel, resolveApiKey, messages: [] },
			currentMemory,
			{ cleanupShrinkGuardMinRatio: 0, cleanupShrinkGuardMinChars: 0 },
		);

		await expect(cleanup).rejects.toThrow(new RegExp(entry.id));
	});
});
