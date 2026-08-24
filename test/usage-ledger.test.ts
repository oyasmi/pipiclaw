import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUsageLedger, type UsageLedger, type UsageLedgerEntry } from "../src/usage/ledger.js";

const cost = (total: number) => ({ input: total, output: 0, cacheRead: 0, cacheWrite: 0, total });
const tokens = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 };

/** Record with a frozen wall clock (controls the ts / monthly file). */
function recordAt(ledger: UsageLedger, iso: string, entry: Omit<UsageLedgerEntry, "ts">): void {
	vi.useFakeTimers();
	vi.setSystemTime(new Date(iso));
	ledger.record(entry);
	vi.useRealTimers();
}

async function flush(ledger: UsageLedger): Promise<void> {
	await ledger.flush?.();
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
		await flush(ledger);

		const entries = readMonth("2026-07");
		expect(entries.map((e) => e.kind).sort()).toEqual(["sidecar", "subagent", "turn"]);
		const sub = entries.find((e) => e.kind === "subagent");
		const sidecar = entries.find((e) => e.kind === "sidecar");
		expect(sub).toMatchObject({ model: "m/b", label: "researcher", cost: { total: 0.2 } });
		expect(sidecar?.correlationId).toBe("memory-window-1");
		expect(typeof sub?.ts).toBe("string");
	});

	it("keeps a zero-cost entry that still burned tokens, and skips one with neither tokens nor cost", async () => {
		const ledger = createUsageLedger({ baseDir: dir });
		recordAt(ledger, "2026-07-04T00:00:00Z", {
			channelId: "c1",
			kind: "turn",
			model: "local",
			usage: tokens,
			cost: cost(0),
		});
		recordAt(ledger, "2026-07-04T00:00:00Z", {
			channelId: "c1",
			kind: "turn",
			model: "silent",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: cost(0),
		});
		await flush(ledger);

		expect(readMonth("2026-07")).toHaveLength(1);
		const summary = await ledger.summarize({
			since: new Date("2026-07-01T00:00:00Z"),
			until: new Date("2026-07-31T00:00:00Z"),
		});
		expect(summary.totalCost).toBe(0);
		expect(summary.totalTokens).toBe(tokens.total);
		expect(summary.entryCount).toBe(1);
	});

	it("keeps zero/zero entries when usage or cost is explicitly unknown rather than dropping them as noise, and treats pre-T7 entries as known (spec 040, T7)", async () => {
		const ledger = createUsageLedger({ baseDir: dir });
		// `exec`: neither tokens nor cost is ever known.
		recordAt(ledger, "2026-07-04T00:00:00Z", {
			channelId: "c1",
			kind: "subagent",
			model: "unknown",
			runId: "run-exec-1",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: cost(0),
			usageKnown: false,
			costKnown: false,
		});
		// `codex-cli`: tokens known, cost unknown.
		recordAt(ledger, "2026-07-04T00:00:00Z", {
			channelId: "c1",
			kind: "subagent",
			model: "openai/gpt-5-codex",
			runId: "run-codex-1",
			usage: tokens,
			cost: cost(0),
			usageKnown: true,
			costKnown: false,
		});
		await flush(ledger);

		const entries = readMonth("2026-07");
		expect(entries.map((e) => e.runId).sort()).toEqual(["run-codex-1", "run-exec-1"]);

		const summary = await ledger.summarize({
			since: new Date("2026-07-01T00:00:00Z"),
			until: new Date("2026-07-31T00:00:00Z"),
		});
		expect(summary.entryCount).toBe(2);
		expect(summary.unknownCostCount).toBe(2);
		expect(summary.unknownUsageCount).toBe(1);
		// Unknown-cost/usage entries always have zero numeric totals, so the sum stays exact —
		// unknownCostCount/unknownUsageCount is what tells the display layer not to read that as
		// "these runs were free".
		expect(summary.totalCost).toBe(0);
		expect(summary.totalTokens).toBe(tokens.total);

		// Backward compatibility: an entry with no usageKnown/costKnown fields at all counts as known.
		// (Own baseDir, so the unknown-flag records above stay out of this summary.)
		const legacy = createUsageLedger({ baseDir: join(dir, "legacy") });
		recordAt(legacy, "2026-07-04T00:00:00Z", {
			channelId: "c1",
			kind: "turn",
			model: "m/a",
			usage: tokens,
			cost: cost(0.1),
		});
		await flush(legacy);
		const legacySummary = await legacy.summarize({
			since: new Date("2026-07-01T00:00:00Z"),
			until: new Date("2026-07-31T00:00:00Z"),
		});
		expect(legacySummary.unknownCostCount).toBe(0);
		expect(legacySummary.unknownUsageCount).toBe(0);
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
		await flush(ledger);

		const entries = readMonth("2026-07");
		expect(entries[0]?.channelId).toBe("(untracked)");
		expect(warnSpy).toHaveBeenCalled();
	});

	it("aggregates by kind/model/channel, honors channel + time filters, and crosses month boundaries", async () => {
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
		await flush(ledger);

		const window = { since: new Date("2026-07-01T00:00:00Z"), until: new Date("2026-07-31T00:00:00Z") };
		const all = await ledger.summarize(window);
		expect(all.totalCost).toBeCloseTo(0.7);
		expect(all.entryCount).toBe(3);
		expect(all.byKind.turn).toBeCloseTo(0.5);
		expect(all.byKind.subagent).toBeCloseTo(0.2);
		expect(all.byChannel.c1).toBeCloseTo(0.3);

		const c1 = await ledger.summarize({ ...window, channelId: "c1" });
		expect(c1.totalCost).toBeCloseTo(0.3);
		expect(c1.byModel["m/b"]).toBeUndefined();

		// A window spanning June and July reads both monthly files.
		recordAt(ledger, "2026-06-30T12:00:00Z", {
			channelId: "c1",
			kind: "turn",
			model: "m/a",
			usage: tokens,
			cost: cost(0.1),
		});
		await flush(ledger);
		const spanning = await ledger.summarize({
			since: new Date("2026-06-29T00:00:00Z"),
			until: new Date("2026-07-02T00:00:00Z"),
		});
		expect(spanning.totalCost).toBeCloseTo(0.1);
		expect(spanning.entryCount).toBe(1);
	});
});
