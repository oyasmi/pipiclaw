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
		failureBackoffMinutes: 30,
		...overrides,
	};
}

async function harness() {
	const workspaceDir = makeTempDir();
	const appHomeDir = join(workspaceDir, ".app");
	const dotDir = join(workspaceDir, "dm_1");
	return { appHomeDir, dotDir, workspaceDir };
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
		const { appHomeDir, dotDir, workspaceDir } = await harness();
		await runReflectJob({
			appHomeDir,
			channelId: "dm_1",
			dotDir,
			workspaceDir,
			channelActive: false,
			settings: { memoryMaintenance: maintenanceSettings() },
			model: TEST_MODEL,
			resolveApiKey: async () => "",
			messages: () => messages,
			sessionEntries: () => sessionEntries,
		});
		expect(runReflect).not.toHaveBeenCalled();
		const log = readFileSync(getMemoryReviewLogPath(dotDir), "utf-8").trim();
		expect(JSON.parse(log.split("\n").at(-1) as string)).toMatchObject({
			reason: "reflect",
			skipped: [{ target: "reflect", reason: "clean" }],
		});
	});

	it("runs reflect when dirty, then advances the cursor and clears backoff", async () => {
		const { appHomeDir, dotDir, workspaceDir } = await harness();
		await updateMemoryMaintenanceState(appHomeDir, "dm_1", (state) => ({
			...state,
			dirty: true,
			failureBackoffUntil: "2026-01-01T00:00:00.000+08:00",
		}));
		vi.mocked(runReflect).mockResolvedValue(reflectResult() as never);

		const input = {
			appHomeDir,
			channelId: "dm_1",
			dotDir,
			workspaceDir,
			channelActive: false,
			now: new Date("2026-04-19T12:00:00.000Z"),
			settings: { memoryMaintenance: maintenanceSettings() },
			model: TEST_MODEL,
			resolveApiKey: async () => "",
			messages: () => messages,
			sessionEntries: () => sessionEntries,
		};
		await runReflectJob(input);
		expect(runReflect).toHaveBeenCalledTimes(1);
		expect(vi.mocked(runReflect).mock.calls[0][0]).toMatchObject({ channelId: "dm_1", dotDir, workspaceDir });

		const state = await readMemoryMaintenanceState(appHomeDir, "dm_1");
		expect(state.lastReflectedEntryId).toBe("entry-2");
		expect(state.failureBackoffUntil).toBeNull();

		const log = readFileSync(getMemoryReviewLogPath(dotDir), "utf-8").trim();
		const entry = JSON.parse(log.split("\n").at(-1) as string);
		expect(entry.reason).toBe("reflect");
		expect(entry.actions).toEqual(
			expect.arrayContaining([expect.objectContaining({ target: "memory", action: "reflect" })]),
		);
		// Let the cheap schedule gates pass again; only the persisted cursor can suppress this window.
		await updateMemoryMaintenanceState(appHomeDir, "dm_1", (current) => ({ ...current, dirty: true }));
		await runReflectJob({ ...input, now: new Date("2026-04-19T12:30:00.000Z") });
		expect(runReflect).toHaveBeenCalledTimes(1);
		const lastSkip = JSON.parse(readFileSync(getMemoryReviewLogPath(dotDir), "utf-8").trim().split("\n").at(-1)!);
		expect(lastSkip.skipped).toEqual([{ target: "reflect", reason: "no-new-entry" }]);
	});

	it("sets a failure backoff and logs the error when reflect throws", async () => {
		const { appHomeDir, dotDir, workspaceDir } = await harness();
		await updateMemoryMaintenanceState(appHomeDir, "dm_1", (state) => ({ ...state, dirty: true }));
		vi.mocked(runReflect).mockRejectedValue(new Error("sidecar timeout"));

		await runReflectJob({
			appHomeDir,
			channelId: "dm_1",
			dotDir,
			workspaceDir,
			channelActive: false,
			now: new Date("2026-04-19T12:00:00.000Z"),
			settings: { memoryMaintenance: maintenanceSettings() },
			model: TEST_MODEL,
			resolveApiKey: async () => "",
			messages: () => messages,
			sessionEntries: () => sessionEntries,
		});
		const state = await readMemoryMaintenanceState(appHomeDir, "dm_1");
		expect(state.failureBackoffUntil).toBeTruthy();
		expect(new Date(state.failureBackoffUntil as string).getTime()).toBeGreaterThan(
			new Date("2026-04-19T12:00:00.000Z").getTime(),
		);

		const log = readFileSync(getMemoryReviewLogPath(dotDir), "utf-8").trim();
		const entry = JSON.parse(log.split("\n").at(-1) as string);
		expect(entry).toMatchObject({ reason: "reflect", error: expect.stringContaining("sidecar timeout") });
	});
});
