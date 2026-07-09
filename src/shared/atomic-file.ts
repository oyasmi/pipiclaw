import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export function createAtomicTempPath(path: string): string {
	return `${path}.${process.pid}.${randomUUID()}.tmp`;
}

export async function writeFileAtomically(
	path: string,
	content: string,
	tempPath = createAtomicTempPath(path),
): Promise<void> {
	const dir = dirname(path);
	await mkdir(dir, { recursive: true });
	try {
		const handle = await open(tempPath, "w");
		try {
			await handle.writeFile(content, "utf-8");
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
