/** A deliberately bounded shell grammar. Parse executable positions, never scan operands as commands.
 * Unsupported control/expansion syntax throws: guessing a command boundary is unsafe. */
export class ShellSyntaxError extends Error {}

// Raw NUL is refused at the boundary, so literal/quoted text cannot forge these parser tags.
export const SHELL_DYNAMIC = {
	substitution: "\0substitution\0",
	expansion: "\0expansion\0",
	glob: "\0glob\0",
} as const;

export function shellCommands(input: string, backtickDepth = 0): string[][] {
	if (backtickDepth > 32) throw new ShellSyntaxError("Backtick nesting limit");
	if (input.includes("\0")) throw new ShellSyntaxError("NUL in command");
	const commands: string[][] = [];
	let i = 0;
	let nesting = 0;
	const fail = (reason: string): never => {
		throw new ShellSyntaxError(reason);
	};
	function sequence(end?: string): void {
		if (++nesting > 32) fail("Shell nesting limit");
		let words: string[] = [];
		const flush = () => {
			if (words.length) commands.push(words);
			words = [];
		};
		while (i < input.length) {
			const c = input[i];
			if (c === end) {
				flush();
				i++;
				nesting--;
				return;
			}
			if (c === " " || c === "\t" || c === "\r") {
				i++;
				continue;
			}
			if (c === "#") {
				while (i < input.length && input[i] !== "\n") i++;
				continue;
			}
			if (c === "\n" || c === ";" || c === "|" || (c === "&" && input[i + 1] !== ">")) {
				flush();
				i++;
				if ((c === "|" || c === "&") && input[i] === c) i++;
				else if (c === "|" && input[i] === "&") i++;
				continue;
			}
			if (c === "(") {
				if (words.length) fail("Unexpected subshell");
				i++;
				sequence(")");
				continue;
			}
			if (c === ")") fail("Unsupported shell grouping");
			// IO_NUMBER only counts when immediately adjacent to a redirection.
			const fd = /^\d+(?=[<>])/.exec(input.slice(i));
			if (fd) i += fd[0].length;
			if (input[i] === "&" && input[i + 1] === ">") i++;
			if (input[i] === "<" || input[i] === ">") {
				const op = input[i++];
				if (input[i] === "(") {
					i++;
					sequence(")");
					continue;
				}
				if (input[i] === op) {
					i++;
					if (op === "<") fail("Here documents/strings are unsupported");
				}
				if (input[i] === "&" || input[i] === "|" || input[i] === ">") i++;
				while (input[i] === " " || input[i] === "\t") i++;
				if (i >= input.length || /[\n;|&<>]/.test(input[i])) fail("Missing redirection target");
				const target = word(); // substitutions in redirections still execute
				if (Object.values(SHELL_DYNAMIC).some((tag) => target.includes(tag)))
					fail("Dynamic redirection target is unsupported");
				if (/^\/dev\/(?:tcp|udp)\//.test(target)) fail("Shell network redirection is unsupported");
				continue;
			}
			const value = word();
			if (!words.length && value === end) {
				nesting--;
				return;
			}
			if (!words.length && value === "for") {
				forLoop();
				continue;
			}
			if (!words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) continue;
			if (
				!words.length &&
				/^(?:\{|\}|if|then|else|elif|fi|for|while|until|do|done|case|esac|function|select|eval|source|\.|exec|command|builtin|!)$/.test(
					value,
				)
			)
				fail("Unsupported shell control or execution builtin");
			words.push(value);
		}
		if (end) fail("Unclosed shell group");
		flush();
		nesting--;
	}
	function forLoop(): void {
		const space = () => {
			while (input[i] === " " || input[i] === "\t") i++;
		};
		space();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(word())) fail("Invalid for variable");
		space();
		if (word() !== "in") fail("Only explicit for lists are supported");
		space();
		while (i < input.length && input[i] !== ";" && input[i] !== "\n") {
			word();
			space();
		}
		if (i >= input.length) fail("Missing for body");
		i++;
		while (/\s/.test(input[i] ?? "") && i < input.length) i++;
		if (word() !== "do") fail("Missing for do");
		sequence("done");
	}

	function word(): string {
		let value = "";
		let quote = "";
		let consumed = false;
		while (i < input.length) {
			const c = input[i];
			if (!quote && /[\s;|&<>()]/.test(c)) break;
			consumed = true;
			if (c === "\\" && quote !== "'") {
				i++;
				if (i >= input.length) fail("Trailing escape");
				if (input[i] === "\n") {
					i++;
					continue;
				}
				if (quote === '"' && !/[$`"\\]/.test(input[i])) value += "\\";
				value += input[i++];
				continue;
			}
			if (c === "'" || c === '"') {
				if (!quote) {
					quote = c;
					i++;
					continue;
				}
				if (quote === c) {
					quote = "";
					i++;
					continue;
				}
			}
			if (quote !== "'" && c === "$" && input[i + 1] === "(") {
				i += 2;
				if (input[i] === "(") fail("Arithmetic expansion is unsupported");
				sequence(")");
				value += SHELL_DYNAMIC.substitution;
				continue;
			}
			if (quote !== "'" && c === "`") {
				i++;
				let body = "";
				while (i < input.length && input[i] !== "`") {
					if (input[i] === "\\") {
						i++;
						if (i >= input.length) fail("Unclosed backtick");
					}
					body += input[i++];
				}
				if (input[i++] !== "`") fail("Unclosed backtick");
				commands.push(...shellCommands(body, backtickDepth + 1));
				value += SHELL_DYNAMIC.substitution;
				continue;
			}
			if (quote !== "'" && c === "$" && /[\w{['"?*@!#-]/.test(input[i + 1] ?? "")) {
				const expansion =
					/^\$(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[?$!#*@-]|\{[A-Za-z_][A-Za-z0-9_]*\})/.exec(input.slice(i)) ??
					fail("Unsupported shell expansion");
				value += SHELL_DYNAMIC.expansion;
				i += expansion[0].length;
				continue;
			}
			if (!quote && c === "{" && /^\{[^}]*[,.][^}]*\}/.test(input.slice(i))) fail("Brace expansion is unsupported");
			if (!quote && /[*?[]/.test(c)) value += SHELL_DYNAMIC.glob;
			value += c;
			i++;
		}
		if (quote) fail("Unclosed quote");
		if (!consumed) fail("Unexpected shell token");
		return value;
	}
	sequence();
	return commands;
}
