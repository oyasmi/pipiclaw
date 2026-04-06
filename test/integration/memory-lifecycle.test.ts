import { readFileSync, rmSync } from "fs";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/memory/sidecar-worker.js", () => ({
	runSidecarTask: vi.fn(),
	runRetriedSidecarTask: vi.fn(),
	SidecarParseError: class SidecarParseError extends Error {
		readonly taskName: string;
		readonly rawText: string;

		constructor(taskName: string, rawText: string, cause: unknown) {
			super(`Sidecar task "${taskName}" returned invalid output`);
			this.name = "SidecarParseError";
			this.taskName = taskName;
			this.rawText = rawText;
			this.cause = cause;
		}
	},
}));

import { readChannelHistory, readChannelMemory, readChannelSession } from "../../src/memory/files.js";
import { MemoryLifecycle } from "../../src/memory/lifecycle.js";
import { runRetriedSidecarTask, runSidecarTask } from "../../src/memory/sidecar-worker.js";
import { createTempWorkspace, setupChannelFiles } from "../helpers/fixtures.js";

const tempDirs: string[] = [];
const TEST_MODEL = { provider: "test", id: "noop" } as never;

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

function createLifecycleHarness(settings?: Partial<ReturnType<typeof createSettings>>) {
	const workspaceDir = createTempWorkspace("pipiclaw-memory-lifecycle-");
	const channelDir = join(workspaceDir, "dm_123");
	tempDirs.push(workspaceDir);
	setupChannelFiles(channelDir, {
		session: "# Session Title\n\nLegacy task\n",
		memory: "# Channel Memory\n\n## Constraints\n\n- Keep schema stable.\n",
		history: "# Channel History\n",
	});

	const messages = [
		{ role: "user", content: "Please fix the login callback regression." },
		{ role: "assistant", content: [{ type: "text", text: "Tracing the callback state flow in src/auth.ts." }] },
	] as never[];
	const sessionEntries = [] as never[];

	const lifecycle = new MemoryLifecycle({
		channelId: "dm_123",
		channelDir,
		getMessages: () => messages,
		getSessionEntries: () => sessionEntries,
		getModel: () => TEST_MODEL,
		resolveApiKey: async () => "",
		getSessionMemorySettings: () => createSettings(settings),
	});
	const fakePi = createFakePi();
	lifecycle.createExtensionFactory()(fakePi.api as never);

	return {
		channelDir,
		fakePi,
		lifecycle,
		messages,
		sessionEntries,
	};
}

function createSettings(
	overrides: Partial<{
		enabled: boolean;
		minTurnsBetweenUpdate: number;
		minToolCallsBetweenUpdate: number;
		timeoutMs: number;
		failureBackoffTurns: number;
		forceRefreshBeforeCompact: boolean;
		forceRefreshBeforeNewSession: boolean;
	}> = {},
) {
	return {
		enabled: true,
		minTurnsBetweenUpdate: 2,
		minToolCallsBetweenUpdate: 2,
		timeoutMs: 30000,
		failureBackoffTurns: 3,
		forceRefreshBeforeCompact: true,
		forceRefreshBeforeNewSession: true,
		...overrides,
	};
}

