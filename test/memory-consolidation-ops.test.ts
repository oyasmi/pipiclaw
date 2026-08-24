import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/memory/sidecar-worker.js", () => ({
	runSidecarTask: vi.fn(),
	runRetriedSidecarTask: vi.fn(),
	SidecarParseError: class SidecarParseError extends Error {},
}));

import { join } from "path";
import {
	cleanupChannelMemory,
	foldChannelHistory,
	MemoryCleanupRejectedError,
	runInlineConsolidation,
} from "../src/memory/consolidation.js";
import {
	applyChannelMemoryOps,
	parseChannelMemoryEntries,
	readChannelHistory,
	readChannelMemory,
	readChannelSession,
} from "../src/memory/files.js";
import { MemoryLifecycle } from "../src/memory/lifecycle.js";
import { runMemoryCheckpointJob, runSessionRefreshJob } from "../src/memory/maintenance-jobs.js";
import { updateMemoryMaintenanceState } from "../src/memory/maintenance-state.js";
import { readMemoryMetadata, syncMemoryMetadata } from "../src/memory/metadata.js";
import { runRetriedSidecarTask, runSidecarTask } from "../src/memory/sidecar-worker.js";
import { setupChannelFiles, useTempDirs } from "./helpers/fixtures.js";

const createTempChannel = useTempDirs("pipiclaw-consol-ops-");

afterEach(() => {
	vi.clearAllMocks();
});

const fakeModel = { id: "test" } as never;
const resolveApiKey = async () => "key";

/**
 * Mirror what the real sidecar returns: it runs the task's own `parse` over the model text,
 * so the mock exercises the shared extraction parser instead of hand-rolling its output.
 */
function sidecarResultFor(task: { parse: (text: string) => unknown }, json: string) {
	return { rawText: json, output: task.parse(json) } as never;
}

/** memoryOps only reach MEMORY.md when they clear the shared auto-write bar. */
function durableOp(content: string, extra: Record<string, unknown> = {}) {
	return { op: "add", content, kind: "fact", confidence: 0.95, necessity: "high", reason: "test", ...extra };
}

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

