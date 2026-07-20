import { readFileSync } from "fs";
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
import { runDurableConsolidationJob, runSessionRefreshJob } from "../../src/memory/maintenance-jobs.js";
import { updateMemoryMaintenanceState } from "../../src/memory/maintenance-state.js";
import { runRetriedSidecarTask } from "../../src/memory/sidecar-worker.js";
import { setupChannelFiles, useTempDirs } from "../helpers/fixtures.js";

const makeWorkspace = useTempDirs("pipiclaw-memory-lifecycle-");
const TEST_MODEL = { provider: "test", id: "noop" } as never;

/**
 * Mirror what the real sidecar returns: it runs the task's own `parse` over the model text,
 * so the mock exercises the shared extraction parser instead of hand-rolling its output.
 */
function sidecarResultFor(task: { parse: (text: string) => unknown }, json: string) {
	return { rawText: json, output: task.parse(json) } as never;
}

/** memoryOps only reach MEMORY.md when they clear the shared auto-write bar. */
function durableOp(content: string) {
	return { op: "add", content, kind: "fact", confidence: 0.95, necessity: "high", reason: "test" };
}

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
	const workspaceDir = makeWorkspace();
	const appHomeDir = join(workspaceDir, ".app");
	const channelDir = join(workspaceDir, "dm_123");
	setupChannelFiles(channelDir, {
		session: "# Session Title\n\nLegacy task\n",
		memory: "# Channel Memory\n\n## Constraints\n\n- Keep schema stable.\n",
		history: "# Channel History\n",
	});

	const messages = [
		{ role: "user", content: "Please fix the login callback regression." },
		{ role: "assistant", content: [{ type: "text", text: "Tracing the callback state flow in src/auth.ts." }] },
	] as never[];
	const sessionEntries = [
		{ id: "entry-1", type: "message", message: messages[0] },
		{ id: "entry-2", type: "message", message: messages[1] },
	] as never[];

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
		appHomeDir,
		channelDir,
		fakePi,
		lifecycle,
		messages,
		sessionEntries,
	};
}

function createMaintenanceSettings(settings?: Partial<ReturnType<typeof createSettings>>) {
	return {
		sessionMemory: createSettings(settings),
		memoryGrowth: {
			postTurnReviewEnabled: true,
			autoWriteChannelMemory: true,
			autoWriteWorkspaceSkills: false,
			minSkillAutoWriteConfidence: 0.9,
			minMemoryAutoWriteConfidence: 0.85,
			idleWritesHistory: false,
			minTurnsBetweenReview: 12,
			minToolCallsBetweenReview: 24,
		},
		memoryMaintenance: {
			enabled: true,
			minIdleMinutesBeforeLlmWork: 0,
			sessionRefreshIntervalMinutes: 0,
			durableConsolidationIntervalMinutes: 0,
			growthReviewIntervalMinutes: 0,
			structuralMaintenanceIntervalHours: 0,
			maxConcurrentChannels: 1,
			failureBackoffMinutes: 30,
			cleanupShrinkGuardMinRatio: 0.4,
			cleanupShrinkGuardMinChars: 2_000,
		},
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
});

describe("memory-lifecycle integration", () => {
	it("updates SESSION.md from the scheduled session refresh job", async () => {
		const { appHomeDir, channelDir, messages, sessionEntries } = createLifecycleHarness({
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

		await updateMemoryMaintenanceState(appHomeDir, "dm_123", (state) => ({
			...state,
			dirty: true,
			turnsSinceSessionRefresh: 2,
		}));
		await runSessionRefreshJob({
			appHomeDir,
			channelId: "dm_123",
			channelDir,
			channelActive: false,
			settings: createMaintenanceSettings({
				minTurnsBetweenUpdate: 2,
				minToolCallsBetweenUpdate: 99,
			}),
			model: TEST_MODEL,
			resolveApiKey: async () => "",
			messages,
			sessionEntries,
		});

		const session = readFileSync(join(channelDir, "SESSION.md"), "utf-8");
		expect(session).toContain("Fix login regression");
		expect(session).toContain("Investigating callback state flow.");
		expect(runRetriedSidecarTask).toHaveBeenCalledTimes(1);
	});

	it("persists durable memory from the scheduled durable consolidation job", async () => {
		const { appHomeDir, channelDir, messages, sessionEntries } = createLifecycleHarness({
			minTurnsBetweenUpdate: 99,
			minToolCallsBetweenUpdate: 99,
			forceRefreshBeforeCompact: false,
			forceRefreshBeforeNewSession: false,
		});
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

		await updateMemoryMaintenanceState(appHomeDir, "dm_123", (state) => ({
			...state,
			dirty: true,
		}));
		await runDurableConsolidationJob({
			appHomeDir,
			channelId: "dm_123",
			channelDir,
			channelActive: false,
			settings: createMaintenanceSettings(),
			model: TEST_MODEL,
			resolveApiKey: async () => "",
			messages,
			sessionEntries,
		});

		expect(await readChannelMemory(channelDir)).toContain("Callback verification must remain backwards-compatible");
		expect(await readChannelHistory(channelDir)).not.toContain("Investigated callback verification flow.");
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

	it("continues consolidation even when the forced session refresh fails", async () => {
		const { channelDir, fakePi } = createLifecycleHarness();
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
