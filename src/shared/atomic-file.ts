import { randomUUID } from "node:crypto";
import { mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export function createAtomicTempPath(path: string): string {
	return `${path}.${process.pid}.${randomUUID()}.tmp`;
}

export interface WriteFileAtomicallyOptions {
	tempPath?: string;
	/**
	 * `fchmod` the temp file to the existing target's permission bits before renaming over it, so
	 * an atomic overwrite of an executable file does not silently strip its `x` bit (spec 044,
	 * D1.2). A missing target (first write) leaves the temp file's own default mode untouched.
	 */
	preserveMode?: boolean;
}

async function existingMode(path: string): Promise<number | undefined> {
	try {
		return (await stat(path)).mode & 0o777;
	} catch {
		return undefined;
	}
}

export async function writeFileAtomically(
	path: string,
	content: string | Buffer,
	optionsOrTempPath: WriteFileAtomicallyOptions | string = {},
): Promise<void> {
	const options: WriteFileAtomicallyOptions =
		typeof optionsOrTempPath === "string" ? { tempPath: optionsOrTempPath } : optionsOrTempPath;
	const tempPath = options.tempPath ?? createAtomicTempPath(path);
	const dir = dirname(path);
	await mkdir(dir, { recursive: true });
	try {
		const mode = options.preserveMode ? await existingMode(path) : undefined;
		const handle = await open(tempPath, "w");
		try {
			if (mode !== undefined) {
				await handle.chmod(mode);
			}
			if (typeof content === "string") {
				await handle.writeFile(content, "utf-8");
			} else {
				await handle.writeFile(content);
			}
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(tempPath, path);
		// Best-effort: the rename already succeeded, so a directory-fsync failure
		// (e.g. unsupported on this platform/filesystem) should not surface as a write failure.
		await open(dir, "r")
			.then(async (dirHandle) => {
				try {
					await dirHandle.sync();
				} finally {
					await dirHandle.close();
				}
			})
			.catch(() => undefined);
	} catch (error) {
		await unlink(tempPath).catch(() => undefined);
		throw error;
	}
}
