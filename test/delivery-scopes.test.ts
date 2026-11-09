import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { TurnEvent } from "../src/channel/channel-context.js";
import {
	type DeliveryScopeRef,
	deliveryScopeKey,
	type FinalIntent,
	type ScopeDeliveryPort,
	type ScopeDeliveryResult,
	type ScopeWork,
} from "../src/channel/delivery-scope.js";
import { DeliveryScopes } from "../src/runtime/delivery-scopes.js";
import { createTransportRegistry } from "../src/runtime/transports.js";
import * as atomicFile from "../src/shared/atomic-file.js";
import { renderTaskDocument } from "../src/tasks/contract.js";
import { drainTaskDeliveries, queueTaskReport, readTaskDeliveries } from "../src/tasks/delivery.js";
import { readTaskLog } from "../src/tasks/loop-log.js";
import { createEmptyUsageTotals } from "../src/usage/totals.js";
import { useTempDirs } from "./helpers/fixtures.js";
import { RecordingTransport } from "./support/recording-transport.js";

const temp = useTempDirs("delivery-scopes-");
const owner: DeliveryScopeRef = { desk: "default", channelId: "dingtalk:dm:one", scopeId: "request:one" };
const done = { kind: "completed" as const, usage: createEmptyUsageTotals() };
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});
function fixture(directory = temp()) {
	let bound = true;
	let result: ScopeDeliveryResult = { status: "confirmed" };
	let work: ScopeWork[] = [];
	const events: Array<{ owner: DeliveryScopeRef; event: TurnEvent }> = [];
	const finals: Array<{ owner: DeliveryScopeRef; intent: FinalIntent; recovered: boolean }> = [];
	const path = (ref = owner) => join(directory, `${deliveryScopeKey(ref)}.json`);
	const snapshot = async (ref = owner) => JSON.parse(await readFile(path(ref), "utf-8"));
	const port: ScopeDeliveryPort = {
		open: (ref, recovered) => ({
			emit: (event) => events.push({ owner: ref, event }),
			flush: async () => result,
			report: async () => result,
			close: async () => {},
			finalize: async (intent) => {
				// A remote attempt with no durable intent is a lost-final crash window.
				expect((await snapshot(ref)).final).toMatchObject(intent);
				finals.push({ owner: ref, intent: { ...intent }, recovered });
				return result;
			},
		}),
	};
	class ScopedTransport extends RecordingTransport {
		readonly scopes = port;
	}
	const build = () =>
		new DeliveryScopes({
			directory,
			transports: createTransportRegistry([new ScopedTransport()]),
			isBoundTo: () => bound,
			work: (ref) => (ref.scopeId === owner.scopeId ? work : []),
		});
	return {
		build,
		events,
		finals,
		path,
		snapshot,
		setWork: (value: ScopeWork[]) => {
			work = value;
		},
		setResult: (value: ScopeDeliveryResult) => {
			result = value;
		},
		bind: (value: boolean) => {
			bound = value;
		},
	};
}

it("keeps concurrent owners and late writers apart, and requires consumption of every run/job result before final", async () => {
	// New risk: pending=0 can finalize the initial ack or a wake that never saw the last sibling.
	const f = fixture();
	const scopes = f.build();
	f.setWork([
		{ ref: "run", pending: true },
		{ ref: "job", pending: true },
	]);
	const initial = await scopes.openTurn(owner, []);
	initial.emit({ type: "answer", text: "ack" });
	await initial.finish(done);
	expect(f.finals).toEqual([]);
	const other = { ...owner, scopeId: "request:two" as const };
	const independent = await scopes.openTurn(other, []);
	independent.emit({ type: "answer", text: "independent" });
	await independent.finish(done);
	expect(f.finals.map((item) => item.owner)).toEqual([other]);
	const first = await scopes.openTurn(owner, ["run:done"]);
	first.emit({ type: "answer", text: "first result" });
	// The other completion arrives while this candidate is in flight, after its inputs were fixed.
	f.setWork([
		{ ref: "run", pending: false, completionId: "run:done" },
		{ ref: "job", pending: false, completionId: "job:done" },
	]);
	await first.finish(done);
	expect(f.finals).toHaveLength(1);
	const retired = await scopes.openTurn(owner, []);
	const last = await scopes.openTurn(owner, ["job:done"]);
	retired.emit({ type: "answer", text: "late writer" });
	await retired.finish(done);
	last.emit({ type: "answer", text: "all results" });
	await last.finish(done);
	last.emit({ type: "answer", text: "late callback" });
	await last.finish(done);
	expect(f.finals.map((item) => item.owner)).toEqual([other, owner]);
	expect((await f.snapshot()).consumed).toEqual(["run:done", "job:done"]);
	expect((await f.snapshot(other)).final.id).not.toBe((await f.snapshot()).final.id);
	// /stop may beat an already-entered tool's registration; its later wake still owns a result.
	const stoppedOwner = { ...owner, scopeId: "request:stopped" as const };
	const stopped = await scopes.openTurn(stoppedOwner, []);
	await stopped.finish({ ...done, kind: "cancelled" });
	stopped.emit({ type: "answer", text: "stale after stop" });
	const late = await scopes.openTurn(stoppedOwner, ["late-job:done"]);
	late.emit({ type: "answer", text: "owned completion after stop" });
	await late.finish(done);
	expect(f.finals.map((item) => item.owner)).toEqual([other, owner, stoppedOwner]);
	await scopes.stop();
});

