import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUsageLedger, type UsageLedger, type UsageLedgerEntry } from "../src/usage/ledger.js";

const cost = (total: number) => ({ input: total, output: 0, cacheRead: 0, cacheWrite: 0, total });
const tokens = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 };

/** Record with a frozen wall clock (controls the ts / monthly file), then let real I/O drain. */
function recordAt(ledger: UsageLedger, iso: string, entry: Omit<UsageLedgerEntry, "ts">): void {
	vi.useFakeTimers();
	vi.setSystemTime(new Date(iso));
	ledger.record(entry);
	vi.useRealTimers();
}

async function flush(): Promise<void> {
	await new Promise((r) => setTimeout(r, 20));
}

describe("usage ledger", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "usage-ledger-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	function readMonth(key: string): UsageLedgerEntry[] {
		const path = join(dir, `usage-${key}.jsonl`);
		if (!existsSync(path)) return [];
		return readFileSync(path, "utf-8")
			.split("\n")
			.filter((l) => l.length > 0)
			.map((l) => JSON.parse(l));
	}

	it("records the three kinds with full fields", async () => {
		const ledger = createUsageLedger({ baseDir: dir });
		recordAt(ledger, "2026-07-04T00:00:00Z", {
			channelId: "c1",
			kind: "turn",
			model: "m/a",
			usage: tokens,
			cost: cost(0.1),
		});
		recordAt(ledger, "2026-07-04T00:00:00Z", {
			channelId: "c1",
			kind: "subagent",
			model: "m/b",
			label: "researcher",
			usage: tokens,
			cost: cost(0.2),
		});
		recordAt(ledger, "2026-07-04T00:00:00Z", {
			channelId: "c1",
			kind: "sidecar",
			model: "m/c",
			label: "session-memory-update",
			correlationId: "memory-window-1",
			usage: tokens,
			cost: cost(0.05),
		});
		await flush();

		const entries = readMonth("2026-07");
		expect(entries.map((e) => e.kind).sort()).toEqual(["sidecar", "subagent", "turn"]);
		const sub = entries.find((e) => e.kind === "subagent");
		const sidecar = entries.find((e) => e.kind === "sidecar");
		expect(sub).toMatchObject({ model: "m/b", label: "researcher", cost: { total: 0.2 } });
		expect(sidecar?.correlationId).toBe("memory-window-1");
		expect(typeof sub?.ts).toBe("string");
	});

	it("skips entries with non-positive cost", async () => {
		const ledger = createUsageLedger({ baseDir: dir });
		recordAt(ledger, "2026-07-04T00:00:00Z", {
			channelId: "c1",
			kind: "turn",
			model: "local",
			usage: tokens,
			cost: cost(0),
		});
		await flush();
		expect(readMonth("2026-07")).toEqual([]);
	});

	it("records missing channelId as (untracked) and warns", async () => {
		const warnSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const ledger = createUsageLedger({ baseDir: dir });
		recordAt(ledger, "2026-07-04T00:00:00Z", {
			channelId: "",
			kind: "sidecar",
			model: "m/c",
			usage: tokens,
			cost: cost(0.01),
		});
		await flush();

		const entries = readMonth("2026-07");
		expect(entries[0]?.channelId).toBe("(untracked)");
		expect(warnSpy).toHaveBeenCalled();
	});

	it("aggregates by kind/model/channel and honors channel + time filters", async () => {
		const ledger = createUsageLedger({ baseDir: dir });
		recordAt(ledger, "2026-07-10T00:00:00Z", {
			channelId: "c1",
			kind: "turn",
			model: "m/a",
			usage: tokens,
			cost: cost(0.1),
		});
		recordAt(ledger, "2026-07-10T00:00:00Z", {
			channelId: "c1",
			kind: "subagent",
			model: "m/a",
			usage: tokens,
			cost: cost(0.2),
		});
		recordAt(ledger, "2026-07-10T00:00:00Z", {
			channelId: "c2",
			kind: "turn",
			model: "m/b",
			usage: tokens,
			cost: cost(0.4),
		});
		await flush();

		const window = { since: new Date("2026-07-01T00:00:00Z"), until: new Date("2026-07-31T00:00:00Z") };
		const all = ledger.summarize(window);
		expect(all.totalCost).toBeCloseTo(0.7);
		expect(all.entryCount).toBe(3);
		expect(all.byKind.turn).toBeCloseTo(0.5);
		expect(all.byKind.subagent).toBeCloseTo(0.2);
		expect(all.byChannel.c1).toBeCloseTo(0.3);

		const c1 = ledger.summarize({ ...window, channelId: "c1" });
		expect(c1.totalCost).toBeCloseTo(0.3);
		expect(c1.byModel["m/b"]).toBeUndefined();
	});

	it("summarizes across a month boundary", async () => {
		const ledger = createUsageLedger({ baseDir: dir });
		recordAt(ledger, "2026-06-30T12:00:00Z", {
			channelId: "c1",
			kind: "turn",
			model: "m/a",
			usage: tokens,
			cost: cost(0.1),
		});
		await flush();
		recordAt(ledger, "2026-07-01T12:00:00Z", {
			channelId: "c1",
			kind: "turn",
			model: "m/a",
			usage: tokens,
			cost: cost(0.3),
		});
		await flush();

		const summary = ledger.summarize({
			since: new Date("2026-06-29T00:00:00Z"),
			until: new Date("2026-07-02T00:00:00Z"),
		});
		expect(summary.totalCost).toBeCloseTo(0.4);
		expect(summary.entryCount).toBe(2);
	});
});
