import { readFile } from "fs/promises";

/** Small, dependency-free helpers for talking to the host filesystem and shell. */

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

/**
 * Read a UTF-8 text file, returning "" when it does not exist.
 *
 * Only ENOENT is swallowed — permission/IO errors propagate so callers do not
 * silently treat a real read failure as an absent file.
 */
export async function readOptionalTextFile(path: string): Promise<string> {
	try {
		return await readFile(path, "utf-8");
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			return "";
		}
		throw error;
	}
}

/**
 * Shell-escape a string for safe use in sh -c commands.
 * Wraps in single quotes and escapes internal single quotes.
 */
export function shellEscape(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}
