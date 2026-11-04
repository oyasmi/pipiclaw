import { basename, dirname } from "node:path";
import type { FileStore } from "../file-store.js";
import * as log from "../log.js";
import { errorMessage } from "../shared/text-utils.js";

/** File events are hints; only the manager may interpret completion artifacts. */
export class JobCompletionObserver {
	private readonly entries = new Map<string, { directory: string; name: string; ready: boolean }>();
	private readonly directories = new Map<string, { handle?: { close(): void }; retryAt: number }>();
	private readonly dirty = new Set<string>();
	private scheduled?: ReturnType<typeof setImmediate>;
	private processing = false;
	private stopped = false;

	constructor(
		private readonly store: FileStore,
		private readonly check: (ids: string[]) => Promise<void>,
	) {}

	add(id: string, exitFile: string, ready = false): void {
		if (this.stopped) return;
		this.entries.set(id, { directory: dirname(exitFile), name: basename(exitFile), ready });
		this.watch(dirname(exitFile));
		if (ready) this.mark(id);
	}

	ready(id: string): void {
		const entry = this.entries.get(id);
		if (entry) {
			entry.ready = true;
			this.mark(id);
		}
	}

	retry(): void {
		for (const directory of this.directories.keys()) this.watch(directory);
	}

	remove(id: string): void {
		const entry = this.entries.get(id);
		this.entries.delete(id);
		this.dirty.delete(id);
		if (entry && ![...this.entries.values()].some((other) => other.directory === entry.directory)) {
			this.directories.get(entry.directory)?.handle?.close();
			this.directories.delete(entry.directory);
		}
	}

	stop(): void {
		this.stopped = true;
		if (this.scheduled) clearImmediate(this.scheduled);
		for (const directory of this.directories.values()) directory.handle?.close();
		this.directories.clear();
		this.entries.clear();
		this.dirty.clear();
	}

	private watch(path: string): void {
		if (this.stopped || !this.store.watchDirectory) return;
		let directory = this.directories.get(path);
		if (!directory) {
			directory = { retryAt: 0 };
			this.directories.set(path, directory);
		}
		if (directory.handle || Date.now() < directory.retryAt) return;
		const failed = (error: unknown) => {
			directory.handle?.close();
			directory.handle = undefined;
			directory.retryAt = Date.now() + 10_000;
			log.logWarn("job.observer.failed", "Background job observation failed", { reason: errorMessage(error) });
		};
		try {
			directory.handle = this.store.watchDirectory(
				path,
				(name) => {
					for (const [id, entry] of this.entries) {
						if (entry.directory === path && (name === undefined || name === entry.name)) this.mark(id);
					}
				},
				failed,
			);
		} catch (error) {
			failed(error);
		}
	}

	private mark(id: string): void {
		this.dirty.add(id);
		if (this.stopped || this.scheduled || this.processing) return;
		this.scheduled = setImmediate(() => {
			this.scheduled = undefined;
			const ids = [...this.dirty].filter((id) => this.entries.get(id)?.ready);
			for (const id of ids) this.dirty.delete(id);
			if (!ids.length || this.stopped) return;
			this.processing = true;
			void this.check(ids)
				.catch((error) =>
					log.logWarn("job.observer.reconcile_failed", "Background job reconcile failed", {
						reason: errorMessage(error),
					}),
				)
				.finally(() => {
					this.processing = false;
					for (const id of this.dirty)
						if (this.entries.get(id)?.ready) {
							this.mark(id);
							break;
						}
				});
		});
	}
}
