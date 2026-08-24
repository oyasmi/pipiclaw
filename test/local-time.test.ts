import { describe, expect, it } from "vitest";
import { formatLocalTime, localDayKey, parseLocalTime, parseWakeInput } from "../src/shared/local-time.js";

// Test TZ is pinned to Asia/Shanghai (+08:00) in vitest.config.ts.

describe("formatLocalTime", () => {
	it("formats with a local offset and round-trips through parseLocalTime", () => {
		const formatted = formatLocalTime(new Date("2026-07-27T09:36:29.000Z"));
		expect(formatted).not.toMatch(/Z$/);
		expect(formatted).toBe("2026-07-27T17:36:29.000+08:00");
		expect(parseLocalTime(formatted)).toBe(new Date("2026-07-27T09:36:29.000Z").getTime());
	});
});

describe("parseLocalTime", () => {
	it("resolves host-tz, legacy UTC 'Z', and explicit non-host offsets to the same instant", () => {
		expect(parseLocalTime("2026-07-27T07:30:00")).toBe(new Date("2026-07-26T23:30:00.000Z").getTime());
		expect(parseLocalTime("2026-07-27T23:30:00.000Z")).toBe(new Date("2026-07-27T23:30:00.000Z").getTime());
		expect(parseLocalTime("2026-07-27T07:30:00-05:00")).toBe(new Date("2026-07-27T12:30:00.000Z").getTime());
	});

	it("interprets a bare date as local midnight — not UTC midnight (H-2)", () => {
		// This is the ECMAScript trap this module exists to avoid: new Date("2026-07-27")
		// resolves to UTC midnight, silently landing on the wrong local calendar day.
		const localMidnight = new Date(2026, 6, 27).getTime();
		expect(parseLocalTime("2026-07-27")).toBe(localMidnight);
		expect(parseLocalTime("2026-07-27")).not.toBe(new Date("2026-07-27").getTime());
	});

	it("rejects out-of-range or unparseable input instead of letting Date roll over", () => {
		for (const input of [
			"2026-13-01T00:00:00",
			"2026-02-30T00:00:00",
			"2026-07-27T25:00:00",
			"2026-07-27T00:60:00",
			"2026-07-27T00:00:60",
			"2026-07-32",
			"2026-07-27T07:30:00+24:00",
			"2026-07-27T07:30:00+08:60",
			"soon",
		]) {
			expect(parseLocalTime(input)).toBeUndefined();
		}
	});
});

describe("parseWakeInput", () => {
	const now = new Date("2026-07-27T09:36:29.000Z");

	it("parses relative offsets and falls back to absolute local-time parsing", () => {
		expect(parseWakeInput("+2h", now)).toBe(now.getTime() + 2 * 3_600_000);
		expect(parseWakeInput("+45m", now)).toBe(now.getTime() + 45 * 60_000);
		expect(parseWakeInput("+3d", now)).toBe(now.getTime() + 3 * 86_400_000);
		expect(parseWakeInput("-30m", now)).toBe(now.getTime() - 30 * 60_000);
		expect(parseWakeInput("2026-07-27T07:30:00+08:00", now)).toBe(new Date("2026-07-26T23:30:00.000Z").getTime());
	});
});

describe("localDayKey", () => {
	it("keys by the host-local calendar day, not the UTC day", () => {
		// 2026-07-27T23:30:00Z is 2026-07-28 local under +08:00.
		expect(localDayKey(new Date("2026-07-27T23:30:00.000Z"))).toBe("2026-07-28");
	});
});
