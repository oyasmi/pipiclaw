import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { isDeskName } from "../../src/desk/paths.js";
import { createExecutor } from "../../src/executor.js";
import { createJobRuntime, DeskJobManager } from "../../src/jobs/manager.js";
import { createSubAgentRuntime } from "../../src/subagents/run-registry.js";
import { type RunManagerOptions, SubAgentRunManager } from "../../src/subagents/runs.js";
import type { WorkerToolRequest } from "../../src/subagents/types.js";
import { buildToolSet } from "../../src/tools/registry.js";

/** Managers are per desk; tests key them by any label (often a channel id), mapped to a valid desk name. */
export function testDesk(key: string): string {
	if (isDeskName(key)) return key;
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
	return runs.get(testDesk(key));
}

export function restoreAllSubAgentRuns() {
	return runs.restore();
}

/**
 * Explicit test dependencies; never used by the production composition root. With `deskDir`, the
 * managers are rooted at that directory — production always roots a desk's managers at the same
 * desk directory its tools write tasks into, so a test seeding tasks there needs the same.
 */
export function testManagers(key: string = "dingtalk:dm:123", deskDir?: string) {
	if (deskDir) {
		const runManager = new SubAgentRunManager({ desk: testDesk(key), deskDir }, {});
		return {
			runManager,
			jobManager: new DeskJobManager({ desk: testDesk(key), deskDir }, createExecutor()),
			getRunManager: () => runManager,
			buildWorkerTools: (request: WorkerToolRequest) => buildToolSet(request, { forSubagent: true }),
		};
	}
	return {
		runManager: runs.get(testDesk(key)),
		jobManager: jobs.get(testDesk(key)),
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
