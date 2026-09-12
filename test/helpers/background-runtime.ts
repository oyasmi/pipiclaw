import { afterEach } from "vitest";
import { createJobRuntime } from "../../src/agent/job-manager.js";
import { createExecutor } from "../../src/executor.js";
import { createSubAgentRuntime, type RunManagerOptions } from "../../src/subagents/runs.js";

let runs = createSubAgentRuntime();
let jobs = createJobRuntime(createExecutor());

export function configureSubAgentRuntime(options: RunManagerOptions): void {
	runs.stop();
	runs = createSubAgentRuntime(options);
}

export function getSubAgentRunManager(channelId: string) {
	return runs.get(channelId);
}

export function restoreAllSubAgentRuns() {
	return runs.restore();
}

/** Explicit test dependencies; never used by the production composition root. */
export function testManagers(channelId: string = "dm_123") {
	return { runManager: runs.get(channelId), jobManager: jobs.get(channelId), getRunManager: getSubAgentRunManager };
}

afterEach(() => {
	runs.stop();
	jobs.stop();
	runs = createSubAgentRuntime();
	jobs = createJobRuntime(createExecutor());
});
