import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/memory/reflect.js", () => ({ runReflect: vi.fn() }));

import { readMemoryMaintenanceState, updateMemoryMaintenanceState } from "../src/memory/maintenance-state.js";
import { runReflect } from "../src/memory/reflect.js";
import { runReflectJob } from "../src/memory/reflect-job.js";
import { getMemoryReviewLogPath } from "../src/memory/review-log.js";
import { useTempDirs } from "./helpers/fixtures.js";

const makeTempDir = useTempDirs("pipiclaw-reflect-job-");
const TEST_MODEL = { provider: "test", id: "noop" } as never;
const messages = [
	{ role: "user", content: "Please remember the deployment decision." },
	{ role: "assistant", content: [{ type: "text", text: "Confirmed." }] },
] as never[];
const sessionEntries = [
	{ id: "entry-1", type: "message", message: messages[0] },
	{ id: "entry-2", type: "message", message: messages[1] },
] as never[];

function maintenanceSettings(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		enabled: true,
		minIdleMinutesBeforeLlmWork: 10,
		reflectIntervalMinutes: 20,
		maxConcurrentChannels: 1,
		failureBackoffMinutes: 30,
		...overrides,
	};
}

async function harness() {
	const workspaceDir = makeTempDir();
	const appHomeDir = join(workspaceDir, ".app");
	const channelDir = join(workspaceDir, "dm_1");
	return { appHomeDir, channelDir, workspaceDir };
}

const reflectResult = (overrides: Partial<Record<string, unknown>> = {}) => ({
	skipped: false,
	condensed: false,
	journalAppended: 1,
	journalSkippedDuplicate: 0,
	added: ["fact"],
	updated: [],
	deleted: [],
	touched: [],
	renamed: [],
	expiredProbation: [],
	rejected: [],
	discarded: [],
	...overrides,
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("runReflectJob", () => {
	it("skips without calling the model when the channel is not dirty", async () => {
		const { appHomeDir, channelDir, workspaceDir } = await harness();
		const result = await runReflectJob({
			appHomeDir,
			channelId: "dm_1",
			channelDir,
			workspaceDir,
			channelActive: false,
			settings: { memoryMaintenance: maintenanceSettings() },
			model: TEST_MODEL,
			resolveApiKey: async () => "",
			messages: () => messages,
			sessionEntries: () => sessionEntries,
		});
		expect(result).toMatchObject({ ran: false, skipped: true, skipReason: "clean" });
		expect(runReflect).not.toHaveBeenCalled();
		const log = readFileSync(getMemoryReviewLogPath(channelDir), "utf-8").trim();
		expect(JSON.parse(log.split("\n").at(-1) as string)).toMatchObject({ reason: "reflect" });
	});

	it("runs reflect when dirty, then advances the cursor and clears backoff", async () => {
		const { appHomeDir, channelDir, workspaceDir } = await harness();
		await updateMemoryMaintenanceState(appHomeDir, "dm_1", (state) => ({
			...state,
			dirty: true,
			failureBackoffUntil: "2026-01-01T00:00:00.000+08:00",
		}));
		vi.mocked(runReflect).mockResolvedValue(reflectResult() as never);

		const result = await runReflectJob({
			appHomeDir,
			channelId: "dm_1",
			channelDir,
			workspaceDir,
			channelActive: false,
			now: new Date("2026-04-19T12:00:00.000Z"),
			settings: { memoryMaintenance: maintenanceSettings() },
			model: TEST_MODEL,
			resolveApiKey: async () => "",
			messages: () => messages,
			sessionEntries: () => sessionEntries,
		});

		expect(result).toMatchObject({ ran: true, skipped: false });
		expect(runReflect).toHaveBeenCalledTimes(1);
		expect(vi.mocked(runReflect).mock.calls[0][0]).toMatchObject({ channelId: "dm_1", channelDir, workspaceDir });

		const state = await readMemoryMaintenanceState(appHomeDir, "dm_1");
		expect(state.lastReflectedEntryId).toBe("entry-2");
		expect(state.failureBackoffUntil).toBeNull();

		const log = readFileSync(getMemoryReviewLogPath(channelDir), "utf-8").trim();
		const entry = JSON.parse(log.split("\n").at(-1) as string);
		expect(entry.reason).toBe("reflect");
		expect(entry.actions).toEqual(
			expect.arrayContaining([expect.objectContaining({ target: "memory", action: "reflect" })]),
		);
	});

	it("does not call the model twice for the same window (idempotent cursor)", async () => {
		const { appHomeDir, channelDir, workspaceDir } = await harness();
		await updateMemoryMaintenanceState(appHomeDir, "dm_1", (state) => ({ ...state, dirty: true }));
		vi.mocked(runReflect).mockResolvedValue(reflectResult() as never);

		const input = {
			appHomeDir,
			channelId: "dm_1",
			channelDir,
			workspaceDir,
			channelActive: false,
			settings: { memoryMaintenance: maintenanceSettings({ minIdleMinutesBeforeLlmWork: 0 }) },
			model: TEST_MODEL,
			resolveApiKey: async () => "",
			messages: () => messages,
			sessionEntries: () => sessionEntries,
		};
		await runReflectJob(input);
		// The cursor now sits at entry-2; a second run against the same, unchanged session
		// entries has nothing after it and must not call the model again.
		const second = await runReflectJob({ ...input, channelActive: false });
		expect(runReflect).toHaveBeenCalledTimes(1);
		expect(second.skipped).toBe(true);
	});

	it("sets a failure backoff and logs the error when reflect throws", async () => {
		const { appHomeDir, channelDir, workspaceDir } = await harness();
		await updateMemoryMaintenanceState(appHomeDir, "dm_1", (state) => ({ ...state, dirty: true }));
		vi.mocked(runReflect).mockRejectedValue(new Error("sidecar timeout"));

		const result = await runReflectJob({
			appHomeDir,
			channelId: "dm_1",
			channelDir,
			workspaceDir,
			channelActive: false,
			now: new Date("2026-04-19T12:00:00.000Z"),
			settings: { memoryMaintenance: maintenanceSettings() },
			model: TEST_MODEL,
			resolveApiKey: async () => "",
			messages: () => messages,
			sessionEntries: () => sessionEntries,
		});

		expect(result).toMatchObject({ ran: false, skipped: false, error: expect.stringContaining("sidecar timeout") });
		const state = await readMemoryMaintenanceState(appHomeDir, "dm_1");
		expect(state.failureBackoffUntil).toBeTruthy();
		expect(new Date(state.failureBackoffUntil as string).getTime()).toBeGreaterThan(
			new Date("2026-04-19T12:00:00.000Z").getTime(),
		);

		const log = readFileSync(getMemoryReviewLogPath(channelDir), "utf-8").trim();
		const entry = JSON.parse(log.split("\n").at(-1) as string);
		expect(entry).toMatchObject({ reason: "reflect", error: expect.stringContaining("sidecar timeout") });
	});
});
