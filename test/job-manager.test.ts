import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ChannelJobManager, FINISHED_JOB_RETENTION_MS, MAX_RUNNING_JOBS } from "../src/agent/job-manager.js";
import { createExecutor, type ExecOptions, type ExecResult, type Executor } from "../src/executor.js";
import * as log from "../src/log.js";
import type { DingTalkEvent } from "../src/runtime/dingtalk.js";
import { isProcessAlive } from "../src/shared/host-process.js";
import { useTempDirs } from "./helpers/fixtures.js";

/**
 * A command-aware fake executor. Real jobs are managed by shelling out; this fake recognizes the
 * command shapes the manager emits (launch / probe / kill / read output) and returns scripted
 * results, letting us drive job lifecycle deterministically without spawning processes.
 */
class FakeJobExecutor implements Executor {
	/** Per-job probe token: ALIVE | GONE | DIFFERENT | UNKNOWN | EXIT:<n>. */
	public probeResult = "ALIVE";
	/** Simulates a probe that cannot spawn at all (EAGAIN/EMFILE/ENOMEM under load). */
	public probeThrows = false;
	/** When true, the launch emits `PGID`/`LSTART`, as the real `setsid` branch does. */
	public emitIdentity = false;
	/** Make every `kill`-shaped command reject, as an executor that cannot spawn would. */
	public killThrows = false;
	/** Token the kill script "prints": TERMINATED | GONE | UNCONFIRMED | IDENTITY_MISMATCH. */
	public killResult = "TERMINATED";
	/** Delay each `kill`-shaped command's resolution, to open a concurrency window in tests. */
	public killDelayMs = 0;
	/** Fail the launch handshake (inner shell could not start — e.g. read-only spill dir). */
	public handshakeFails = false;
	/** Reject the launch after the detached child + metadata file already exist (abort race). */
	public abortMidLaunch = false;
	public output = "job output here";
	public readonly commands: string[] = [];
	/** The AbortSignal each `kill`-shaped command was invoked with — asserted to never be aborted
	 *  on the persist-failure rollback / interrupted-launch paths. */
	public readonly killSignals: Array<AbortSignal | undefined> = [];
	private nextPid = 1000;

