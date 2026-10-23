import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/memory/sidecar-worker.js", () => ({
	runSidecarTask: vi.fn(),
	runRetriedSidecarTask: vi.fn(),
	SidecarParseError: class SidecarParseError extends Error {},
}));

import { runReflect } from "../src/memory/reflect.js";
import { runRetriedSidecarTask } from "../src/memory/sidecar-worker.js";
import { applyMemoryOps, listMemoryEntries } from "../src/memory/store.js";
import { useTempDirs } from "./helpers/fixtures.js";

const createTempDir = useTempDirs("pipiclaw-reflect-");
const fakeModel = { id: "test" } as never;
const resolveApiKey = async () => "key";

function scripted(json: Record<string, unknown>) {
	vi.mocked(runRetriedSidecarTask).mockImplementation(async (task) => {
		const text = JSON.stringify(json);
		return { rawText: text, output: task.parse(text) } as never;
	});
}

const meaningfulMessages = [
	{ role: "user", content: "记住：部署窗口是周四晚上" },
	{ role: "assistant", content: [{ type: "text", text: "好的，已经记录。" }] },
] as never[];

async function run(deskDir: string, workspaceDir = deskDir, today = "2026-09-04") {
	return runReflect({
		deskDir,
		workspaceDir,
		model: fakeModel,
		resolveApiKey,
		messages: meaningfulMessages,
		today,
	});
}

afterEach(() => {
	vi.clearAllMocks();
});

describe("reflect — skip conditions", () => {
	it("skips (no LLM call) when the window has no meaningful exchange", async () => {
		const deskDir = createTempDir();
		scripted({ journal: [], ops: [], discarded: [] });
		const result = await runReflect({
			deskDir,
			workspaceDir: deskDir,
			model: fakeModel,
			resolveApiKey,
			messages: [{ role: "user", content: "" }] as never[],
		});
		expect(result.skipped).toBe(true);
		expect(runRetriedSidecarTask).not.toHaveBeenCalled();
	});
});

describe("reflect — write tier (D6)", () => {
	it("writes a high-necessity, high-confidence add as durable", async () => {
		const deskDir = createTempDir();
		scripted({
			journal: [],
			ops: [
				{
					op: "add",
					name: "deploy-window-thursday",
					type: "project",
					description: "Prod deploy window is Thursday evening",
					confidence: 0.95,
					necessity: "high",
					reason: "user stated it",
				},
			],
			discarded: [],
		});
		const result = await run(deskDir);
		expect(result.added).toEqual(["deploy-window-thursday"]);
		const [entry] = await listMemoryEntries(deskDir);
		expect(entry.expires).toBeUndefined();
	});

	it("writes a medium-necessity, high-confidence add as probationary with a 30-day deadline", async () => {
		const deskDir = createTempDir();
		scripted({
			journal: [],
			ops: [
				{
					op: "add",
					description: "The team usually deploys on Fridays",
					confidence: 0.92,
					necessity: "medium",
					reason: "mentioned in passing",
				},
			],
			discarded: [],
		});
		const result = await run(deskDir);
		expect(result.added).toHaveLength(1);
		const [entry] = await listMemoryEntries(deskDir);
		expect(entry.expires).toBe("2026-10-04");
	});

	it("rejects an add below the write bar and rejects an update the same way", async () => {
		const deskDir = createTempDir();
		scripted({
			journal: [],
			ops: [
				{ op: "add", description: "weak fact", confidence: 0.5, necessity: "low", reason: "unsure" },
				{ op: "update", name: "ghost", description: "x", confidence: 0.5, necessity: "low", reason: "unsure" },
			],
			discarded: [],
		});
		const result = await run(deskDir);
		expect(result.added).toEqual([]);
		expect(result.rejected.length).toBeGreaterThanOrEqual(1);
	});

	it("only lets add reach probationary tier — a medium-confidence update is rejected outright", async () => {
		const deskDir = createTempDir();
		await applyMemoryOps(deskDir, [{ op: "add", name: "x", description: "old", source: "agent" }]);
		scripted({
			journal: [],
			ops: [
				{ op: "update", name: "x", description: "new", confidence: 0.92, necessity: "medium", reason: "update" },
			],
			discarded: [],
		});
		const result = await run(deskDir);
		expect(result.updated).toEqual([]);
		expect(result.rejected).toHaveLength(1);
	});
});