describe("background structural maintenance", () => {
	it("rewrites oversized memory and folds older history blocks against the real channel files", async () => {
		const channelDir = createTempChannel();
		const memory = [
			"# Channel Memory",
			"",
			...Array.from({ length: 6 }, (_, index) =>
				[`## Update 2026-04-0${index + 1}`, `- Fact ${index + 1}`, ""].join("\n"),
			),
		].join("\n");
		const history = [
			"# Channel History",
			"",
			...Array.from({ length: 9 }, (_, index) =>
				[
					`## 2026-04-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
					"",
					`History block ${index + 1}`,
					"",
				].join("\n"),
			),
		].join("\n");
		setupChannelFiles(channelDir, { memory, history, session: "# Session Title\n\nTask\n" });

		vi.mocked(runSidecarTask)
			.mockResolvedValueOnce({
				rawText: "# Channel Memory\n\n## Update 2026-04-01\n\n- Fact 1\n",
				output: "# Channel Memory\n\n## Update 2026-04-01\n\n- Fact 1\n",
			})
			.mockResolvedValueOnce({
				rawText: "- Folded blocks 1 through 5.",
				output: "- Folded blocks 1 through 5.",
			});

		const options = { channelDir, model: fakeModel, resolveApiKey, messages: [] };
		const cleanup = await cleanupChannelMemory(options, await readChannelMemory(channelDir));
		const foldedHistory = await foldChannelHistory(options, await readChannelHistory(channelDir));

		expect({ cleanedMemory: cleanup.rewritten, foldedHistory }).toEqual({ cleanedMemory: true, foldedHistory: true });
		expect(await readChannelMemory(channelDir)).toContain("Fact 1");

		const nextHistory = await readChannelHistory(channelDir);
		expect(nextHistory).toContain("## Folded History Through 2026-04-06T00:00:00.000Z");
		expect(nextHistory).toContain("Folded blocks 1 through 5.");
		expect(nextHistory).toContain("History block 9");
		expect(nextHistory).not.toContain("History block 1");
	});
});

describe("runInlineConsolidation gating and windows", () => {
	it("skips short transcripts, omits the history block during idle mode, and prompts only past the latest compaction boundary", async () => {
		// Too few meaningful messages → skipped without any sidecar work.
		const shortDir = createTempChannel();
		setupChannelFiles(shortDir);

		const skipped = await runInlineConsolidation({
			channelDir: shortDir,
			model: fakeModel,
			resolveApiKey,
			messages: [{ role: "user", content: "ping" }] as never[],
		});

		expect(skipped).toEqual({
			skipped: true,
			appendedMemoryEntries: 0,
			appendedDurableEntries: 0,
			appendedProbationaryEntries: 0,
			appendedHistoryBlock: false,
			rejectedMemoryOps: [],
		});
		expect(runSidecarTask).not.toHaveBeenCalled();
		expect(runRetriedSidecarTask).not.toHaveBeenCalled();

		// Idle mode persists durable ops but never appends the history block.
		vi.mocked(runRetriedSidecarTask).mockClear();
		const idleDir = createTempChannel();
		setupChannelFiles(idleDir, {
			memory: "# Channel Memory\n",
			session: "# Session Title\n\nFix login regression\n",
			history: "# Channel History\n",
		});
		vi.mocked(runRetriedSidecarTask).mockImplementation(async (task) =>
			sidecarResultFor(
				task,
				JSON.stringify({
					memoryOps: [durableOp("OAuth callback regression is a durable channel issue")],
					historyBlock: "- Should be ignored during idle.",
				}),
			),
		);

		const idle = await runInlineConsolidation({
			channelDir: idleDir,
			model: fakeModel,
			resolveApiKey,
			messages,
			mode: "idle",
		});

		expect(idle.skipped).toBe(false);
		expect(idle.appendedMemoryEntries).toBe(1);
		expect(idle.appendedHistoryBlock).toBe(false);
		expect(await readChannelMemory(idleDir)).toContain("OAuth callback regression is a durable channel issue");
		expect(await readChannelHistory(idleDir)).not.toContain("Should be ignored during idle.");

		// Provided session entries are cut at the latest compaction boundary before prompting.
		vi.mocked(runRetriedSidecarTask).mockClear();
		const boundaryDir = createTempChannel();
		setupChannelFiles(boundaryDir);
		vi.mocked(runRetriedSidecarTask).mockImplementation(async (task) => {
			expect(task.prompt).toContain("after boundary");
			expect(task.prompt).not.toContain("before boundary");
			return sidecarResultFor(
				task,
				JSON.stringify({ memoryOps: [durableOp("Recovered after compaction")], historyBlock: "" }),
			);
		});

		await runInlineConsolidation({
			channelDir: boundaryDir,
			model: fakeModel,
			resolveApiKey,
			messages: [],
			sessionEntries: [
				{
					type: "message",
					id: "msg-1",
					timestamp: "2026-04-01T00:00:00.000Z",
					message: { role: "user", content: "before boundary" },
				},
				{
					type: "compaction",
					id: "cmp-1",
					timestamp: "2026-04-01T00:05:00.000Z",
					parentId: "msg-1",
					summary: "trimmed",
					firstKeptEntryId: "msg-2",
					tokensBefore: 1234,
				},
				{
					type: "message",
					id: "msg-2",
					timestamp: "2026-04-01T00:06:00.000Z",
					message: { role: "user", content: "after boundary" },
				},
				{
					type: "message",
					id: "msg-3",
					timestamp: "2026-04-01T00:07:00.000Z",
					message: { role: "assistant", content: [{ type: "text", text: "Investigating the kept branch." }] },
				},
			] as never,
		});

		expect(runRetriedSidecarTask).toHaveBeenCalledTimes(1);
	});
});

describe("scheduled maintenance jobs", () => {
	const jobMessages = [
		{ role: "user", content: "Please fix the login callback regression." },
		{ role: "assistant", content: [{ type: "text", text: "Tracing the callback state flow in src/auth.ts." }] },
	] as never[];
	const jobSessionEntries = [
		{ id: "entry-1", type: "message", message: jobMessages[0] },
		{ id: "entry-2", type: "message", message: jobMessages[1] },
	] as never[];

	function createJobSettings() {
		return {
			sessionMemory: {
				enabled: true,
				minTurnsBetweenUpdate: 2,
				minToolCallsBetweenUpdate: 99,
				timeoutMs: 30000,
				forceRefreshBeforeCompact: false,
				forceRefreshBeforeNewSession: false,
			},
			memoryMaintenance: {
				enabled: true,
				minIdleMinutesBeforeLlmWork: 0,
				sessionRefreshIntervalMinutes: 0,
				checkpointIntervalMinutes: 0,
				minMemoryAutoWriteConfidence: 0.85,
				structuralMaintenanceIntervalHours: 0,
				maxConcurrentChannels: 1,
				failureBackoffMinutes: 30,
				cleanupShrinkGuardMinRatio: 0.4,
				cleanupShrinkGuardMinChars: 2_000,
			},
		};
	}

	async function createJobWorkspace(): Promise<{ appHomeDir: string; channelDir: string }> {
		const workspaceDir = createTempChannel();
		const appHomeDir = join(workspaceDir, ".app");
		const channelDir = join(workspaceDir, "dm_123");
		setupChannelFiles(channelDir, {
			session: "# Session Title\n\nLegacy task\n",
			memory: "# Channel Memory\n\n## Constraints\n\n- Keep schema stable.\n",
			history: "# Channel History\n",
		});
		return { appHomeDir, channelDir };
	}

	it("applies scheduled job outputs to the real channel files: SESSION.md refresh and durable memory checkpoint", async () => {
		// The session refresh job writes the sidecar's structured output into SESSION.md.
		const refresh = await createJobWorkspace();
		vi.mocked(runRetriedSidecarTask).mockImplementation(async (task) => {
			expect(task.name).toBe("session-memory-update");
			return {
				rawText: "{}",
				output: {
					title: "Fix login regression",
					currentState: ["Investigating callback state flow."],
					nextSteps: ["Reproduce the callback failure locally."],
				},
			};
		});

		await updateMemoryMaintenanceState(refresh.appHomeDir, "dm_123", (state) => ({
			...state,
			dirty: true,
			turnsSinceSessionRefresh: 2,
		}));
		await runSessionRefreshJob({
			appHomeDir: refresh.appHomeDir,
			channelId: "dm_123",
			channelDir: refresh.channelDir,
			channelActive: false,
			settings: createJobSettings(),
			model: fakeModel,
			resolveApiKey,
			messages: () => jobMessages,
			sessionEntries: () => jobSessionEntries,
		});

		const session = await readChannelSession(refresh.channelDir);
		expect(session).toContain("Fix login regression");
		expect(session).toContain("Investigating callback state flow.");
		expect(runRetriedSidecarTask).toHaveBeenCalledTimes(1);
		vi.mocked(runRetriedSidecarTask).mockClear();

		// The memory checkpoint job persists durable ops but drops the history block.
		const checkpoint = await createJobWorkspace();
		vi.mocked(runRetriedSidecarTask).mockImplementation(async (task) => {
			if (task.name === "memory-inline-consolidation") {
				return sidecarResultFor(
					task,
					JSON.stringify({
						memoryOps: [durableOp("Callback verification must remain backwards-compatible")],
						historyBlock: "- Investigated callback verification flow.",
					}),
				);
			}
			throw new Error(`Unexpected sidecar task ${task.name}`);
		});

		await updateMemoryMaintenanceState(checkpoint.appHomeDir, "dm_123", (state) => ({
			...state,
			dirty: true,
		}));
		await runMemoryCheckpointJob({
			appHomeDir: checkpoint.appHomeDir,
			channelId: "dm_123",
			channelDir: checkpoint.channelDir,
			channelActive: false,
			settings: createJobSettings(),
			model: fakeModel,
			resolveApiKey,
			messages: () => jobMessages,
			sessionEntries: () => jobSessionEntries,
		});

		expect(await readChannelMemory(checkpoint.channelDir)).toContain(
			"Callback verification must remain backwards-compatible",
		);
		expect(await readChannelHistory(checkpoint.channelDir)).not.toContain("Investigated callback verification flow.");
	});
});

describe("memory lifecycle compaction chain", () => {
	function createFakePi() {
		const handlers = new Map<string, (event: unknown) => Promise<void> | void>();
		return {
			api: {
				on(eventName: string, handler: (event: unknown) => Promise<void> | void) {
					handlers.set(eventName, handler);
				},
			},
			handlers,
		};
	}

	async function waitForAssertion(assertion: () => void | Promise<void>): Promise<void> {
		let lastError: unknown;
		for (let attempt = 0; attempt < 40; attempt++) {
			try {
				await assertion();
				return;
			} catch (error) {
				lastError = error;
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
		}
		throw lastError;
	}

	function createLifecycleHarness() {
		const channelDir = createTempChannel();
		setupChannelFiles(channelDir, {
			session: "# Session Title\n\nLegacy task\n",
			memory: "# Channel Memory\n\n## Constraints\n\n- Keep schema stable.\n",
			history: "# Channel History\n",
		});

		const harnessMessages = [
			{ role: "user", content: "Please fix the login callback regression." },
			{ role: "assistant", content: [{ type: "text", text: "Tracing the callback state flow in src/auth.ts." }] },
		] as never[];
		const harnessEntries = [
			{ id: "entry-1", type: "message", message: harnessMessages[0] },
			{ id: "entry-2", type: "message", message: harnessMessages[1] },
		] as never[];

		const lifecycle = new MemoryLifecycle({
			channelId: "dm_123",
			channelDir,
			getMessages: () => harnessMessages,
			getSessionEntries: () => harnessEntries,
			getModel: () => fakeModel,
			resolveApiKey,
			getSessionMemorySettings: () => ({
				enabled: true,
				minTurnsBetweenUpdate: 2,
				minToolCallsBetweenUpdate: 2,
				timeoutMs: 30000,
				forceRefreshBeforeCompact: true,
				forceRefreshBeforeNewSession: true,
			}),
		});
		const fakePi = createFakePi();
		lifecycle.createExtensionFactory()(fakePi.api as never);

		return { channelDir, fakePi };
	}

	const compactionEvent = {
		preparation: {
			messagesToSummarize: [
				{ role: "user", content: "Please fix the login callback regression." },
				{ role: "assistant", content: [{ type: "text", text: "Tracing the callback state flow." }] },
			],
		},
	};

	it("runs the compaction chain in order — session refresh, memory append, history append — and still consolidates when the refresh fails", async () => {
		// Happy path: every stage lands in its file, in sidecar-task order.
		const happy = createLifecycleHarness();
		vi.mocked(runRetriedSidecarTask).mockImplementation(async (task) => {
			if (task.name === "session-memory-update") {
				return {
					rawText: "{}",
					output: {
						title: "Fix login regression",
						currentState: ["Investigating callback regression."],
						nextSteps: ["Patch callback verification."],
					},
				};
			}
			if (task.name === "memory-inline-consolidation") {
				return sidecarResultFor(
					task,
					JSON.stringify({
						memoryOps: [durableOp("Callback verification must stay backwards-compatible")],
						historyBlock: "- Compacted recent debugging work.",
					}),
				);
			}
			throw new Error(`Unexpected sidecar task ${task.name}`);
		});

		await happy.fakePi.handlers.get("session_before_compact")?.(compactionEvent);

		await waitForAssertion(async () => {
			expect(await readChannelSession(happy.channelDir)).toContain("Investigating callback regression.");
			expect(await readChannelMemory(happy.channelDir)).toContain(
				"Callback verification must stay backwards-compatible",
			);
			expect(await readChannelHistory(happy.channelDir)).toContain("Compacted recent debugging work.");
			const taskNames = vi.mocked(runRetriedSidecarTask).mock.calls.map(([task]) => task.name);
			expect(taskNames).toEqual(["session-memory-update", "memory-inline-consolidation"]);
		});

		// A failing forced session refresh does not sink consolidation.
		vi.mocked(runRetriedSidecarTask).mockClear();
		const resilient = createLifecycleHarness();
		vi.mocked(runRetriedSidecarTask).mockImplementation(async (task) => {
			if (task.name === "session-memory-update") {
				throw new Error("session update timeout");
			}
			if (task.name === "memory-inline-consolidation") {
				return sidecarResultFor(
					task,
					JSON.stringify({
						memoryOps: [durableOp("Callback retry loop masked the root cause")],
						historyBlock: "",
					}),
				);
			}
			throw new Error(`Unexpected sidecar task ${task.name}`);
		});

		await expect(resilient.fakePi.handlers.get("session_before_compact")?.(compactionEvent)).resolves.toBeUndefined();

		await waitForAssertion(async () => {
			expect(await readChannelMemory(resilient.channelDir)).toContain("Callback retry loop masked the root cause");
			expect(await readChannelSession(resilient.channelDir)).toContain("Legacy task");
		});
	});
});
