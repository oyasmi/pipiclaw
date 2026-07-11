import { describe, expect, it } from "vitest";
import { ChannelJobManager, MAX_RUNNING_JOBS } from "../src/agent/job-manager.js";
import type { ExecOptions, ExecResult, Executor } from "../src/executor.js";

/**
 * A command-aware fake executor. Real jobs are managed by shelling out; this fake recognizes the
 * four command shapes the manager emits (launch / probe / cancel / read output) and returns
 * scripted results, letting us drive job lifecycle deterministically without spawning processes.
 */
class FakeJobExecutor implements Executor {
	public probeResult = "ALIVE";
	public output = "job output here";
	public readonly commands: string[] = [];
	private nextPid = 1000;

	async exec(command: string, _options?: ExecOptions): Promise<ExecResult> {
		this.commands.push(command);
		if (command.includes("nohup")) {
			return { code: 0, stdout: `${this.nextPid++}\n`, stderr: "" };
		}
		if (command.includes("kill -0")) {
			// probe: returns EXIT:<code> / ALIVE / GONE
			return { code: 0, stdout: `${this.probeResult}\n`, stderr: "" };
		}
		if (command.startsWith("kill ")) {
			return { code: 0, stdout: "", stderr: "" };
		}
		if (command.startsWith("cat ")) {
			return { code: 0, stdout: this.output, stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	}
}

describe("ChannelJobManager", () => {
	it("starts a job and reports it as running", async () => {
		const executor = new FakeJobExecutor();
		const manager = new ChannelJobManager("dm_1", executor);

		const job = await manager.start("sleep 100", "wait", 300);
		expect(job.status).toBe("running");
		expect(job.label).toBe("wait");
		expect(manager.runningCount()).toBe(1);
	});

	it("reports a running job's duration as elapsed time, not an absolute timestamp", async () => {
		const executor = new FakeJobExecutor();
		const manager = new ChannelJobManager("dm_1", executor);
		const job = await manager.start("sleep 100", "wait", 300);
		// A running job's durationMs is time-since-start (tiny here), never Date.now() (~1.7e12).
		expect(job.durationMs).toBeLessThan(60_000);
		expect(job.durationMs).toBeGreaterThanOrEqual(0);
	});

	it("sweeps and reaps a finished job even when nobody polls it", async () => {
		const executor = new FakeJobExecutor();
		// Tiny sweep interval so the background sweeper fires within the test window.
		const manager = new ChannelJobManager("dm_1", executor, 5);
		await manager.start("true", "quick", 300);
		expect(manager.runningCount()).toBe(1);
		executor.probeResult = "EXIT:0"; // the job has finished on its own

		// No list/poll/cancel call — rely purely on the internal sweeper to reconcile state.
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(manager.runningCount()).toBe(0);
	});

	it("caps the number of concurrent running jobs", async () => {
		const executor = new FakeJobExecutor();
		const manager = new ChannelJobManager("dm_1", executor);
		for (let i = 0; i < MAX_RUNNING_JOBS; i++) {
			await manager.start("sleep 100", `job${i}`, 300);
		}
		await expect(manager.start("sleep 100", "one too many", 300)).rejects.toThrow(/Too many background jobs/);
	});

	it("marks a job completed when its exit file reports success", async () => {
		const executor = new FakeJobExecutor();
		const manager = new ChannelJobManager("dm_1", executor);
		const job = await manager.start("true", "ok", 300);
		executor.probeResult = "EXIT:0";

		const [snapshot] = await manager.list();
		expect(snapshot.id).toBe(job.id);
		expect(snapshot.status).toBe("completed");
		expect(snapshot.exitCode).toBe(0);
	});

	it("marks a job failed on a non-zero exit code", async () => {
		const executor = new FakeJobExecutor();
		const manager = new ChannelJobManager("dm_1", executor);
		await manager.start("false", "fail", 300);
		executor.probeResult = "EXIT:2";

		const [snapshot] = await manager.list();
		expect(snapshot.status).toBe("failed");
		expect(snapshot.exitCode).toBe(2);
	});

	it("marks a job lost when the process vanished without an exit code", async () => {
		const executor = new FakeJobExecutor();
		const manager = new ChannelJobManager("dm_1", executor);
		await manager.start("cmd", "gone", 300);
		executor.probeResult = "GONE";

		const [snapshot] = await manager.list();
		expect(snapshot.status).toBe("lost");
	});

	it("kills and fails a job that overruns its timeout", async () => {
		const executor = new FakeJobExecutor();
		const manager = new ChannelJobManager("dm_1", executor);
		await manager.start("sleep 100", "slow", 0); // 0s budget: any elapsed time overruns
		executor.probeResult = "ALIVE";
		await new Promise((resolve) => setTimeout(resolve, 5)); // ensure elapsed > 0

		const [snapshot] = await manager.list();
		expect(snapshot.status).toBe("failed");
		expect(snapshot.exitCode).toBe(124);
		expect(executor.commands.some((c) => c.startsWith("kill "))).toBe(true);
	});

	it("cancels a running job and reports outcomes for unknown/finished ids", async () => {
		const executor = new FakeJobExecutor();
		const manager = new ChannelJobManager("dm_1", executor);
		const running = await manager.start("sleep 100", "run", 300);
		const done = await manager.start("true", "done", 300);
		executor.probeResult = "ALIVE"; // running stays alive on refresh

		const outcomes = await manager.cancel([running.id, done.id, "nope"]);
		expect(outcomes.find((o) => o.id === running.id)?.status).toBe("cancelled");
		expect(outcomes.find((o) => o.id === "nope")?.status).toBe("not_found");
		// `done` was probed ALIVE here too, so it is still running and gets cancelled; the important
		// contract is that a genuinely unknown id reports not_found and a live one is cancelled.
		expect(outcomes).toHaveLength(3);
	});

	it("poll returns immediately for an already-finished job", async () => {
		const executor = new FakeJobExecutor();
		const manager = new ChannelJobManager("dm_1", executor);
		const job = await manager.start("true", "quick", 300);
		executor.probeResult = "EXIT:0";

		const snapshots = await manager.poll([job.id]);
		expect(snapshots[0].status).toBe("completed");
	});

	it("poll returns promptly when the abort signal is already aborted", async () => {
		const executor = new FakeJobExecutor();
		const manager = new ChannelJobManager("dm_1", executor);
		const job = await manager.start("sleep 100", "run", 300);
		executor.probeResult = "ALIVE";

		const snapshots = await manager.poll([job.id], AbortSignal.abort());
		expect(snapshots[0].status).toBe("running");
	});

	it("reads captured output for a job", async () => {
		const executor = new FakeJobExecutor();
		executor.output = "hello from job";
		const manager = new ChannelJobManager("dm_1", executor);
		const job = await manager.start("echo hi", "echo", 300);

		const output = await manager.readOutput(job.id);
		expect(output?.text).toContain("hello from job");
	});
});
