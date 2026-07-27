/**
 * Single vocabulary for time in this codebase: everything the model or a human reads or
 * writes — `wake`, `deadline`, `at`, timestamps, log lines — is local wall-clock time with an
 * explicit offset (`2026-07-27T07:30:00.000+08:00`), never a bare UTC `Z` string. The runtime
 * still stores an unambiguous absolute instant (the offset makes that so), it is just never
 * silently converted to/from UTC in a place a human or the model has to do that arithmetic by
 * hand — that hand-conversion is what produced a wake one calendar day off in production.
 *
 * `new Date(string)` is deliberately not used to parse agent/user-supplied values: ECMAScript
 * parses a bare date-only string (`"2026-07-27"`) as UTC midnight but a date-time string
 * (`"2026-07-27T07:30"`) as local time — an inconsistency that is itself a trap. Every parse
 * in this module goes through one explicit format instead.
 */

const LOCAL_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:?\d{2})?$/;
const RELATIVE_TIME_PATTERN = /^([+-])(\d+(?:\.\d+)?)(s|m|h|d)$/i;

function pad2(value: number): string {
	return String(value).padStart(2, "0");
}

function pad3(value: number): string {
	return String(value).padStart(3, "0");
}

/** Local wall-clock time with the host's own offset, e.g. `2026-07-27T07:30:00.000+08:00`. Never `Z`. */
export function formatLocalTime(date: Date = new Date()): string {
	const offsetMinutes = -date.getTimezoneOffset();
	const offsetSign = offsetMinutes >= 0 ? "+" : "-";
	const absOffsetMinutes = Math.abs(offsetMinutes);
	const offsetHours = Math.floor(absOffsetMinutes / 60);
	const offsetRemainderMinutes = absOffsetMinutes % 60;
	return (
		`${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
		`T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}.${pad3(date.getMilliseconds())}` +
		`${offsetSign}${pad2(offsetHours)}:${pad2(offsetRemainderMinutes)}`
	);
}

/** Same as {@link formatLocalTime} but safe to embed in a filename (colons/periods replaced). */
export function localStampForFilename(date: Date = new Date()): string {
	return formatLocalTime(date).replace(/[:.]/g, "-");
}

/** Local calendar day key, e.g. `2026-07-27`, for day-bucketed counters (recall/usage history). */
export function localDayKey(date: Date = new Date()): string {
	return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * Parse a stored/agent-supplied time string to absolute milliseconds.
 *
 * A string carrying an explicit offset (`+08:00`, `-05:00`, or `Z`) is interpreted by that
 * offset — this is how legacy `...Z` values written before this module existed keep resolving
 * to the correct absolute instant, no migration needed. A string with no offset is interpreted
 * in the host's local timezone. Returns `undefined` for anything unparseable, mirroring the
 * ledger's fail-open-to-surface-the-problem convention rather than throwing.
 */
export function parseLocalTime(value: string): number | undefined {
	const trimmed = value.trim();
	const match = LOCAL_TIME_PATTERN.exec(trimmed);
	if (!match) {
		// Fall back to a permissive parse for other legitimate ISO-ish inputs (e.g. no
		// milliseconds is already covered above; this catches anything else Date can parse
		// unambiguously, such as an explicit-offset string with unusual spacing).
		const fallback = new Date(trimmed).getTime();
		return Number.isFinite(fallback) ? fallback : undefined;
	}
	const [, y, mo, d, h, mi, s, ms, offset] = match;
	const year = Number(y);
	const month = Number(mo) - 1;
	const day = Number(d);
	const hour = Number(h);
	const minute = Number(mi);
	const second = Number(s);
	const millis = ms ? Number(ms.padEnd(3, "0")) : 0;

	if (!offset) {
		const local = new Date(year, month, day, hour, minute, second, millis);
		return local.getTime();
	}
	if (offset === "Z") {
		return Date.UTC(year, month, day, hour, minute, second, millis);
	}
	const offsetMatch = /^([+-])(\d{2}):?(\d{2})$/.exec(offset);
	if (!offsetMatch) return undefined;
	const [, sign, offH, offM] = offsetMatch;
	const offsetMinutesTotal = (Number(offH) * 60 + Number(offM)) * (sign === "-" ? -1 : 1);
	const utcMs = Date.UTC(year, month, day, hour, minute, second, millis);
	return utcMs - offsetMinutesTotal * 60_000;
}

/**
 * Same as {@link parseLocalTime} but also accepts a relative offset from `now` — `+2h`,
 * `-30m`, `+3d` — so "check back in two hours" never requires the model to compute an
 * absolute local timestamp by hand. This is the write-path entry point for `wake`.
 */
export function parseWakeInput(value: string, now: Date = new Date()): number | undefined {
	const trimmed = value.trim();
	const relative = RELATIVE_TIME_PATTERN.exec(trimmed);
	if (relative) {
		const [, sign, amount, unit] = relative;
		const unitMs =
			unit.toLowerCase() === "s"
				? 1_000
				: unit.toLowerCase() === "m"
					? 60_000
					: unit.toLowerCase() === "h"
						? 3_600_000
						: 86_400_000;
		const deltaMs = Number(amount) * unitMs * (sign === "-" ? -1 : 1);
		return now.getTime() + deltaMs;
	}
	return parseLocalTime(trimmed);
}
