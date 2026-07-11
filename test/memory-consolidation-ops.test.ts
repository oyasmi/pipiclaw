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

		vi.mocked(runRetriedSidecarTask).mockResolvedValue({
			output: JSON.stringify({
				memoryOps: [{ op: "supersede", targetId: entry.id, content: "Deploy strategy is blue-green" }],
				historyBlock: "- Switched deploy strategy to blue-green.",
			}),
		} as never);

		const result = await runInlineConsolidation({
			channelDir,
			model: fakeModel,
			resolveApiKey,
			messages,
			mode: "boundary",
		});

		expect(result.skipped).toBe(false);
		const memory = await readChannelMemory(channelDir);
		expect(memory).toContain("blue-green");
		expect(memory).not.toContain("rolling");
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
