import { describe, expect, it } from "vitest";
import { formatLocalTime, localDayKey, parseLocalTime, parseWakeInput } from "../src/shared/local-time.js";

// Test TZ is pinned to Asia/Shanghai (+08:00) in vitest.config.ts.

describe("formatLocalTime", () => {
	it("never produces a bare UTC Z timestamp", () => {
		const formatted = formatLocalTime(new Date("2026-07-27T09:36:29.000Z"));
		expect(formatted).not.toMatch(/Z$/);
		expect(formatted).toBe("2026-07-27T17:36:29.000+08:00");
	});

	it("round-trips through parseLocalTime to the same instant", () => {
		const original = new Date("2026-07-27T09:36:29.123Z");
		const formatted = formatLocalTime(original);
		expect(parseLocalTime(formatted)).toBe(original.getTime());
	});
});

describe("parseLocalTime", () => {
	it("interprets an offset-less local timestamp in the host timezone", () => {
		// 2026-07-27T07:30:00 with no offset, host TZ +08:00 => 2026-07-26T23:30:00Z.
		expect(parseLocalTime("2026-07-27T07:30:00")).toBe(new Date("2026-07-26T23:30:00.000Z").getTime());
	});

	it("still resolves a legacy UTC 'Z' value to the correct absolute instant", () => {
		expect(parseLocalTime("2026-07-27T23:30:00.000Z")).toBe(new Date("2026-07-27T23:30:00.000Z").getTime());
	});

	it("honours an explicit non-host offset", () => {
		expect(parseLocalTime("2026-07-27T07:30:00-05:00")).toBe(new Date("2026-07-27T12:30:00.000Z").getTime());
	});

	it("returns undefined for unparseable input", () => {
		expect(parseLocalTime("soon")).toBeUndefined();
		expect(parseLocalTime("not-a-date")).toBeUndefined();
	});

	it("interprets a bare date, with or without a time component, as local midnight — not UTC midnight (H-2)", () => {
		// This is the ECMAScript trap this module exists to avoid: new Date("2026-07-27")
		// resolves to UTC midnight, silently landing on the wrong local calendar day. Regression:
		// the regex-miss fallback used to hand a date-only string straight to `new Date(...)`,
		// hitting the same trap.
		const localMidnight = new Date(2026, 6, 27).getTime();
		expect(parseLocalTime("2026-07-27T00:00:00")).toBe(localMidnight);
		expect(parseLocalTime("2026-07-27")).toBe(localMidnight);
		expect(parseLocalTime("2026-07-27")).not.toBe(new Date("2026-07-27").getTime());
	});

	it("rejects out-of-range month/day/hour/minute/second instead of letting Date roll them over", () => {
		expect(parseLocalTime("2026-13-01T00:00:00")).toBeUndefined();
		expect(parseLocalTime("2026-02-30T00:00:00")).toBeUndefined();
		expect(parseLocalTime("2026-07-27T25:00:00")).toBeUndefined();
		expect(parseLocalTime("2026-07-27T00:60:00")).toBeUndefined();
		expect(parseLocalTime("2026-07-27T00:00:60")).toBeUndefined();
		expect(parseLocalTime("2026-07-32")).toBeUndefined();
	});

	it("rejects an out-of-range explicit offset", () => {
		expect(parseLocalTime("2026-07-27T07:30:00+24:00")).toBeUndefined();
		expect(parseLocalTime("2026-07-27T07:30:00+08:60")).toBeUndefined();
	});
});

describe("parseWakeInput", () => {
	const now = new Date("2026-07-27T09:36:29.000Z");

	it("accepts a relative offset from now", () => {
		expect(parseWakeInput("+2h", now)).toBe(now.getTime() + 2 * 3_600_000);
		expect(parseWakeInput("+45m", now)).toBe(now.getTime() + 45 * 60_000);
		expect(parseWakeInput("+3d", now)).toBe(now.getTime() + 3 * 86_400_000);
		expect(parseWakeInput("-30m", now)).toBe(now.getTime() - 30 * 60_000);
	});

	it("falls back to absolute local-time parsing for non-relative input", () => {
		expect(parseWakeInput("2026-07-27T07:30:00+08:00", now)).toBe(new Date("2026-07-26T23:30:00.000Z").getTime());
	});
});

describe("localDayKey", () => {
	it("keys by the host-local calendar day, not the UTC day", () => {
		// 2026-07-27T23:30:00Z is 2026-07-28 local under +08:00.
		expect(localDayKey(new Date("2026-07-27T23:30:00.000Z"))).toBe("2026-07-28");
	});
});
