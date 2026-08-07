/**
 * Split a shell-style command line into argv tokens, respecting single/double quotes and
 * backslash escapes, without invoking a shell (spec 040, D4 — external delegation runs never go
 * through `sh -c`, so the "argv, not a shell string" guarantee has to start at tokenization).
 *
 * This is word-splitting only: no globbing, no variable expansion, no command substitution.
 * An unterminated quote is tolerated by treating the rest of the string as part of that token.
 */
export function splitShellWords(command: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let inToken = false;
	let quote: "'" | '"' | undefined;

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];

		if (quote) {
			if (ch === quote) {
				quote = undefined;
			} else if (quote === '"' && ch === "\\" && i + 1 < command.length && /["\\$`]/.test(command[i + 1])) {
				current += command[++i];
			} else {
				current += ch;
			}
			continue;
		}

		if (ch === "'" || ch === '"') {
			quote = ch;
			inToken = true;
			continue;
		}

		if (ch === "\\" && i + 1 < command.length) {
			current += command[++i];
			inToken = true;
			continue;
		}

		if (/\s/.test(ch)) {
			if (inToken) {
				tokens.push(current);
				current = "";
				inToken = false;
			}
			continue;
		}

		current += ch;
		inToken = true;
	}

	if (inToken) tokens.push(current);
	return tokens;
}
