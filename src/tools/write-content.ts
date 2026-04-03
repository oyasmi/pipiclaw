import type { ExecResult, Executor } from "../sandbox.js";
import { shellEscape } from "../shared/shell-escape.js";

const INLINE_WRITE_MAX_BYTES = 64 * 1024;

function getDir(path: string): string {
	return path.includes("/") ? path.substring(0, path.lastIndexOf("/")) : ".";
}

function isInlineSafe(content: string): boolean {
	return Buffer.byteLength(content, "utf-8") <= INLINE_WRITE_MAX_BYTES;
}

function ensureSuccess(result: ExecResult, path: string): void {
	if (result.code !== 0) {
		throw new Error(result.stderr || `Failed to write file: ${path}`);
	}
}

export async function writeContent(
	executor: Executor,
	path: string,
	content: string,
	signal: AbortSignal | undefined,
	options?: { createParentDir?: boolean },
): Promise<void> {
	const createParentDir = options?.createParentDir ?? false;
	const dirPrefix = createParentDir ? `mkdir -p ${shellEscape(getDir(path))} && ` : "";

	if (isInlineSafe(content)) {
		const result = await executor.exec(`${dirPrefix}printf '%s' ${shellEscape(content)} > ${shellEscape(path)}`, {
			signal,
		});
		ensureSuccess(result, path);
		return;
	}

	const result = await executor.exec(`${dirPrefix}cat > ${shellEscape(path)}`, {
		signal,
		stdin: content,
	});
	ensureSuccess(result, path);
}
