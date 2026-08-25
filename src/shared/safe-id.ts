import { join, resolve, sep } from "node:path";

export interface SafeIdOptions {
	/** File suffix to strip (e.g. `.md`, `.json`) and re-append when resolving a path. */
	suffix: string;
	/** Allowed id characters after suffix stripping. */
	pattern: RegExp;
	/** Used in error messages, e.g. "task id", "event name". */
	label: string;
}

/** Validate/normalize an id (a file basename minus its suffix), rejecting path traversal. */
export function normalizeSafeId(id: string, options: SafeIdOptions): string {
	const trimmed = id.trim();
	const normalized = trimmed.endsWith(options.suffix) ? trimmed.slice(0, -options.suffix.length) : trimmed;
	if (!normalized || normalized === "." || normalized === ".." || !options.pattern.test(normalized)) {
		throw new Error(`Invalid ${options.label}: ${id}`);
	}
	return normalized;
}

/**
 * {@link normalizeSafeId}, then resolves the id to a path confined under `dir` — defense in
 * depth beyond the pattern check, for the one caller (`event_manage`) whose directory is
 * agent-writable.
 */
export function resolveSafeIdPath(dir: string, id: string, options: SafeIdOptions): { id: string; path: string } {
	const normalizedId = normalizeSafeId(id, options);
	const resolvedDir = resolve(dir);
	const path = resolve(resolvedDir, `${normalizedId}${options.suffix}`);
	if (path !== join(resolvedDir, `${normalizedId}${options.suffix}`) || !path.startsWith(`${resolvedDir}${sep}`)) {
		throw new Error(`Invalid ${options.label}: ${id}`);
	}
	return { id: normalizedId, path };
}
