import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJsonlAppender } from "../src/shared/jsonl-appender.js";

describe("jsonl-appender", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "jsonl-appender-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	function readLines(path: string): unknown[] {
		return readFileSync(path, "utf-8")
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line));
	}

	it("appends records as newline-delimited JSON, lazily creating the directory", async () => {
		const path = join(dir, "nested", "runtime.jsonl");
		const appender = createJsonlAppender({ path });

		await appender.append({ a: 1 });
		await appender.append({ b: "two" });

		expect(readLines(path)).toEqual([{ a: 1 }, { b: "two" }]);
	});

	it("serializes concurrent appends without interleaving", async () => {
		const path = join(dir, "runtime.jsonl");
		const appender = createJsonlAppender({ path });

		await Promise.all(Array.from({ length: 50 }, (_, i) => appender.append({ i })));

		const lines = readLines(path) as { i: number }[];
		expect(lines).toHaveLength(50);
		expect(new Set(lines.map((l) => l.i)).size).toBe(50);
	});

	it("rotates on size limit and keeps maxRotations backups", async () => {
		const path = join(dir, "runtime.jsonl");
		// Each record line is ~14 bytes; cap forces rotation roughly every 2 lines.
		const appender = createJsonlAppender({ path, maxSizeBytes: 20, maxRotations: 2 });

		for (let i = 0; i < 8; i++) {
			await appender.append({ n: i });
		}

		expect(existsSync(path)).toBe(true);
		expect(existsSync(`${path}.1`)).toBe(true);
		expect(existsSync(`${path}.2`)).toBe(true);
		// maxRotations=2 → never a .3
		expect(existsSync(`${path}.3`)).toBe(false);
	});

	it("routes appends to monthly files via pathFor", async () => {
		const appender = createJsonlAppender({
			pathFor: (now) => join(dir, `usage-${now.getUTCFullYear()}-${now.getUTCMonth() + 1}.jsonl`),
		});

		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-15T00:00:00Z"));
		await appender.append({ month: "jan" });
		vi.setSystemTime(new Date("2026-02-15T00:00:00Z"));
		await appender.append({ month: "feb" });
		vi.useRealTimers();

		expect(readLines(join(dir, "usage-2026-1.jsonl"))).toEqual([{ month: "jan" }]);
		expect(readLines(join(dir, "usage-2026-2.jsonl"))).toEqual([{ month: "feb" }]);
	});

	it("never throws on write failure and warns only once", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		// Point at a path whose parent is a file, so mkdir/append fails.
		const filePath = join(dir, "blocker");
		const appender = createJsonlAppender({ path: filePath });
		await appender.append({ ok: true }); // creates the file "blocker"

		const bad = createJsonlAppender({ path: join(filePath, "child.jsonl") });
		await expect(bad.append({ x: 1 })).resolves.toBeUndefined();
		await expect(bad.append({ x: 2 })).resolves.toBeUndefined();

		expect(warnSpy).toHaveBeenCalledTimes(1);
	});
});