describe("reflect — per-run caps", () => {
	it("caps add at 8 and delete at 3", async () => {
		const deskDir = createTempDir();
		for (let i = 0; i < 5; i++) {
			await applyMemoryOps(deskDir, [{ op: "add", name: `d${i}`, description: `old fact ${i}`, source: "agent" }]);
		}
		const ops = [
			...Array.from({ length: 10 }, (_, i) => ({
				op: "add",
				description: `fresh distinct fact number ${i} about the project`,
				confidence: 0.95,
				necessity: "high",
				reason: "r",
			})),
			...Array.from({ length: 5 }, (_, i) => ({ op: "delete", name: `d${i}`, confidence: 0.9, reason: "obsolete" })),
		];
		scripted({ journal: [], ops, discarded: [] });
		const result = await run(deskDir);
		expect(result.added).toHaveLength(8);
		expect(result.deleted).toHaveLength(3);
		expect(result.rejected.length).toBeGreaterThanOrEqual(4);
	});

	it("relaxes the delete cap to 8 in condense mode", async () => {
		const deskDir = createTempDir();
		// Seed enough entries with long descriptions that the index exceeds its 1,400-unit budget.
		for (let i = 0; i < 150; i++) {
			await applyMemoryOps(deskDir, [
				{
					op: "add",
					name: `bulk-${i}`,
					type: "project",
					description: `Bulk seeded fact number ${i} with plenty of extra words so this entry costs a realistic number of prompt units on its own, the way an actual durable memory line would`,
					source: "agent",
				},
			]);
		}
		const ops = Array.from({ length: 8 }, (_, i) => ({
			op: "delete",
			name: `bulk-${i}`,
			confidence: 0.9,
			reason: "condensed away",
		}));
		scripted({ journal: [], ops, discarded: [] });
		const result = await run(deskDir);
		expect(result.condensed).toBe(true);
		expect(result.deleted).toHaveLength(8);
	});
});

describe("reflect — user-source protection", () => {
	it("never deletes a user-saved entry, regardless of confidence", async () => {
		const deskDir = createTempDir();
		await applyMemoryOps(deskDir, [{ op: "add", name: "u", description: "user fact", source: "user" }]);
		scripted({
			journal: [],
			ops: [{ op: "delete", name: "u", confidence: 0.99, reason: "seems wrong now" }],
			discarded: [],
		});
		const result = await run(deskDir);
		expect(result.deleted).toEqual([]);
		expect((await listMemoryEntries(deskDir)).map((e) => e.name)).toContain("u");
	});

	it("updates a user-saved entry only at confidence >= 0.95 with a user message in the window", async () => {
		const deskDir = createTempDir();
		await applyMemoryOps(deskDir, [{ op: "add", name: "u", description: "user fact", source: "user" }]);
		scripted({
			journal: [],
			ops: [{ op: "update", name: "u", description: "revised", confidence: 0.9, necessity: "high", reason: "r" }],
			discarded: [],
		});
		const rejected = await run(deskDir);
		expect(rejected.updated).toEqual([]);

		scripted({
			journal: [],
			ops: [{ op: "update", name: "u", description: "revised", confidence: 0.97, necessity: "high", reason: "r" }],
			discarded: [],
		});
		const accepted = await run(deskDir);
		expect(accepted.updated).toEqual(["u"]);
	});
});

describe("reflect — name resolution", () => {
	it("downgrades an update naming an unknown entry into an add", async () => {
		const deskDir = createTempDir();
		scripted({
			journal: [],
			ops: [
				{
					op: "update",
					name: "does-not-exist",
					description: "a fact stated as an update",
					confidence: 0.95,
					necessity: "high",
					reason: "r",
				},
			],
			discarded: [],
		});
		const result = await run(deskDir);
		expect(result.updated).toEqual([]);
		expect(result.added).toHaveLength(1);
	});
});

describe("reflect — journal and touch", () => {
	it("appends journal lines and clears expires on touched entries", async () => {
		const deskDir = createTempDir();
		await applyMemoryOps(deskDir, [
			{ op: "add", name: "p", description: "probationary", source: "agent", expires: "2026-10-04" },
		]);
		scripted({
			journal: ["01:12 用户确认周四部署窗口"],
			ops: [{ op: "touch", names: ["p"] }],
			discarded: [],
		});
		const result = await run(deskDir);
		expect(result.journalAppended).toBe(1);
		expect(result.touched).toEqual(["p"]);
		expect((await listMemoryEntries(deskDir))[0].expires).toBeUndefined();
	});
});

describe("reflect — deterministic pre-step", () => {
	it("expires a lapsed probationary entry before the LLM call, without a tombstone", async () => {
		const deskDir = createTempDir();
		await applyMemoryOps(deskDir, [
			{ op: "add", name: "old", description: "stale probation", source: "agent", expires: "2026-09-01" },
		]);
		scripted({ journal: [], ops: [], discarded: [] });
		const result = await run(deskDir);
		expect(result.expiredProbation).toEqual(["old"]);
		expect(await listMemoryEntries(deskDir)).toEqual([]);

		// re-adding the same description must not be blocked by a tombstone
		scripted({
			journal: [],
			ops: [
				{ op: "add", description: "stale probation", confidence: 0.95, necessity: "high", reason: "learned again" },
			],
			discarded: [],
		});
		const relearned = await run(deskDir);
		expect(relearned.added).toHaveLength(1);
	});
});

describe("reflect — malformed JSON tolerance", () => {
	it("treats a missing ops/journal field as empty rather than throwing", async () => {
		const deskDir = createTempDir();
		scripted({ discarded: [] });
		const result = await run(deskDir);
		expect(result.skipped).toBe(false);
		expect(result.added).toEqual([]);
		expect(result.journalAppended).toBe(0);
	});
});
