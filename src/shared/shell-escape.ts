/**
 * Shell-escape a string for safe use in sh -c commands.
 * Wraps in single quotes and escapes internal single quotes.
 */
export function shellEscape(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Normalize filesystem paths for POSIX-style shells.
 * On Windows we convert backslashes to forward slashes so Git Bash/MSYS tools
 * can consume the path consistently.
 */
export function toShellPath(path: string): string {
	return process.platform === "win32" ? path.replace(/\\/g, "/") : path;
}

export function shellEscapePath(path: string): string {
	return shellEscape(toShellPath(path));
}
