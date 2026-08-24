import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/memory/sidecar-worker.js", () => ({
	runSidecarTask: vi.fn(),
	runRetriedSidecarTask: vi.fn(),
	SidecarParseError: class SidecarParseError extends Error {},
}));

import { runMemoryExtraction } from "../src/memory/extraction.js";
import { syncMemoryMetadata } from "../src/memory/metadata.js";
import { runRetriedSidecarTask } from "../src/memory/sidecar-worker.js";
import { setupChannelFiles, useTempDirs } from "./helpers/fixtures.js";

const createTempChannel = useTempDirs("pipiclaw-extraction-");

afterEach(() => {
	vi.clearAllMocks();
});

const fakeModel = { id: "test" } as never;
const resolveApiKey = async () => "key";
const emptyResult = () =>
	JSON.stringify({
		memoryOps: [],
		historyBlock: "",
	});

async function captureExtractionPrompt(channelDir: string, transcriptText: string): Promise<string> {
	let capturedPrompt = "";
	vi.mocked(runRetriedSidecarTask).mockImplementation(async (task) => {
		capturedPrompt = task.prompt;
		const json = emptyResult();
		return { rawText: json, output: task.parse(json) } as never;
	});
	await runMemoryExtraction({
		name: "test-extraction",
		channelDir,
		messages: [
			{ role: "user", content: transcriptText },
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
		] as never[],
		model: fakeModel,
		resolveApiKey,
		timeoutMs: 20_000,
		transcriptMaxChars: 28_000,
		includeHistoryBlock: false,
	});
	return capturedPrompt;
}

describe("runMemoryExtraction entries rendering (§3.2)", () => {
	it("renders the full entry list when the corpus is small", async () => {
		const channelDir = createTempChannel();
		setupChannelFiles(channelDir, {
			memory: [
				"# Channel Memory",
				"",
				"## Facts",
				"",
				...Array.from({ length: 5 }, (_, i) => `- Small corpus fact number ${i}. <!--id:m-fact${i}-->`),
			].join("\n"),
		});

		const prompt = await captureExtractionPrompt(channelDir, "talking about something unrelated");

		for (let i = 0; i < 5; i++) {
			expect(prompt).toContain(`m-fact${i}`);
		}
		expect(prompt).not.toContain("showing");
	});

	it("filters to similar entries plus user-saved ones when the corpus is large", async () => {
		const channelDir = createTempChannel();
		const bulkEntries = Array.from(
			{ length: 45 },
			(_, i) => `- Unrelated durable topic filler alpha beta gamma number ${i}. <!--id:m-bulk${i}-->`,
		);
		const targetEntry = "- Deploy pipeline release window moonstone codename fact. <!--id:m-target-->";
		const userEntry = "- User explicitly saved preference about tabs vs spaces. <!--id:m-userpin-->";
		setupChannelFiles(channelDir, {
			memory: ["# Channel Memory", "", "## Facts", "", ...bulkEntries, targetEntry, userEntry].join("\n"),
		});
		await syncMemoryMetadata(
			channelDir,
			[
				{
					id: "m-userpin",
					content: "User explicitly saved preference about tabs vs spaces.",
					sectionHeading: "Facts",
				},
			],
			[{ id: "m-userpin", metadata: { sourceType: "user" } }],
		);

		const prompt = await captureExtractionPrompt(
			channelDir,
			"we are discussing the deploy pipeline release window moonstone codename",
		);

		expect(prompt).toContain("showing");
		expect(prompt).toContain("m-target");
		// The user-saved entry must always be a supersede candidate, regardless of similarity.
		expect(prompt).toContain("m-userpin");
		// At least some of the unrelated filler entries should have been left out.
		expect((prompt.match(/m-bulk\d+/g) ?? []).length).toBeLessThan(45);
	});
});