it("retains unknown finals, blocks a rebound owner and retries the same durable intent after recovery", async () => {
	// New risk: false enqueue/HTTP acknowledgements delete the only result, or recovery invents a new final.
	vi.useFakeTimers({ toFake: ["Date"] });
	const f = fixture();
	let scopes = f.build();
	f.setResult({ status: "unknown" });
	const ctx = await scopes.openTurn(owner, []);
	ctx.emit({ type: "answer", text: "durable answer" });
	await ctx.finish(done);
	const saved = await f.snapshot();
	expect(saved.final).toMatchObject({ confirmed: false, result: "unknown", attempts: 1 });
	await scopes.stop();
	scopes = f.build();
	await scopes.restore();
	f.bind(false);
	vi.setSystemTime(Date.now() + 60_001);
	await scopes.retry();
	expect(f.finals).toHaveLength(1);
	expect((await f.snapshot()).final).toMatchObject({ id: saved.final.id, confirmed: false, result: "blocked" });
	f.bind(true);
	f.setResult({ status: "confirmed" });
	vi.setSystemTime(Date.now() + 120_001);
	await scopes.retry();
	await scopes.retry();
	expect(f.finals).toHaveLength(2);
	expect(f.finals[1]).toMatchObject({
		owner,
		recovered: true,
		intent: { id: saved.final.id, text: saved.final.text },
	});
	expect((await f.snapshot()).final.confirmed).toBe(true);
	await scopes.stop();
	for (const bad of [
		{ ...saved, owner: { ...owner, channelId: "dingtalk:dm:other" } },
		{ ...saved, final: false },
		{ ...saved, final: { ...saved.final, confirmed: "true" } },
	]) {
		await writeFile(f.path(), JSON.stringify(bad));
		await expect(f.build().restore()).rejects.toThrow("Invalid delivery scope");
	}
});

it("leaves an unconfirmed report in the task outbox and acknowledges it only after remote progress succeeds", async () => {
	// New risk: routing a report into a local card queue falsely opens the task completion gate.
	const deskDir = temp();
	await mkdir(join(deskDir, "tasks"));
	await writeFile(join(deskDir, "tasks", "T.md"), renderTaskDocument({ state: "running" }, "# T\n"));
	const f = fixture();
	const scopes = f.build();
	const report = await queueTaskReport(deskDir, "T", 1, owner.channelId, "report");
	f.setResult({ status: "unknown" });
	const send = (message: typeof report) => scopes.task(owner.desk, message);
	const now = Date.now();
	const next = await drainTaskDeliveries(deskDir, send, () => true, now);
	expect(await readTaskDeliveries(deskDir)).toMatchObject([{ id: report.id, attempts: 1 }]);
	expect((await readTaskLog(deskDir, "T")).some((record) => record.kind === "report_delivered")).toBe(false);
	f.setResult({ status: "confirmed" });
	await drainTaskDeliveries(deskDir, send, () => true, next! + 1);
	expect(await readTaskDeliveries(deskDir)).toEqual([]);
	expect((await readTaskLog(deskDir, "T")).filter((record) => record.kind === "report_delivered")).toMatchObject([
		{ reportId: report.id },
	]);
	const taskOwner: DeliveryScopeRef = { ...owner, scopeId: "task:T" };
	expect((await f.snapshot(taskOwner)).reports).toEqual([report.id]);
	const receipt = { ...report, id: "close-unique", kind: "receipt" as const };
	expect(await scopes.task(owner.desk, receipt)).toBe(true);
	expect(await scopes.task(owner.desk, receipt)).toBe(true);
	expect(f.finals).toHaveLength(1);
	await expect(scopes.task(owner.desk, { ...receipt, id: "another-close" })).rejects.toThrow("different final intent");
	await scopes.stop();
});

it("rejects every finish acknowledgement after the first final-intent save fails and recovers through wake replay", async () => {
	// Review R1: an unsaved in-memory final used to make a replay finish successfully without I/O.
	for (const restart of [false, true]) {
		const f = fixture();
		let scopes = f.build();
		f.setWork([{ ref: "job", pending: false, completionId: "job:done" }]);
		const turn = await scopes.openTurn(owner, ["job:done"]);
		turn.emit({ type: "answer", text: "final result" });
		const write = atomicFile.writeFileAtomically;
		let injected = false;
		const fault = vi.spyOn(atomicFile, "writeFileAtomically").mockImplementation(async (path, content, options) => {
			if (path === f.path() && JSON.parse(String(content)).final && !injected) {
				injected = true;
				throw new Error("first final save ENOSPC");
			}
			return write(path, content, options);
		});
		await expect(turn.finish(done)).rejects.toThrow("first final save ENOSPC");
		fault.mockRestore();
		expect((await f.snapshot()).final).toBeUndefined();
		expect((await f.snapshot()).consumed).toEqual([]);
		await expect(turn.finish(done)).rejects.toThrow("first final save ENOSPC");
		await scopes.retry();
		expect(f.finals).toHaveLength(0);
		if (restart) {
			await scopes.stop();
			scopes = f.build();
			await scopes.restore();
		}
		const replay = await scopes.openTurn(owner, ["job:done"]);
		replay.emit({ type: "answer", text: "final result" });
		await replay.finish(done);
		await scopes.retry();
		expect(f.finals).toHaveLength(1);
		expect((await f.snapshot()).final).toMatchObject({ text: "final result", confirmed: true });
		await scopes.stop();
	}
});
