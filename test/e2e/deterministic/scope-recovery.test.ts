import { existsSync, readdirSync, readFileSync, watch } from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelRunner } from "../../../src/agent/channel-runner.js";
import { deliveryScopeKey } from "../../../src/channel/delivery-scope.js";
import { JobCompletionObserver } from "../../../src/jobs/completion-observer.js";
import { jobWakeDispatchId } from "../../../src/jobs/completion-wake.js";
import { DeliveryScopes } from "../../../src/runtime/delivery-scopes.js";
import { DurableDispatchService } from "../../../src/runtime/durable-dispatch.js";
import * as atomicFile from "../../../src/shared/atomic-file.js";
import { heldCommand } from "../../support/held-command.js";
import { createDeterministicHarness, type DeterministicHarness, reply } from "../../support/runtime-harness.js";

function barrier() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("E2E deterministic: scoped completion recovery", () => {
	let harness: DeterministicHarness | undefined;
	afterEach(async () => {
		vi.restoreAllMocks();
		await harness?.shutdown();
		harness = undefined;
	});

	it.each(["final-save", "failed-wake", "consumed-unlink"] as const)(
		"retains and replays the primary after %s without losing the unique final",
		async (fault) => {
			// Review R1/R3: deleting a failed primary, or retaining an unsaved in-memory final,
			// strands completion consumption. Real jobs produce the durable wakes used here.
			// Mutation 2026-11-09: memory-before-save causes an extra retry SEND; deleting the
			// failed primary removes its file. Both variants confirmed red, then restored.
			const retried = barrier();
			let durable!: DurableDispatchService;
			let scopes!: DeliveryScopes;
			let target = "";
			let inject = true;
			const drain = DurableDispatchService.prototype.drainOnce;
			vi.spyOn(DurableDispatchService.prototype, "drainOnce").mockImplementation(function (
				this: DurableDispatchService,
				now,
			) {
				durable = this;
				return drain.call(this, now);
			});
			const retry = DurableDispatchService.prototype.markRetryable;
			vi.spyOn(DurableDispatchService.prototype, "markRetryable").mockImplementation(async function (
				this: DurableDispatchService,
				id,
			) {
				await retry.call(this, id);
				if (id === target) retried.resolve();
			});
			const complete = DurableDispatchService.prototype.markCompleted;
			vi.spyOn(DurableDispatchService.prototype, "markCompleted").mockImplementation(async function (
				this: DurableDispatchService,
				id,
			) {
				if (fault === "consumed-unlink" && inject && id === target) {
					inject = false;
					retried.resolve();
					throw new Error("injected dispatch unlink EIO after durable consumption");
				}
				await complete.call(this, id);
				// The barrier observes both outcomes: a regression fails on disk state, not a timeout.
				if (id === target) retried.resolve();
			});
			const open = DeliveryScopes.prototype.openTurn;
			vi.spyOn(DeliveryScopes.prototype, "openTurn").mockImplementation(function (this: DeliveryScopes, ...args) {
				scopes = this;
				return open.apply(this, args);
			});
			const run = ChannelRunner.prototype.run;
			vi.spyOn(ChannelRunner.prototype, "run").mockImplementation(function (this: ChannelRunner, info, ...args) {
				if (fault === "failed-wake" && inject && info.text.includes("[JOB:")) {
					inject = false;
					throw new Error("injected primary wake failure");
				}
				return run.call(this, info, ...args);
			});
			const write = atomicFile.writeFileAtomically;
			vi.spyOn(atomicFile, "writeFileAtomically").mockImplementation(async (path, content, options) => {
				if (
					fault === "final-save" &&
					inject &&
					path.includes("delivery-scopes") &&
					JSON.parse(String(content)).final
				) {
					inject = false;
					throw new Error("injected first final save ENOSPC");
				}
				return write(path, content, options);
			});
			harness = await createDeterministicHarness({
				services: true,
				jobSweepIntervalMs: 3_600_000,
				dispatchIntervalMs: 3_600_000,
			});
			const current = harness;
			const first = await heldCommand(current.homeDir, "RECOVERY_FIRST");
			const second = fault === "failed-wake" ? await heldCommand(current.homeDir, "RECOVERY_SECOND") : undefined;
			current.model.script.route({
				name: "start",
				when: (r) => r.isMainTurn && r.lastUserText.includes("START_RECOVERY"),
				respond: [
					reply.toolCall("bash", { command: first.command, async: true }),
					...(second ? [reply.toolCall("bash", { command: second.command, async: true })] : []),
					reply.text("started"),
				],
			});
			current.model.script.route({
				name: "completion",
				when: (r) => r.isMainTurn && r.lastUserText.includes("[JOB:"),
				respond: [
					...(fault === "consumed-unlink"
						? [
								reply.toolCall(
									"bash",
									{
										command: `printf x >> '${join(current.homeDir, "completion-effects")}'`,
									},
									"call_w2_completion",
								),
							]
						: []),
					reply.text("result"),
				],
				repeat: true,
			});
			try {
				await current.sendUserMessage("START_RECOVERY");
				await first.arrived;
				await second?.arrived;
				const jobs = await current.runtime.jobs.get(current.desk).list();
				const owner = jobs[0]!.scopeRef!;
				target = jobWakeDispatchId(current.desk, jobs[0]!.id);
				const scopePath = join(current.homeDir, "state", "delivery-scopes", `${deliveryScopeKey(owner)}.json`);
				const wakePath = join(current.homeDir, "state", "dispatch", `${encodeURIComponent(target)}.json`);
				const state = () => JSON.parse(readFileSync(scopePath, "utf-8"));
				first.release();
				await retried.promise;
				await current.waitForIdle();
				expect(existsSync(wakePath)).toBe(true);
				if (fault === "consumed-unlink") {
					// W2 (+1 case): scope consumption can commit before dispatch deletion. Neither
					// runner admission nor a tool side effect may repeat after runtime recovery.
					// Mutation 2026-11-09: bypass consumed admission -> runner 2→3 (confirmed red, restored).
					expect(state().consumed).toContain(target);
					expect(state().final).toMatchObject({ confirmed: true });
					const calls = vi.mocked(ChannelRunner.prototype.run).mock.calls.length;
					expect(readFileSync(join(current.homeDir, "completion-effects"), "utf-8")).toBe("x");
					await current.restart();
					await durable.drainOnce(Date.now() + 16 * 60_000);
					await current.waitForIdle();
					expect(existsSync(wakePath)).toBe(false);
					expect(vi.mocked(ChannelRunner.prototype.run)).toHaveBeenCalledTimes(calls);
					expect(readFileSync(join(current.homeDir, "completion-effects"), "utf-8")).toBe("x");
					return;
				}
				expect(state().consumed).not.toContain(target);
				expect(state().final).toBeUndefined();
				const beforeRetry = current.deliveries.filter((d) => d.method === "sendPlain").length;
				await scopes.retry();
				expect(current.deliveries.filter((d) => d.method === "sendPlain")).toHaveLength(beforeRetry);
				if (second) {
					const gate = current.model.script.hold({
						when: (r) => r.isMainTurn && r.lastUserText.includes(`[JOB:${jobs[1]!.id}]`),
					});
					second.release();
					await gate.arrived;
					gate.release();
					await current.waitForIdle();
					// The real coalescer reclaims the failed primary alongside its sibling. Both
					// results must reach this successful request before its one final may commit.
					expect(new Set(state().consumed)).toEqual(
						new Set(jobs.map((job) => jobWakeDispatchId(current.desk, job.id))),
					);
					expect(state().final).toMatchObject({ confirmed: true });
					const merged = current.mainTurnRequests().filter((request) => request.matchedRoute === "completion");
					expect(merged).toHaveLength(1);
					for (const job of jobs) expect(merged[0]!.lastUserText).toContain(`[JOB:${job.id}]`);
				} else {
					// Graceful runtime recovery only; the independent daemon SIGKILL suite covers crashes.
					await current.restart();
				}
				const sends = beforeRetry;
				await durable.drainOnce(Date.now() + 60_001);
				await current.waitForIdle();
				expect(state().final).toMatchObject({ confirmed: true });
				expect(new Set(state().consumed)).toEqual(
					new Set(jobs.map((job) => jobWakeDispatchId(current.desk, job.id))),
				);
				expect(current.deliveries.filter((d) => d.method === "sendPlain")).toHaveLength(sends + 1);
				expect(existsSync(wakePath)).toBe(false);
				const id = state().final.id;
				await durable.drainOnce(Date.now() + 120_001);
				await scopes.retry();
				await current.waitForIdle();
				expect(state().final.id).toBe(id);
				expect(current.deliveries.filter((d) => d.method === "sendPlain")).toHaveLength(sends + 1);
			} finally {
				first.release();
				second?.release();
				await first.close();
				await second?.close();
			}
		},
	);

	it("finalizes a scoped answer after job poll consumes completion inline, without creating a phantom wake", async () => {
		// Review R2: poll settles with announce=false; requiring its nonexistent wake prevents final forever.
		// Mutation 2026-11-09: retain inline completionId -> missing final (confirmed red, restored).
		// Suppress automatic observation so this controlled poll is the actual completion consumer.
		vi.spyOn(JobCompletionObserver.prototype, "add").mockImplementation(() => {});
		harness = await createDeterministicHarness({ services: true, jobSweepIntervalMs: 3_600_000 });
		const current = harness;
		const job = await heldCommand(current.homeDir, "POLL_INLINE_RESULT");
		current.model.script.route({
			name: "inline",
			when: (r) => r.isMainTurn && r.lastUserText.includes("POLL_REQUEST"),
			respond: [
				reply.toolCall("bash", { command: job.command, async: true }),
				reply.toolCall("job", { op: "poll" }),
				reply.text("finished"),
			],
		});
		const gate = current.model.script.hold({
			when: (r) => r.isMainTurn && r.messages.some((message) => message.role === "tool"),
		});
		let watcher: ReturnType<typeof watch> | undefined;
		try {
			await current.sendUserMessageNoWait("POLL_REQUEST");
			await gate.arrived;
			await job.arrived;
			const directory = join(current.homeDir, "state", "jobs", current.desk);
			const recordPath = join(directory, readdirSync(directory).find((name) => name.endsWith(".json"))!);
			const record = JSON.parse(readFileSync(recordPath, "utf-8"));
			// Native publication barrier: the launch wrapper atomically renames the completed exit file.
			const published = new Promise<void>((resolve) => {
				watcher = watch(dirname(record.exitFile), (_event, filename) => {
					if (filename === basename(record.exitFile)) resolve();
				});
			});
			job.release();
			await published;
			watcher?.close();
			watcher = undefined;
			gate.release();
			await current.waitForIdle();
			expect(JSON.parse(readFileSync(recordPath, "utf-8"))).toMatchObject({
				completionMode: "inline",
				notified: true,
			});
			const scopePath = join(
				current.homeDir,
				"state",
				"delivery-scopes",
				`${deliveryScopeKey(record.scopeRef)}.json`,
			);
			expect(JSON.parse(readFileSync(scopePath, "utf-8"))).toMatchObject({
				consumed: [],
				final: { confirmed: true },
			});
			expect(current.mainTurnRequests().filter((r) => r.lastUserText.includes("[JOB:"))).toHaveLength(0);
			expect(current.deliveries.filter((d) => d.method === "sendPlain")).toHaveLength(1);
		} finally {
			watcher?.close();
			gate.release();
			job.release();
			await job.close();
		}
	});
});
