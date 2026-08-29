/**
 * Coerce an untrusted numeric config/request value into an integer within `[minimum, maximum]`,
 * falling back to `fallback` for anything not a finite number or out of range. Shared by the
 * app-level config loaders (`tools.json`) and web request parameter resolution — both need the
 * same "trust nothing, fail closed to a safe default" numeric parsing.
 */
export function clampInteger(value: unknown, fallback: number, minimum: number, maximum?: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return fallback;
	}
	const normalized = Math.floor(value);
	if (normalized < minimum) {
		return fallback;
	}
	if (maximum !== undefined && normalized > maximum) {
		return fallback;
	}
	return normalized;
}