afterEach(() => {
	vi.useRealTimers();
	vi.resetAllMocks();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("memory-lifecycle integration", () => {
	it("updates SESSION.md after the configured turn threshold", async () => {
		const { channelDir, lifecycle } = createLifecycleHarness({
			minTurnsBetweenUpdate: 2,
			minToolCallsBetweenUpdate: 99,
			forceRefreshBeforeCompact: false,
			forceRefreshBeforeNewSession: false,
		});
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

		lifecycle.noteCompletedAssistantTurn();
		lifecycle.noteCompletedAssistantTurn();

		await waitForAssertion(() => {
			const session = readFileSync(join(channelDir, "SESSION.md"), "utf-8");
			expect(session).toContain("Fix login regression");
			expect(session).toContain("Investigating callback state flow.");
		});
		expect(runRetriedSidecarTask).toHaveBeenCalledTimes(1);
	});

	it("persists durable memory after the conversation goes idle", async () => {
		vi.useFakeTimers();
		const { channelDir, lifecycle } = createLifecycleHarness({
			minTurnsBetweenUpdate: 99,
			minToolCallsBetweenUpdate: 99,
			forceRefreshBeforeCompact: false,
			forceRefreshBeforeNewSession: false,
		});
		vi.mocked(runRetriedSidecarTask).mockImplementation(async (task) => {
			if (task.name === "memory-inline-consolidation") {
				return {
					rawText:
						'{"memoryEntries":["Callback verification must remain backwards-compatible"],"historyBlock":"- Investigated callback verification flow."}',
					output:
						'{"memoryEntries":["Callback verification must remain backwards-compatible"],"historyBlock":"- Investigated callback verification flow."}',
				};
			}
			throw new Error(`Unexpected sidecar task ${task.name}`);
		});

		lifecycle.noteCompletedAssistantTurn();
		await vi.advanceTimersByTimeAsync(60_000);
		vi.useRealTimers();

		await waitForAssertion(async () => {
			expect(await readChannelMemory(channelDir)).toContain(
				"Callback verification must remain backwards-compatible",
			);
			expect(await readChannelHistory(channelDir)).toContain("Investigated callback verification flow.");
		});
	});

	it("updates SESSION.md after the configured tool-call threshold and resets the counters", async () => {
		const { channelDir, lifecycle } = createLifecycleHarness({
			minTurnsBetweenUpdate: 99,
			minToolCallsBetweenUpdate: 2,
			forceRefreshBeforeCompact: false,
			forceRefreshBeforeNewSession: false,
		});
		vi.mocked(runRetriedSidecarTask).mockResolvedValue({
			rawText: "{}",
			output: {
				title: "Fix login regression",
				currentState: ["Checked callback state serialization."],
			},
		});

		lifecycle.noteToolCall();
		lifecycle.noteToolCall();
		lifecycle.noteCompletedAssistantTurn();

		await waitForAssertion(() => {
			expect(readFileSync(join(channelDir, "SESSION.md"), "utf-8")).toContain(
				"Checked callback state serialization.",
			);
		});

		lifecycle.noteCompletedAssistantTurn();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(runRetriedSidecarTask).toHaveBeenCalledTimes(1);
		expect(await readChannelSession(channelDir)).toContain("Checked callback state serialization.");
	});

	it("runs the compaction chain in order: session refresh, memory append, history append", async () => {
		const { channelDir, fakePi } = createLifecycleHarness();
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
				return {
					rawText:
						'{"memoryEntries":["Callback verification must stay backwards-compatible"],"historyBlock":"- Compacted recent debugging work."}',
					output:
						'{"memoryEntries":["Callback verification must stay backwards-compatible"],"historyBlock":"- Compacted recent debugging work."}',
				};
			}
			throw new Error(`Unexpected sidecar task ${task.name}`);
		});

		await fakePi.handlers.get("session_before_compact")?.({
			preparation: {
				messagesToSummarize: [
					{ role: "user", content: "Please fix the login callback regression." },
					{ role: "assistant", content: [{ type: "text", text: "Tracing the callback state flow." }] },
				],
			},
		});

		await waitForAssertion(async () => {
			expect(await readChannelSession(channelDir)).toContain("Investigating callback regression.");
			expect(await readChannelMemory(channelDir)).toContain("Callback verification must stay backwards-compatible");
			expect(await readChannelHistory(channelDir)).toContain("Compacted recent debugging work.");
			const taskNames = vi.mocked(runRetriedSidecarTask).mock.calls.map(([task]) => task.name);
			expect(taskNames).toEqual(["session-memory-update", "memory-inline-consolidation"]);
		});
	});

	it("runs background maintenance after compaction using the real file writers", async () => {
		const { channelDir, fakePi } = createLifecycleHarness({
			forceRefreshBeforeCompact: false,
			forceRefreshBeforeNewSession: false,
		});
		setupChannelFiles(channelDir, {
			session: "# Session Title\n\nFix login regression\n",
			memory: [
				"# Channel Memory",
				"",
				...Array.from({ length: 6 }, (_, index) =>
					[`## Update 2026-04-0${index + 1}`, `- Fact ${index + 1}`, ""].join("\n"),
				),
			].join("\n"),
			history: [
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
			].join("\n"),
		});
		vi.mocked(runSidecarTask).mockImplementation(async (task) => {
			if (task.name === "memory-cleanup") {
				return {
					rawText: "## Decisions\n\n- Keep the callback interface stable.\n",
					output: "## Decisions\n\n- Keep the callback interface stable.\n",
				};
			}
			if (task.name === "history-folding") {
				return {
					rawText: "- Folded early history.",
					output: "- Folded early history.",
				};
			}
			throw new Error(`Unexpected sidecar task ${task.name}`);
		});

		fakePi.handlers.get("session_compact")?.({});

		await waitForAssertion(() => {
			expect(readFileSync(join(channelDir, "MEMORY.md"), "utf-8")).toContain("Keep the callback interface stable.");
			expect(readFileSync(join(channelDir, "HISTORY.md"), "utf-8")).toContain("Folded early history.");
		});
	});

	it("continues consolidation even when the forced session refresh fails", async () => {
		const { channelDir, fakePi } = createLifecycleHarness();
		vi.mocked(runRetriedSidecarTask).mockImplementation(async (task) => {
			if (task.name === "session-memory-update") {
				throw new Error("session update timeout");
			}
			if (task.name === "memory-inline-consolidation") {
				return {
					rawText: '{"memoryEntries":["Callback retry loop masked the root cause"],"historyBlock":""}',
					output: '{"memoryEntries":["Callback retry loop masked the root cause"],"historyBlock":""}',
				};
			}
			throw new Error(`Unexpected sidecar task ${task.name}`);
		});

		await expect(
			fakePi.handlers.get("session_before_compact")?.({
				preparation: {
					messagesToSummarize: [
						{ role: "user", content: "Please fix the login callback regression." },
						{ role: "assistant", content: [{ type: "text", text: "Tracing the callback state flow." }] },
					],
				},
			}),
		).resolves.toBeUndefined();

		await waitForAssertion(async () => {
			expect(await readChannelMemory(channelDir)).toContain("Callback retry loop masked the root cause");
			expect(await readChannelSession(channelDir)).toContain("Legacy task");
		});
	});
});
