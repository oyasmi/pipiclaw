import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export function createAtomicTempPath(path: string): string {
	return `${path}.${process.pid}.${randomUUID()}.tmp`;
}

export async function writeFileAtomically(
	path: string,
	content: string,
	tempPath = createAtomicTempPath(path),
): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	try {
		await writeFile(tempPath, content, "utf-8");
		await rename(tempPath, path);
	} catch (error) {
		await unlink(tempPath).catch(() => undefined);
		throw error;
	}
}
