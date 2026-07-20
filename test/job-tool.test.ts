import { describe, expect, it } from "vitest";
import type { ChannelJobManager, JobSnapshot } from "../src/agent/job-manager.js";
import { createJobTool } from "../src/tools/job.js";

function snapshot(overrides: Partial<JobSnapshot> = {}): JobSnapshot {
	return {
		id: "abc123",
		label: "task",
		command: "sleep 5",
		status: "running",
		startedAt: Date.now(),
		durationMs: 5000,
		...overrides,
	};
}

function stubManager(overrides: Partial<ChannelJobManager>): ChannelJobManager {
	return overrides as ChannelJobManager;
}

async function runText(tool: ReturnType<typeof createJobTool>, args: Record<string, unknown>): Promise<string> {
	const result = await tool.execute("call", { label: "check", ...args } as never);
	return result.content[0].type === "text" ? result.content[0].text : "";
}

describe("job tool", () => {
	it("lists jobs as a snapshot", async () => {
		const tool = createJobTool({
			jobManager: stubManager({
				list: async () => [snapshot({ id: "j1", label: "build", status: "running" })],
			}),
		});
		const text = await runText(tool, { op: "list" });
		expect(text).toContain("[j1] build — running");
	});

	it("reports an empty job list", async () => {
		const tool = createJobTool({ jobManager: stubManager({ list: async () => [] }) });
		expect(await runText(tool, { op: "list" })).toContain("No background jobs");
	});

	it("shows finished job output and still-running jobs on poll", async () => {
		const tool = createJobTool({
			jobManager: stubManager({
				poll: async () => [
					snapshot({ id: "done1", status: "completed", exitCode: 0 }),
					snapshot({ id: "run1", status: "running" }),
				],
				readOutput: async () => ({ spillFile: "/tmp/pipiclaw-job-done1.log", text: "build succeeded" }),
			}),
		});
		const text = await runText(tool, { op: "poll" });
		expect(text).toContain("Finished (1)");
		expect(text).toContain("build succeeded");
		expect(text).toContain("Full output: /tmp/pipiclaw-job-done1.log");
		expect(text).toContain("Still running (1)");
		// Waiting for a job is a runtime guarantee now, not a check-in the model has to arrange.
		expect(text).toContain("you are woken when the job finishes");
		expect(text).not.toContain("event_manage");
	});

	it("reports cancel outcomes", async () => {
		const tool = createJobTool({
			jobManager: stubManager({
				cancel: async (ids) => ids.map((id) => ({ id, status: "cancelled" as const })),
			}),
		});
		const text = await runText(tool, { op: "cancel", ids: ["j1"] });
		expect(text).toContain("[j1] cancelled");
	});

	it("requires ids for cancel", async () => {
		const tool = createJobTool({ jobManager: stubManager({}) });
		await expect(runText(tool, { op: "cancel" })).rejects.toThrow(/requires at least one job id/);
	});

	it("reports when there are no jobs to poll", async () => {
		const tool = createJobTool({ jobManager: stubManager({ poll: async () => [] }) });
		expect(await runText(tool, { op: "poll" })).toContain("No matching running jobs");
	});
});
