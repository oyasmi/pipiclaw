import {
	type FileFingerprint,
	type FileStat,
	type FileStore,
	fingerprintOf,
	fingerprintsEqual,
} from "../file-store.js";

export function createFileObservations(capacity = 256) {
	const observed = new Map<string, FileFingerprint>();
	const previous = (target: string) => {
		const value = observed.get(target);
		if (value) {
			observed.delete(target);
			observed.set(target, value);
		}
		return value;
	};
	return {
		record(target: string, stat: FileStat) {
			if (!stat.isFile) return;
			observed.delete(target);
			observed.set(target, fingerprintOf(stat));
			if (observed.size > capacity) {
				const oldest = observed.keys().next().value;
				if (oldest !== undefined) observed.delete(oldest);
			}
		},
		describeWriteNote(target: string, path: string, before?: FileStat) {
			if (!before?.isFile || before.size === 0) return undefined;
			const last = previous(target);
			if (!last) {
				return `Note: Overwrote existing file ${path} (${before.size} bytes) without reading it first in this session; inspect git diff if unintended.`;
			}
			if (!fingerprintsEqual(last, fingerprintOf(before))) {
				return `Note: ${path} had been modified externally since you last read or wrote it; verify no concurrent changes were lost.`;
			}
		},
		describeEditNote(target: string, path: string, before: FileStat) {
			const last = previous(target);
			if (last && !fingerprintsEqual(last, fingerprintOf(before))) {
				return `Note: ${path} was modified since your last read; review surrounding context if needed.`;
			}
		},
	};
}

export type FileObservations = ReturnType<typeof createFileObservations>;

/** A metadata error after a successful write must not turn it into a failed tool call. */
export async function observeCurrentFile(observations: FileObservations | undefined, store: FileStore, target: string) {
	if (!observations) return;
	const stat = await store.stat(target).catch(() => undefined);
	if (stat) observations.record(target, stat);
}
