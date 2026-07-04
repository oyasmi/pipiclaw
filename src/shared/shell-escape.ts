/**
 * Shell-escape a string for safe use in sh -c commands.
 * Wraps in single quotes and escapes internal single quotes.
 */
export function shellEscape(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}
