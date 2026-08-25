import type { Readable, Writable } from "node:stream";
import type {
	DirectoryEntry,
	FileStat,
	FileStore,
	ReadBytesOptions,
	ReadBytesResult,
	ReplaceViaTempOptions,
	WriteAtomicOptions,
} from "../../src/file-store.js";

/**
 * A test double for {@link FileStore} that records every call. By default every method throws, so
 * a test asserting "the guard runs before any file I/O" fails loudly if that ordering ever breaks
 * — mirrors `RecordingExecutor`'s role for command tools.
 */
export class RecordingFileStore implements FileStore {
	public readonly calls: string[] = [];

	async stat(path: string): Promise<FileStat | undefined> {
		this.calls.push(`stat:${path}`);
		throw new Error(`RecordingFileStore.stat unexpectedly called for ${path}`);
	}

	async readBytes(path: string, _opts?: ReadBytesOptions): Promise<ReadBytesResult> {
		this.calls.push(`readBytes:${path}`);
		throw new Error(`RecordingFileStore.readBytes unexpectedly called for ${path}`);
	}

	openRead(path: string): Readable {
		this.calls.push(`openRead:${path}`);
		throw new Error(`RecordingFileStore.openRead unexpectedly called for ${path}`);
	}

	async writeAtomic(path: string, _data: Buffer | string, _opts?: WriteAtomicOptions): Promise<void> {
		this.calls.push(`writeAtomic:${path}`);
		throw new Error(`RecordingFileStore.writeAtomic unexpectedly called for ${path}`);
	}

	async replaceViaTemp(
		path: string,
		_produce: (out: Writable) => Promise<void>,
		_opts?: ReplaceViaTempOptions,
	): Promise<void> {
		this.calls.push(`replaceViaTemp:${path}`);
		throw new Error(`RecordingFileStore.replaceViaTemp unexpectedly called for ${path}`);
	}

	async listDirectory(path: string): Promise<DirectoryEntry[]> {
		this.calls.push(`listDirectory:${path}`);
		throw new Error(`RecordingFileStore.listDirectory unexpectedly called for ${path}`);
	}
}