	async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
		this.commands.push(command);
		const spillMatch = command.match(/> '([^']*)' 2>&1/);
		if (command.includes("command -v setsid")) {
			// `readOutput` reads the spill straight off disk via `FileStore`, so put `this.output`
			// at the spill path the real launch names (extracted from the command string).
			if (spillMatch) writeFileSync(spillMatch[1], this.output);
			const pid = this.nextPid++;
			const meta = `MODE setsid\nPID ${pid}\n${this.emitIdentity ? `PGID ${pid}\nLSTART Mon Jan  1 00:00:00 2024\n` : ""}`;
			if (this.handshakeFails) {
				return {
					code: 1,
					stdout: "HANDSHAKE failed\nsh: 1: cannot create spill: Read-only file system\n",
					stderr: "",
				};
			}
			if (this.abortMidLaunch) {
				// The wrapper writes its metadata file before the handshake; model that, then reject.
				if (spillMatch) writeFileSync(`${spillMatch[1]}.meta`, meta);
				throw new Error("Command aborted");
			}
			return { code: 0, stdout: meta, stderr: "" };
		}
		if (command.includes("printf '%s ALIVE")) {
			if (this.probeThrows) throw new Error("spawn /bin/sh EAGAIN");
			const ids = Array.from(command.matchAll(/printf '%s ALIVE\\n' '([^']*)'/g)).map((match) => match[1]);
			return { code: 0, stdout: `${ids.map((id) => `${id} ${this.probeResult}`).join("\n")}\n`, stderr: "" };
		}
		if (command.includes("kill -TERM") || command.startsWith("kill ")) {
			this.killSignals.push(options?.signal);
			if (this.killThrows) throw new Error("spawn /bin/sh EAGAIN");
			if (this.killDelayMs) await new Promise((resolve) => setTimeout(resolve, this.killDelayMs));
			return { code: 0, stdout: `${this.killResult}\n`, stderr: "" };
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

	it("survives a probe that cannot spawn instead of taking the process down", async () => {
		// The sweeper is timer-driven, so nothing above it can catch: an unhandled rejection here
		// exits the daemon, and one job's bad tick would take every channel with it.
		const executor = new FakeJobExecutor();
		const manager = new ChannelJobManager("dm_1", executor, 5);
		await manager.start("sleep 100", "wait", 300);
		const warnSpy = vi.spyOn(log, "logWarning").mockImplementation(() => undefined);
		const rejections: unknown[] = [];
		const onRejection = (reason: unknown): void => {
			rejections.push(reason);
		};
		process.on("unhandledRejection", onRejection);
		try {
			executor.probeThrows = true;
			await new Promise((resolve) => setTimeout(resolve, 40));
			expect(rejections).toEqual([]);
			expect(warnSpy).toHaveBeenCalledWith("Background job sweep failed", expect.stringContaining("EAGAIN"));

			// One failed tick must not wedge the sweeper: the next one still reconciles.
			executor.probeThrows = false;
			executor.probeResult = "EXIT:0";
			await new Promise((resolve) => setTimeout(resolve, 40));
			expect(manager.runningCount()).toBe(0);
		} finally {
			process.off("unhandledRejection", onRejection);
			warnSpy.mockRestore();
		}
	});

	it("removes a finished job at retention expiry without another job starting", async () => {
		vi.useFakeTimers();
		try {
			const executor = new FakeJobExecutor();
			// Keep the running-job sweeper beyond the retention window: after list() finishes the
			// job it stops, so only the independent GC timeout can remove this record.
			const manager = new ChannelJobManager("dm_1", executor, FINISHED_JOB_RETENTION_MS + 1);
			const job = await manager.start("true", "quick", 300);
			executor.probeResult = "EXIT:0";
			await manager.list();
			expect((await manager.list()).map((snapshot) => snapshot.id)).toContain(job.id);

			await vi.advanceTimersByTimeAsync(FINISHED_JOB_RETENTION_MS);
			expect((await manager.list()).map((snapshot) => snapshot.id)).not.toContain(job.id);
		} finally {
			vi.useRealTimers();
		}
	});

	it("caps the number of concurrent running jobs", async () => {
		const executor = new FakeJobExecutor();
		const manager = new ChannelJobManager("dm_1", executor);
		for (let i = 0; i < MAX_RUNNING_JOBS; i++) {
			await manager.start("sleep 100", `job${i}`, 300);
		}
		await expect(manager.start("sleep 100", "one too many", 300)).rejects.toThrow(/Too many background jobs/);
	});

	it("marks a job completed, failed, or lost according to what the probe reports", async () => {
		for (const { probeResult, expectedStatus, expectedExitCode } of [
			{ probeResult: "EXIT:0", expectedStatus: "completed", expectedExitCode: 0 },
			{ probeResult: "EXIT:2", expectedStatus: "failed", expectedExitCode: 2 },
			{ probeResult: "GONE", expectedStatus: "lost", expectedExitCode: undefined },
		]) {
			const executor = new FakeJobExecutor();
			const manager = new ChannelJobManager("dm_1", executor);
			const job = await manager.start("cmd", "job", 300);
			executor.probeResult = probeResult;

			const [snapshot] = await manager.list();
			expect(snapshot.id, probeResult).toBe(job.id);
			expect(snapshot.status, probeResult).toBe(expectedStatus);
			if (expectedExitCode !== undefined) expect(snapshot.exitCode, probeResult).toBe(expectedExitCode);
		}
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
		expect(executor.commands.some((c) => c.includes("kill -TERM"))).toBe(true);
	});

	it("keeps a timed-out job running until its kill is confirmed", async () => {
		const executor = new FakeJobExecutor();
		executor.killResult = "UNCONFIRMED";
		const manager = new ChannelJobManager("dm_1", executor);
		await manager.start("sleep 100", "slow", 0);
		executor.probeResult = "ALIVE";
		await new Promise((resolve) => setTimeout(resolve, 5));

		// Kill could not be confirmed -> stays running, not falsely `failed`.
		expect((await manager.list())[0].status).toBe("running");

		executor.killResult = "TERMINATED";
		const [snapshot] = await manager.list();
		expect(snapshot.status).toBe("failed");
		expect(snapshot.exitCode).toBe(124);
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

	it("keeps a job running when cancel's kill cannot be confirmed, then settles once it is", async () => {
		const executor = new FakeJobExecutor();
		executor.probeResult = "ALIVE";
		executor.killResult = "UNCONFIRMED";
		const manager = new ChannelJobManager("dm_1", executor);
		const job = await manager.start("sleep 100", "stubborn", 300);

		// Unconfirmed kill -> reported as still running, not a false `cancelled`.
		expect((await manager.cancel([job.id]))[0]?.status).toBe("running");
		expect(manager.runningCount()).toBe(1);

		// The pending cancel is retried on the next refresh; once the process is gone it settles.
		executor.killResult = "TERMINATED";
		expect((await manager.list())[0]?.status).toBe("cancelled");
		expect(manager.runningCount()).toBe(0);
	});

	it("a pending cancel settles as cancelled when a later probe shows the process gone", async () => {
		for (const goneToken of ["GONE", "DIFFERENT"]) {
			const executor = new FakeJobExecutor();
			executor.emitIdentity = true;
			executor.probeResult = "ALIVE";
			executor.killResult = "UNCONFIRMED";
			const manager = new ChannelJobManager("dm_1", executor);
			const job = await manager.start("sleep 100", "stubborn", 300);
			expect((await manager.cancel([job.id]))[0]?.status).toBe("running");

			// Next probe: the process vanished on its own. Honor the pending cancel intent, not `lost`.
			executor.probeResult = goneToken;
			const [snapshot] = await manager.list();
			expect(snapshot.status, goneToken).toBe("cancelled");
			expect(snapshot.exitCode, goneToken).toBeUndefined();
		}
	});

	it("a pending timeout kill settles as failed/124 when a later probe shows the process gone", async () => {
		for (const goneToken of ["GONE", "DIFFERENT"]) {
			const executor = new FakeJobExecutor();
			executor.emitIdentity = true;
			executor.probeResult = "ALIVE";
			executor.killResult = "UNCONFIRMED";
			const manager = new ChannelJobManager("dm_1", executor);
			await manager.start("sleep 100", "slow", 0); // 0s budget: overruns immediately
			await new Promise((resolve) => setTimeout(resolve, 5));
			expect((await manager.list())[0]?.status).toBe("running"); // kill unconfirmed -> pending

			executor.probeResult = goneToken;
			const [snapshot] = await manager.list();
			expect(snapshot.status, goneToken).toBe("failed");
			expect(snapshot.exitCode, goneToken).toBe(124);
		}
	});

	it("cancel does not downgrade an existing timeout intent (failed/124 wins)", async () => {
		const executor = new FakeJobExecutor();
		executor.emitIdentity = true;
		executor.probeResult = "ALIVE";
		executor.killResult = "UNCONFIRMED";
		const manager = new ChannelJobManager("dm_1", executor);
		const job = await manager.start("sleep 100", "slow", 0); // overruns immediately
		await new Promise((resolve) => setTimeout(resolve, 5));
		await manager.list(); // timeout kill unconfirmed -> pendingKill = "failed"

		// Now the model also cancels it; the kill is still unconfirmed.
		expect((await manager.cancel([job.id]))[0]?.status).toBe("running"); // stays running
		// ...and the pending intent must remain the timeout's, not be clobbered to cancelled.
		executor.killResult = "TERMINATED";
		const [snapshot] = await manager.list();
		expect(snapshot.status).toBe("failed");
		expect(snapshot.exitCode).toBe(124);
	});

	it("cancel confirming a timeout-pending job settles as failed/124, not cancelled", async () => {
		const executor = new FakeJobExecutor();
		executor.emitIdentity = true;
		executor.probeResult = "ALIVE";
		executor.killResult = "UNCONFIRMED";
		const manager = new ChannelJobManager("dm_1", executor);
		const job = await manager.start("sleep 100", "slow", 0);
		await new Promise((resolve) => setTimeout(resolve, 5));
		await manager.list(); // pendingKill = "failed"

		// This cancel's own kill confirms the process is gone.
		executor.killResult = "TERMINATED";
		const [outcome] = await manager.cancel([job.id]);
		expect(outcome.status).toBe("failed");
		const [snapshot] = await manager.list();
		expect(snapshot.status).toBe("failed");
		expect(snapshot.exitCode).toBe(124);
	});

	it("a pending cancel/timeout is honored over a real EXIT:n the process wrote first", async () => {
		for (const { pending, exit, expected } of [
			{ pending: "cancel" as const, exit: "EXIT:0", expected: { status: "cancelled", exitCode: undefined } },
			{ pending: "cancel" as const, exit: "EXIT:1", expected: { status: "cancelled", exitCode: undefined } },
			{ pending: "timeout" as const, exit: "EXIT:0", expected: { status: "failed", exitCode: 124 } },
			{ pending: "timeout" as const, exit: "EXIT:1", expected: { status: "failed", exitCode: 124 } },
		]) {
			const executor = new FakeJobExecutor();
			executor.probeResult = "ALIVE";
			executor.killResult = "UNCONFIRMED";
			const manager = new ChannelJobManager("dm_1", executor);
			const job = await manager.start("cmd", "job", pending === "timeout" ? 0 : 300);
			if (pending === "cancel") {
				expect((await manager.cancel([job.id]))[0]?.status).toBe("running");
			} else {
				await new Promise((resolve) => setTimeout(resolve, 5));
				await manager.list(); // records pendingKill = "failed"
			}

			executor.probeResult = exit; // the process actually exited with this code
			const [snapshot] = await manager.list();
			expect(snapshot.status, `${pending}/${exit}`).toBe(expected.status);
			expect(snapshot.exitCode, `${pending}/${exit}`).toBe(expected.exitCode);
		}
	});

	it("no-pending EXIT:n still maps to completed / failed(n) (regression)", async () => {
		for (const { exit, status, code } of [
			{ exit: "EXIT:0", status: "completed", code: 0 },
			{ exit: "EXIT:1", status: "failed", code: 1 },
		]) {
			const executor = new FakeJobExecutor();
			const manager = new ChannelJobManager("dm_1", executor);
			await manager.start("cmd", "job", 300);
			executor.probeResult = exit;
			const [snapshot] = await manager.list();
			expect(snapshot.status, exit).toBe(status);
			expect(snapshot.exitCode, exit).toBe(code);
		}
	});

	it("serializes reconcile: concurrent list/sweep of one job produce exactly one legal terminal", async () => {
		// (a) delayed confirming kill overlaps several reconcile paths.
		{
			const executor = new FakeJobExecutor();
			executor.probeResult = "ALIVE";
			executor.killResult = "UNCONFIRMED";
			const manager = new ChannelJobManager("dm_1", executor, 5); // tiny sweep interval
			const job = await manager.start("sleep 100", "racy", 300);
			expect((await manager.cancel([job.id]))[0]?.status).toBe("running"); // pendingKill = cancelled

			executor.killResult = "TERMINATED";
			executor.killDelayMs = 40;
			const wake = new Promise((resolve) => setTimeout(resolve, 120)); // let the sweeper tick too
			await Promise.all([manager.list(), manager.list(), manager.list(), wake]);

			const [snapshot] = await manager.list();
			expect(["cancelled", "completed", "failed", "lost"]).toContain(snapshot.status);
			expect(snapshot.status).toBe("cancelled"); // the pending intent, applied exactly once
			expect(manager.runningCount()).toBe(0);
		}

		// (b) synchronous GONE branch: without the per-job slot both reconciles would `finish` — the
		// second reading a cleared pendingKill and flipping `cancelled` -> `lost`.
		{
			const executor = new FakeJobExecutor();
			executor.emitIdentity = true;
			executor.probeResult = "ALIVE";
			executor.killResult = "UNCONFIRMED";
			const manager = new ChannelJobManager("dm_1", executor);
			const job = await manager.start("sleep 100", "racy2", 300);
			expect((await manager.cancel([job.id]))[0]?.status).toBe("running");

			executor.probeResult = "GONE";
			await Promise.all([manager.list(), manager.list(), manager.list()]);
			expect((await manager.list())[0]?.status).toBe("cancelled");
		}
	});

	// What `/tasks doctor` asks to tell a healthy parked task from a forgotten one.
	it("names the tasks a running job promises to wake", async () => {
		const executor = new FakeJobExecutor();
		const manager = new ChannelJobManager("dm_1", executor);
		const delegated = await manager.start("sleep 100", "delegated", 300, { taskId: "deploy" });
		await manager.start("sleep 100", "unattached", 300);
		await manager.start("sleep 100", "quiet", 300, { taskId: "muted", notify: false });

		expect(manager.runningTaskIds()).toEqual(new Set(["deploy"]));

		// A finished job no longer promises anything; the task it fed is now on its own.
		executor.probeResult = "EXIT:0";
		await manager.poll([delegated.id]);
		expect(manager.runningTaskIds()).toEqual(new Set());
	});

	it("poll returns immediately for an already-finished job or an already-aborted signal", async () => {
		const executor = new FakeJobExecutor();
		const manager = new ChannelJobManager("dm_1", executor);

		const finished = await manager.start("true", "quick", 300);
		executor.probeResult = "EXIT:0";
		expect((await manager.poll([finished.id]))[0].status).toBe("completed");

		const running = await manager.start("sleep 100", "run", 300);
		executor.probeResult = "ALIVE";
		const snapshots = await manager.poll([running.id], AbortSignal.abort());
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

describe("ChannelJobManager persistence and completion wakes (spec 031, D6)", () => {
	const tempDir = useTempDirs("pipiclaw-jobs-");

	function collectingDispatch(): { events: DingTalkEvent[]; dispatch: (event: DingTalkEvent) => boolean } {
		const events: DingTalkEvent[] = [];
		return {
			events,
			dispatch: (event: DingTalkEvent) => {
				events.push(event);
				return true;
			},
		};
	}

	it("creates the spill file with a restrictive umask", async () => {
		const executor = new FakeJobExecutor();
		const manager = new ChannelJobManager("dm_1", executor, { stateDir: tempDir() });

		await manager.start("echo secret", "leaky", 300);

		// The spill file lands in a shared /tmp and routinely contains credentials.
		expect(executor.commands[0]).toMatch(/^umask 077;/);
	});

	it("persists a record on start and reloads it into a fresh manager", async () => {
		const stateDir = tempDir();
		const executor = new FakeJobExecutor();
		const job = await new ChannelJobManager("dm_1", executor, { stateDir }).start("sleep 100", "long build", 300);

		expect(readdirSync(stateDir)).toEqual([`${job.id}.json`]);
		expect(statSync(join(stateDir, `${job.id}.json`)).mode & 0o777).toBe(0o600);

		// A restarted daemon re-adopts the still-running process, so it counts against the
		// concurrency cap again instead of leaking a slot to an orphan.
		const restarted = new ChannelJobManager("dm_1", executor, { stateDir });
		executor.probeResult = "ALIVE";
		expect(await restarted.restore()).toBe(1);
		expect(restarted.runningCount()).toBe(1);
	});

	it("wakes the channel once when a job finishes, carrying its exit code and output", async () => {
		const { events, dispatch } = collectingDispatch();
		const executor = new FakeJobExecutor();
		executor.output = "build succeeded";
		const manager = new ChannelJobManager("dm_1", executor, { stateDir: tempDir(), dispatch });
		const job = await manager.start("make", "build", 300, { taskId: "release" });

		executor.probeResult = "EXIT:0";
		await manager.list();
		await manager.list(); // a second reconcile must not announce again

		expect(events).toHaveLength(1);
		expect(events[0]?.text).toContain(`[JOB:${job.id}]`);
		expect(events[0]?.text).toContain("completed");
		expect(events[0]?.text).toContain("exit 0");
		expect(events[0]?.text).toContain("build succeeded");
		expect(events[0]?.text).toContain("It belongs to task release.");
		expect(events[0]?.dispatchId).toBe(`job:dm_1:${job.id}:done`);
		expect(events[0]?.internalWake).toEqual({
			kind: "job",
			resourceId: job.id,
			taskId: "release",
			dispatchId: `job:dm_1:${job.id}:done`,
		});
		const dispatchId = events[0]?.dispatchId ?? "";
		await expect(manager.beginWakeConsumption(job.id, "release", dispatchId)).resolves.toBe(true);
		await manager.finishWakeConsumption(job.id, dispatchId);
		await expect(manager.beginWakeConsumption(job.id, "release", dispatchId)).resolves.toBe(false);
	});

	it("announces a job that finished while the daemon was down", async () => {
		const stateDir = tempDir();
		const executor = new FakeJobExecutor();
		await new ChannelJobManager("dm_1", executor, { stateDir }).start("make", "build", 300);

		const { events, dispatch } = collectingDispatch();
		const restarted = new ChannelJobManager("dm_1", executor, { stateDir, dispatch });
		executor.probeResult = "EXIT:1";
		await restarted.restore();

		expect(events).toHaveLength(1);
		expect(events[0]?.text).toContain("failed");
		expect(events[0]?.text).toContain("exit 1");
	});

	it("never wakes for suppressed jobs: notify:false, explicit cancels, and inline polls", async () => {
		const { events, dispatch } = collectingDispatch();
		const executor = new FakeJobExecutor();
		const manager = new ChannelJobManager("dm_1", executor, { stateDir: tempDir(), dispatch });

		const quiet = await manager.start("sleep 100", "quiet", 300, { notify: false });
		executor.probeResult = "EXIT:0";
		await manager.list();
		expect(events).toHaveLength(0);

		const cancelled = await manager.start("sleep 100", "doomed", 300);
		executor.probeResult = "ALIVE";
		await manager.cancel([cancelled.id]);
		expect(events).toHaveLength(0);
		expect(quiet.id).not.toBe(cancelled.id);

		// A result already handed back inline by poll() must not wake later either.
		await manager.start("make", "build", 300);
		executor.probeResult = "EXIT:0";
		await manager.poll(undefined);
		expect(events).toHaveLength(0);

		// A later reconcile must not resurrect the suppressed wake.
		await manager.list();
		expect(events).toHaveLength(0);
	});

	it("discards an unreadable record instead of failing the whole restore", async () => {
		const stateDir = tempDir();
		writeFileSync(join(stateDir, "broken.json"), "{not json");
		const restored = await new ChannelJobManager("dm_1", new FakeJobExecutor(), { stateDir }).restore();

		expect(restored).toBe(0);
		expect(existsSync(join(stateDir, "broken.json"))).toBe(false);
	});

	// T1: a job whose record cannot be written is unrecoverable after a restart (orphan process,
	// leaked slot, unreachable output), so it must not be reported as started.
	it("creates no job and terminates the process when the required first persist fails", async () => {
		const fileAsParent = join(tempDir(), "occupied");
		writeFileSync(fileAsParent, "x"); // stateDir's parent is a file -> mkdir/rename inside it throws
		const executor = new FakeJobExecutor();
		const manager = new ChannelJobManager("dm_1", executor, { stateDir: join(fileAsParent, "jobs") });

		await expect(manager.start("sleep 100", "doomed", 300)).rejects.toThrow(
			/its process was terminated\. No job was created/,
		);
		expect(manager.runningCount()).toBe(0);
		expect((await manager.list()).length).toBe(0);
		// The process we just launched was killed rather than left running with no record.
		expect(executor.commands.some((c) => c.includes("kill -TERM"))).toBe(true);
	});

	// T1: cleanup must not inherit an already-aborted caller signal, and when the kill cannot even
	// be submitted the record is kept (tracked orphan) rather than silently dropped.
	it("keeps the record and reports 'unconfirmed' when rollback kill cannot be submitted", async () => {
		const fileAsParent = join(tempDir(), "occupied2");
		writeFileSync(fileAsParent, "x");
		const executor = new FakeJobExecutor();
		executor.killThrows = true;
		const manager = new ChannelJobManager("dm_1", executor, { stateDir: join(fileAsParent, "jobs") });

		await expect(manager.start("sleep 100", "doomed", 300, { signal: AbortSignal.abort() })).rejects.toThrow(
			/could not be confirmed terminated/,
		);

		expect(manager.runningCount()).toBe(1); // left tracked in memory, not an untracked orphan
		// The rollback kill was attempted, and never with the caller's aborted signal.
		expect(executor.killSignals.length).toBeGreaterThan(0);
		expect(executor.killSignals.every((s) => s === undefined)).toBe(true);
	});

	it("drops the record with an aborted caller signal once the rollback kill is submitted", async () => {
		const fileAsParent = join(tempDir(), "occupied3");
		writeFileSync(fileAsParent, "x");
		const executor = new FakeJobExecutor();
		const manager = new ChannelJobManager("dm_1", executor, { stateDir: join(fileAsParent, "jobs") });

		await expect(manager.start("sleep 100", "doomed", 300, { signal: AbortSignal.abort() })).rejects.toThrow(
			/No job was created/,
		);

		expect(manager.runningCount()).toBe(0);
		expect(executor.killSignals.every((s) => s === undefined)).toBe(true);
	});
});

describe("ChannelJobManager process identity and group termination (T2-T4)", () => {
	const tempDir = useTempDirs("pipiclaw-jobs-id-");

	function writeRecord(stateDir: string, overrides: Record<string, unknown>): string {
		const id = "job0001";
		const record = {
			id,
			label: "l",
			command: "c",
			status: "running",
			startedAt: Date.now(),
			durationMs: 0,
			pid: 4242,
			spillFile: join(stateDir, "s.log"),
			exitFile: join(stateDir, "s.log.exit"),
			timeoutSeconds: 300,
			contract: { notify: false },
			...overrides,
		};
		writeFileSync(join(stateDir, `${id}.json`), JSON.stringify(record));
		return id;
	}

	it("group-kills and identity-checks a setsid-led job (pgid === pid, start time captured)", async () => {
		const stateDir = tempDir();
		const id = writeRecord(stateDir, { pid: 4242, pgid: 4242, pidStartedAt: "Mon Jan  1 00:00:00 2024" });
		const executor = new FakeJobExecutor();
		const manager = new ChannelJobManager("dm_1", executor, { stateDir });
		await manager.restore();

		await manager.cancel([id]);
		const killCmd = executor.commands.find((c) => c.includes("kill -TERM"));
		expect(killCmd).toContain('kill -TERM "-4242"'); // negative target = whole process group
		expect(killCmd).toContain("ps -o lstart= -p 4242"); // identity gate before signalling
		expect(killCmd).toContain("IDENTITY_MISMATCH"); // a recycled pid is reported, never signalled
	});

	it("falls back to a plain pid kill for a legacy record lacking pgid and start time", async () => {
		const stateDir = tempDir();
		const id = writeRecord(stateDir, {});
		const executor = new FakeJobExecutor();
		executor.probeResult = "ALIVE";
		const manager = new ChannelJobManager("dm_1", executor, { stateDir });
		await manager.restore();

		await manager.cancel([id]);
		const killCmd = executor.commands.find((c) => c.includes("kill -TERM"));
		expect(killCmd).toContain("kill -TERM 4242");
		expect(killCmd).not.toContain("-4242"); // no negative-PGID kill without proof pgid === pid
		expect(killCmd).not.toContain("lstart"); // no identity gate available
	});

	it("does not use a negative-PGID kill when pgid differs from pid", async () => {
		const stateDir = tempDir();
		const id = writeRecord(stateDir, { pid: 4242, pgid: 999, pidStartedAt: "Mon Jan  1 00:00:00 2024" });
		const executor = new FakeJobExecutor();
		const manager = new ChannelJobManager("dm_1", executor, { stateDir });
		await manager.restore();

		await manager.cancel([id]);
		const killCmd = executor.commands.find((c) => c.includes("kill -TERM"));
		expect(killCmd).toContain("kill -TERM 4242");
		expect(killCmd).not.toContain("-4242");
	});

	// The launch shell picks `setsid` vs `nohup` via `command -v setsid`; a host without it must
	// still start the job, just without a reliable pgid / identity.
	it("parses a nohup-fallback launch (PID only) and records no pgid or start time", async () => {
		const stateDir = tempDir();
		const executor: Executor = {
			exec: async (command) => {
				if (command.includes("setsid")) return { code: 0, stdout: "MODE nohup\nPID 5150\n", stderr: "" };
				return { code: 0, stdout: "", stderr: "" };
			},
		};
		const manager = new ChannelJobManager("dm_1", executor, { stateDir });
		const job = await manager.start("sleep 100", "no-setsid", 300);

		expect(job.status).toBe("running");
		const record = JSON.parse(readFileSync(join(stateDir, `${job.id}.json`), "utf-8"));
		expect(record.pid).toBe(5150);
		expect(record.pgid).toBeUndefined();
		expect(record.pidStartedAt).toBeUndefined();
	});

	it("even if a stray PGID/LSTART is printed, MODE nohup drops them", async () => {
		const stateDir = tempDir();
		const executor: Executor = {
			exec: async (command) => {
				if (command.includes("setsid")) {
					return { code: 0, stdout: "MODE nohup\nPID 42\nPGID 42\nLSTART Tue\n", stderr: "" };
				}
				return { code: 0, stdout: "", stderr: "" };
			},
		};
		const job = await new ChannelJobManager("dm_1", executor, { stateDir }).start("x", "x", 300);
		const record = JSON.parse(readFileSync(join(stateDir, `${job.id}.json`), "utf-8"));
		expect(record.pgid).toBeUndefined();
		expect(record.pidStartedAt).toBeUndefined();
	});

	it("identity probe is three-state: SAME/UNKNOWN keep running, only DIFFERENT/GONE is lost", async () => {
		const executor = new FakeJobExecutor();
		executor.emitIdentity = true;
		const manager = new ChannelJobManager("dm_1", executor);
		await manager.start("cmd", "job", 300);

		executor.probeResult = "ALIVE"; // identity holds
		expect((await manager.list())[0].status).toBe("running");

		executor.probeResult = "UNKNOWN"; // ps temporarily unavailable -> must NOT terminalize
		expect((await manager.list())[0].status).toBe("running");

		executor.probeResult = "DIFFERENT"; // pid now belongs to an unrelated process -> ours is gone
		expect((await manager.list())[0].status).toBe("lost");
	});

	it("a job whose probe never resolves identity still times out on the wall clock", async () => {
		const executor = new FakeJobExecutor();
		executor.emitIdentity = true;
		executor.probeResult = "UNKNOWN";
		const manager = new ChannelJobManager("dm_1", executor);
		await manager.start("cmd", "job", 0); // 0s budget
		await new Promise((resolve) => setTimeout(resolve, 5));

		const [snapshot] = await manager.list();
		expect(snapshot.status).toBe("failed");
		expect(snapshot.exitCode).toBe(124);
	});

	// Real processes, Linux only: the platform gating convention used by host-process.test.ts.
	describe.skipIf(process.platform !== "linux")("with a real executor", () => {
		it("cancel terminates the whole process group, not just the leader", async () => {
			const dir = tempDir();
			const marker = join(dir, "child.pid");
			const manager = new ChannelJobManager("dm_real", createExecutor(), { stateDir: dir });
			// The job leader backgrounds a long sleep (a child of its own group) and then waits.
			const job = await manager.start(`sleep 30 & echo $! > ${marker}; wait`, "grouped", 300);
			expect(job.status).toBe("running");

			await vi.waitFor(() => expect(existsSync(marker)).toBe(true));
			const childPid = Number.parseInt(readFileSync(marker, "utf-8").trim(), 10);
			expect(isProcessAlive(childPid)).toBe(true);

			const [outcome] = await manager.cancel([job.id]);
			expect(outcome.status).toBe("cancelled");
			await vi.waitFor(() => expect(isProcessAlive(childPid)).toBe(false));
		}, 15_000);

		it("rejects a real launch whose spill file cannot be created (read-only tmp)", async () => {
			const stateDir = tempDir();
			const roDir = join(tempDir(), "readonly");
			mkdirSync(roDir);
			const manager = new ChannelJobManager("dm_real", createExecutor(), { stateDir });
			chmodSync(roDir, 0o500); // no write: the inner `sh -c ... > spill` redirection fails
			const previousTmp = process.env.TMPDIR;
			process.env.TMPDIR = roDir; // jobSpillPath() resolves under os.tmpdir()
			try {
				await expect(manager.start("echo hi", "no-spill", 300)).rejects.toThrow(/Failed to start background job/);
				expect(manager.runningCount()).toBe(0);
			} finally {
				if (previousTmp === undefined) delete process.env.TMPDIR;
				else process.env.TMPDIR = previousTmp;
				chmodSync(roDir, 0o700);
			}
		}, 15_000);

		it("captures pgid === pid and an identity start time at launch", async () => {
			// `ps` right after fork can rarely miss the process even with the launch's retry; a couple
			// of attempts keeps this from flaking under full-suite load without weakening the check.
			let record: { pid: number; pgid?: number; pidStartedAt?: string } | undefined;
			for (let attempt = 0; attempt < 3 && !record?.pidStartedAt; attempt++) {
				const dir = tempDir();
				const manager = new ChannelJobManager("dm_real", createExecutor(), { stateDir: dir });
				const job = await manager.start("sleep 5", "identity", 300);
				record = JSON.parse(readFileSync(join(dir, `${job.id}.json`), "utf-8"));
				await manager.cancel([job.id]);
			}
			expect(record?.pgid).toBe(record?.pid); // setsid made the job its own group leader
			expect(typeof record?.pidStartedAt).toBe("string");
			expect((record?.pidStartedAt ?? "").length).toBeGreaterThan(0);
		}, 20_000);
	});

	it("keeps a job running on an empty or non-numeric exit file instead of failing it (T4)", async () => {
		const executor = new FakeJobExecutor();
		const manager = new ChannelJobManager("dm_1", executor);
		await manager.start("cmd", "job", 300);

		executor.probeResult = "EXIT:"; // .exit present but not yet written
		expect((await manager.list())[0].status).toBe("running");
		executor.probeResult = "EXIT:not-a-number";
		expect((await manager.list())[0].status).toBe("running");

		executor.probeResult = "EXIT:0"; // settled value on a later probe
		const [snapshot] = await manager.list();
		expect(snapshot.status).toBe("completed");
		expect(snapshot.exitCode).toBe(0);
	});
});

describe("ChannelJobManager launch handshake and interrupted-launch recovery (A/B)", () => {
	const tempDir = useTempDirs("pipiclaw-jobs-hs-");

	it("rejects and creates no job when the launch handshake fails", async () => {
		const executor = new FakeJobExecutor();
		executor.handshakeFails = true;
		const manager = new ChannelJobManager("dm_1", executor, { stateDir: tempDir() });

		await expect(manager.start("sleep 100", "doomed", 300)).rejects.toThrow(/Failed to start background job/);
		expect(manager.runningCount()).toBe(0);
		expect((await manager.list()).length).toBe(0);
	});

	it("recovers the pid from the launch metadata file and cleans up with no caller signal", async () => {
		const executor = new FakeJobExecutor();
		executor.abortMidLaunch = true; // detached child + metadata exist, then launch rejects
		const manager = new ChannelJobManager("dm_1", executor, { stateDir: tempDir() });

		await expect(manager.start("sleep 100", "raced", 300, { signal: AbortSignal.abort() })).rejects.toThrow(
			/launch was interrupted.*recovered.*No job was created/s,
		);
		expect(manager.runningCount()).toBe(0);
		// The recovery kill ran, and never with the caller's aborted signal.
		expect(executor.killSignals.length).toBeGreaterThan(0);
		expect(executor.killSignals.every((s) => s === undefined)).toBe(true);
	});

	it("is explicit that it cannot confirm the command's fate when no pid is recoverable", async () => {
		const executor: Executor = {
			exec: async (command) => {
				if (command.includes("command -v setsid")) throw new Error("Command aborted");
				return { code: 0, stdout: "", stderr: "" };
			},
		};
		const manager = new ChannelJobManager("dm_1", executor, { stateDir: tempDir() });

		await expect(manager.start("sleep 100", "lost-to-race", 300, { signal: AbortSignal.abort() })).rejects.toThrow(
			/no pid could be recovered.*cannot be confirmed/s,
		);
		expect(manager.runningCount()).toBe(0);
	});
});
