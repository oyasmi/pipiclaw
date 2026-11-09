import { afterEach, expect, it, vi } from "vitest";
import type { AgentRunner } from "../src/agent/types.js";
import type { WakeEvent } from "../src/channel/channel-event.js";
import type { ChannelStore } from "../src/channel/store.js";
import * as log from "../src/log.js";
import type { DurableDispatchService } from "../src/runtime/durable-dispatch.js";
import { createTransportRegistry } from "../src/runtime/transports.js";
import { createEventTurnRunner, type EventTurnDeps } from "../src/runtime/turn-run.js";
import { createEmptyUsageTotals } from "../src/usage/totals.js";
import { createFakeRunner } from "./support/fake-runner.js";
import { RecordingTransport } from "./support/recording-transport.js";

const wake = (id: string): WakeEvent => ({
	source: "wake",
	channelId: "dingtalk:dm:1",
	desk: "news",
	ts: "1",
	producer: "SUBAGENT",
	dispatchId: `subagent:news:${id}:done`,
	text: `[SUBAGENT:${id}] done`,
});
function fixture() {
	const runner = createFakeRunner();
	const end = vi.spyOn(runner, "endTurn");
	let current: AgentRunner = runner;
	const durable = {
		stopEpoch: () => 0,
		markStarted: vi.fn(async (_id?: string) => true),
		absorbPending: vi.fn(async () => [] as WakeEvent[]),
		markCompleted: vi.fn(async (_id?: string) => {}),
		markRetryable: vi.fn(async (_id?: string) => {}),
	};
	const reservedTurns = new WeakSet<WakeEvent>();
	const activeTasks = new Set<Promise<void>>();
	const transport = new RecordingTransport().withScopes();
	const deps: EventTurnDeps = {
		transports: createTransportRegistry([transport]),
		store: {} as ChannelStore,
		activeTasks,
		archiveIncomingMessage: vi.fn(async () => {}),
		getRunner: () => current,
		isCurrentRunner: (candidate) => candidate === current,
		resolveChannel: () => ({ kind: "bound", conversation: current.conversation }),
		reservedTurns,
		isShuttingDown: () => false,
		getDurableDispatch: () => durable as unknown as DurableDispatchService,
		getTaskControl: () => undefined,
		runRuntimeCommand: async () => "",
	};
	const run = createEventTurnRunner(deps);
	return {
		runner,
		deps,
		transport,
		end,
		durable,
		activeTasks,
		reservedTurns,
		replace() {
			runner.forceEndTurn("test replacement");
			current = createFakeRunner();
			current.beginTurn("new generation");
			return current;
		},
		run(event: WakeEvent) {
			runner.beginTurn(event.text);
			reservedTurns.add(event);
			return run(event);
		},
	};
}
afterEach(() => vi.restoreAllMocks());

it("releases a reserved runner on failed durable admission and retries only a successfully claimed primary", async () => {
	// Risk: markStarted/absorbPending rejects before the turn task exists, leaving the channel busy forever.
	const warn = vi.spyOn(log, "logWarn").mockImplementation(() => {});
	for (const stage of ["markStarted", "absorbPending"] as const) {
		const f = fixture();
		const event = wake("primary");
		const error = Object.assign(new Error("injected admission EIO"), { code: "EIO" });
		f.durable[stage].mockRejectedValueOnce(error);
		const retryError = Object.assign(new Error("retry EACCES"), { code: "EACCES" });
		if (stage === "absorbPending") f.durable.markRetryable.mockRejectedValueOnce(retryError);
		await expect(f.run(event)).rejects.toBe(error);
		expect(f.runner.isBusy(), stage).toBe(false);
		expect(f.end).toHaveBeenCalledOnce();
		expect(f.reservedTurns.has(event)).toBe(false);
		expect(f.runner.run).not.toHaveBeenCalled();
		expect(f.durable.markCompleted).not.toHaveBeenCalled();
		expect(f.durable.markRetryable.mock.calls).toEqual(stage === "absorbPending" ? [[event.dispatchId]] : []);
		expect(warn).toHaveBeenCalledWith(
			"dispatch.turn.admit_failed",
			expect.any(String),
			expect.objectContaining({
				channelId: event.channelId,
				reason: error.message,
				fields: expect.objectContaining({ dispatchId: event.dispatchId, operation: stage, code: "EIO" }),
			}),
		);
		if (stage === "absorbPending")
			expect(warn).toHaveBeenCalledWith(
				"dispatch.turn.settle_failed",
				expect.any(String),
				expect.objectContaining({
					channelId: event.channelId,
					reason: retryError.message,
					fields: expect.objectContaining({
						dispatchId: event.dispatchId,
						operation: "markRetryable",
						code: "EACCES",
					}),
				}),
			);
		expect(f.activeTasks.size).toBe(0);
	}
});

