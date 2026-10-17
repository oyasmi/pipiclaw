import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { isDotName } from "../../src/dot/paths.js";
import { createExecutor } from "../../src/executor.js";
import { createJobRuntime, DotJobManager } from "../../src/jobs/manager.js";
import { createSubAgentRuntime } from "../../src/subagents/run-registry.js";
import { type RunManagerOptions, SubAgentRunManager } from "../../src/subagents/runs.js";
import type { WorkerToolRequest } from "../../src/subagents/types.js";
import { buildToolSet } from "../../src/tools/registry.js";

/** Managers are per dot; tests key them by any label (often a channel id), mapped to a valid dot name. */
export function testDot(key: string): string {
	if (isDotName(key)) return key;
	const slug = key
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 22);
	return `${slug || "t"}-${createHash("sha256").update(key).digest("hex").slice(0, 8)}`;
}

const TEST_WORKSPACE = join(tmpdir(), "pipiclaw-test-workspace");

let runs = createSubAgentRuntime({ workspaceDir: TEST_WORKSPACE });
let jobs = createJobRuntime(createExecutor(), { workspaceDir: TEST_WORKSPACE });

export function configureSubAgentRuntime(options: RunManagerOptions & { workspaceDir?: string }): void {
	runs.stop();
	runs = createSubAgentRuntime({ workspaceDir: TEST_WORKSPACE, ...options });
}

export function getSubAgentRunManager(key: string) {
	return runs.get(testDot(key));
}

export function restoreAllSubAgentRuns() {
	return runs.restore();
}

/**
 * Explicit test dependencies; never used by the production composition root. With `dotDir`, the
 * managers are rooted at that directory — production always roots a dot's managers at the same
 * dot directory its tools write tasks into, so a test seeding tasks there needs the same.
 */
export function testManagers(key: string = "dm_123", dotDir?: string) {
	if (dotDir) {
		const runManager = new SubAgentRunManager({ dot: testDot(key), dotDir }, {});
		return {
			runManager,
			jobManager: new DotJobManager({ dot: testDot(key), dotDir }, createExecutor()),
			getRunManager: () => runManager,
			buildWorkerTools: (request: WorkerToolRequest) => buildToolSet(request, { forSubagent: true }),
		};
	}
	return {
		runManager: runs.get(testDot(key)),
		jobManager: jobs.get(testDot(key)),
		getRunManager: getSubAgentRunManager,
		// What `tools/index.ts` injects in production.
		buildWorkerTools: (request: WorkerToolRequest) => buildToolSet(request, { forSubagent: true }),
	};
}

afterEach(() => {
	runs.stop();
	jobs.stop();
	runs = createSubAgentRuntime({ workspaceDir: TEST_WORKSPACE });
	jobs = createJobRuntime(createExecutor(), { workspaceDir: TEST_WORKSPACE });
});
