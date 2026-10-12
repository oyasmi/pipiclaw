import { afterEach } from "vitest";
import { createExecutor } from "../../src/executor.js";
import { createJobRuntime } from "../../src/jobs/manager.js";
import { createSubAgentRuntime, type RunManagerOptions } from "../../src/subagents/runs.js";
import type { WorkerToolRequest } from "../../src/subagents/types.js";
import { buildToolSet } from "../../src/tools/registry.js";

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
	return {
		runManager: runs.get(channelId),
		jobManager: jobs.get(channelId),
		getRunManager: getSubAgentRunManager,
		// What `tools/index.ts` injects in production.
		buildWorkerTools: (request: WorkerToolRequest) => buildToolSet(request, { forSubagent: true }),
	};
}

afterEach(() => {
	runs.stop();
	jobs.stop();
	runs = createSubAgentRuntime();
	jobs = createJobRuntime(createExecutor());
});