it("settles subsequent absorbed wakes after errors and releases only the original runner", async () => {
	// Risk: an unlink/write failure in primary or absorbed settlement prevents endTurn and strands other claims.
	const warn = vi.spyOn(log, "logWarn").mockImplementation(() => {});
	for (const stopped of [false, true]) {
		const f = fixture();
		const primary = wake("primary");
		const first = wake("first");
		const second = wake("second");
		f.durable.absorbPending.mockResolvedValueOnce([first, second]);
		vi.mocked(f.runner.run).mockResolvedValueOnce({ stopReason: stopped ? "aborted" : "stop" });
		const primaryError = new Error("primary unlink EIO");
		const absorbedError = new Error("absorbed write EACCES");
		f.durable.markCompleted.mockRejectedValueOnce(primaryError);
		const absorbed = stopped ? f.durable.markRetryable : f.durable.markCompleted;
		absorbed.mockRejectedValueOnce(absorbedError);
		await expect(f.run(primary)).rejects.toMatchObject({ errors: [primaryError, absorbedError] });
		expect(f.runner.isBusy(), String(stopped)).toBe(false);
		expect(f.end).toHaveBeenCalledOnce();
		expect(f.activeTasks.size).toBe(0);
		expect(f.durable.markCompleted.mock.calls).toEqual(
			stopped ? [[primary.dispatchId]] : [[primary.dispatchId], [first.dispatchId], [second.dispatchId]],
		);
		if (stopped) expect(f.durable.markRetryable.mock.calls).toEqual([[first.dispatchId], [second.dispatchId]]);
		for (const [id, operation, error] of [
			[primary.dispatchId, "markCompleted", primaryError],
			[first.dispatchId, stopped ? "markRetryable" : "markCompleted", absorbedError],
		]) {
			expect(warn).toHaveBeenCalledWith(
				"dispatch.turn.settle_failed",
				expect.any(String),
				expect.objectContaining({
					channelId: primary.channelId,
					reason: (error as Error).message,
					fields: expect.objectContaining({ dispatchId: id, operation }),
				}),
			);
		}
	}
	// A replacement while settlement awaits must not let the old finally release the new runner,
	// or let subsequent absorbed settlement mutate claims now owned by that replacement.
	const f = fixture();
	f.durable.absorbPending.mockResolvedValueOnce([wake("absorbed")]);
	let entered!: () => void;
	let reject!: (error: Error) => void;
	const arrived = new Promise<void>((resolve) => {
		entered = resolve;
	});
	f.durable.markCompleted.mockImplementationOnce(() => {
		entered();
		return new Promise<void>((_resolve, fail) => {
			reject = fail;
		});
	});
	const pending = f.run(wake("primary"));
	const failed = expect(pending).rejects.toBeInstanceOf(AggregateError);
	await arrived;
	const replacement = f.replace();
	reject(new Error("late unlink failure"));
	await failed;
	expect(f.end).toHaveBeenCalledOnce();
	expect(replacement.isBusy()).toBe(true);
	expect(f.durable.markCompleted).toHaveBeenCalledOnce();
	expect(f.durable.markRetryable).not.toHaveBeenCalled();
});

it("does not acknowledge a completion whose final intent failed to persist, even if the runner absorbs finish rejection", async () => {
	// New risk: TurnOutput logs a finish error, then runtime deletes the only durable completion.
	const f = fixture();
	const error = new Error("injected final intent ENOSPC");
	vi.spyOn(f.transport, "openTurn").mockReturnValue({
		emit: () => {},
		finish: async () => {
			throw error;
		},
	});
	vi.mocked(f.runner.run).mockImplementationOnce(async (_info, output) => {
		await output.finish({ kind: "completed", usage: createEmptyUsageTotals() }).catch(() => undefined);
		return { stopReason: "stop" };
	});
	const event = wake("unpersisted");
	await expect(f.run(event)).rejects.toMatchObject({ errors: [error] });
	expect(f.durable.markCompleted).not.toHaveBeenCalled();
	expect(f.durable.markRetryable).toHaveBeenCalledWith(event.dispatchId);
	expect(f.runner.isBusy()).toBe(false);
});

it("retains a failed scoped primary completion for retry instead of deleting its unconsumed result", async () => {
	// Review R3: the scoped consumer does not consume failed inputs, so deletion strands its final gate.
	const f = fixture();
	const event = {
		...wake("failed"),
		scopeRef: { desk: "news", channelId: "dingtalk:dm:1", scopeId: "request:failed" as const },
	};
	vi.mocked(f.runner.run).mockResolvedValueOnce({ stopReason: "error" });
	await f.run(event);
	expect(f.durable.markCompleted).not.toHaveBeenCalled();
	expect(f.durable.markRetryable).toHaveBeenCalledWith(event.dispatchId);
	expect(f.runner.isBusy()).toBe(false);
	// /stop consumes and closes: user-aborted scoped wakes must not auto-replay.
	f.durable.markRetryable.mockClear();
	f.durable.markCompleted.mockClear();
	const stopped = {
		...wake("stopped"),
		scopeRef: { desk: "news", channelId: "dingtalk:dm:1", scopeId: "request:stopped" as const },
	};
	vi.mocked(f.runner.run).mockImplementationOnce(async () => {
		f.runner.requestStop();
		return { stopReason: "aborted" };
	});
	await f.run(stopped);
	expect(f.durable.markRetryable).not.toHaveBeenCalled();
	expect(f.durable.markCompleted).toHaveBeenCalledWith(stopped.dispatchId);
	// W2: consumed inputs are settled before model admission, including a mixed batch.
	const consumed = new Set([event.dispatchId]);
	f.deps.getDeliveryScopes = () =>
		({
			isConsumed: (_owner: unknown, id: string) => consumed.has(id),
			openTurn: async () => ({
				emit: () => {},
				finish: async () => {},
			}),
		}) as unknown as import("../src/runtime/delivery-scopes.js").DeliveryScopes;
	await f.run(event);
	expect(f.runner.run).toHaveBeenCalledTimes(2);
	expect(f.durable.markCompleted).toHaveBeenCalledWith(event.dispatchId);
	const primary = { ...wake("fresh"), scopeRef: event.scopeRef };
	const sibling = { ...wake("sibling"), scopeRef: event.scopeRef };
	f.durable.absorbPending.mockResolvedValueOnce([event, sibling]);
	await f.run(primary);
	expect(f.runner.run).toHaveBeenCalledTimes(3);
	const info = vi.mocked(f.runner.run).mock.calls[2]![0];
	expect(info.text).toContain(primary.text);
	expect(info.text).toContain(sibling.text);
	expect(info.text).not.toContain(event.text);
});
