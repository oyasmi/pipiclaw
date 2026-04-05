import { basename } from "node:path";
import type { CommandGuardResult, SecurityConfig } from "./types.js";

interface ParsedCommand {
	command: string;
	args: string[];
	normalized: string;
}

interface CommandRuleMatch {
	category: string;
	rule: string;
	reason: string;
	matchedText: string;
}

const WHITESPACE = /\s+/;

function stripNullAndNormalize(text: string): string {
	return text.replace(/\0/g, "").normalize("NFKC");
}

function stripComments(command: string): string {
	let result = "";
	let inSingle = false;
	let inDouble = false;
	let escaped = false;

	for (let i = 0; i < command.length; i++) {
		const char = command[i];
		if (escaped) {
			result += char;
			escaped = false;
			continue;
		}
		if (!inSingle && char === "\\") {
			result += char;
			escaped = true;
			continue;
		}
		if (!inDouble && char === "'") {
			inSingle = !inSingle;
			result += char;
			continue;
		}
		if (!inSingle && char === '"') {
			inDouble = !inDouble;
			result += char;
			continue;
		}
		if (!inSingle && !inDouble && char === "#") {
			break;
		}
		result += char;
	}

	return result;
}

function splitCommandChain(command: string): string[] {
	const atoms: string[] = [];
	const normalized = stripComments(stripNullAndNormalize(command));

	function pushAtom(atom: string): void {
		const trimmed = atom.trim();
		if (trimmed) {
			atoms.push(trimmed);
		}
	}

	function walk(input: string): void {
		let buffer = "";
		let inSingle = false;
		let inDouble = false;
		let escaped = false;
		let parenDepth = 0;

		for (let i = 0; i < input.length; i++) {
			const char = input[i];
			const next = input[i + 1];

			if (escaped) {
				buffer += char;
				escaped = false;
				continue;
			}

			if (char === "\\") {
				buffer += char;
				escaped = true;
				continue;
			}

			if (!inDouble && char === "'") {
				inSingle = !inSingle;
				buffer += char;
				continue;
			}

			if (!inSingle && char === '"') {
				inDouble = !inDouble;
				buffer += char;
				continue;
			}

			if (!inSingle && char === "`") {
				let j = i + 1;
				let inner = "";
				let innerEscaped = false;
				while (j < input.length) {
					const innerChar = input[j];
					if (innerEscaped) {
						inner += innerChar;
						innerEscaped = false;
						j++;
						continue;
					}
					if (innerChar === "\\") {
						inner += innerChar;
						innerEscaped = true;
						j++;
						continue;
					}
					if (innerChar === "`") {
						break;
					}
					inner += innerChar;
					j++;
				}
				if (j < input.length) {
					walk(inner);
					buffer += "`subshell`";
					i = j;
					continue;
				}
			}

			if (!inSingle && char === "$" && next === "(") {
				let j = i + 2;
				let inner = "";
				let depth = 1;
				let innerSingle = false;
				let innerDouble = false;
				let innerEscaped = false;
				while (j < input.length) {
					const innerChar = input[j];
					if (innerEscaped) {
						inner += innerChar;
						innerEscaped = false;
						j++;
						continue;
					}
					if (innerChar === "\\") {
						inner += innerChar;
						innerEscaped = true;
						j++;
						continue;
					}
					if (!innerDouble && innerChar === "'") {
						innerSingle = !innerSingle;
						inner += innerChar;
						j++;
						continue;
					}
					if (!innerSingle && innerChar === '"') {
						innerDouble = !innerDouble;
						inner += innerChar;
						j++;
						continue;
					}
					if (!innerSingle && !innerDouble && innerChar === "(") {
						depth++;
						inner += innerChar;
						j++;
						continue;
					}
					if (!innerSingle && !innerDouble && innerChar === ")") {
						depth--;
						if (depth === 0) {
							break;
						}
						inner += innerChar;
						j++;
						continue;
					}
					inner += innerChar;
					j++;
				}
				if (depth === 0) {
					walk(inner);
					buffer += "$(subshell)";
					i = j;
					continue;
				}
			}

			if (!inSingle && !inDouble) {
				if (char === "(") {
					parenDepth++;
				} else if (char === ")" && parenDepth > 0) {
					parenDepth--;
				}

				const separator =
					parenDepth === 0 &&
					(char === ";" ||
						char === "\n" ||
						(char === "|" && next === "|") ||
						(char === "&" && next === "&") ||
						char === "|");

				if (separator) {
					pushAtom(buffer);
					buffer = "";
					if ((char === "|" && next === "|") || (char === "&" && next === "&")) {
						i++;
					}
					continue;
				}
			}

			buffer += char;
		}

		pushAtom(buffer);
	}

	walk(normalized);
	return atoms;
}

function parseShellWords(command: string): string[] {
	const words: string[] = [];
	let buffer = "";
	let inSingle = false;
	let inDouble = false;
	let escaped = false;

	function pushWord(): void {
		if (buffer) {
			words.push(buffer);
			buffer = "";
		}
	}

	for (let i = 0; i < command.length; i++) {
		const char = command[i];
		if (escaped) {
			buffer += char;
			escaped = false;
			continue;
		}
		if (!inSingle && char === "\\") {
			escaped = true;
			continue;
		}
		if (!inDouble && char === "'") {
			inSingle = !inSingle;
			continue;
		}
		if (!inSingle && char === '"') {
			inDouble = !inDouble;
			continue;
		}
		if (!inSingle && !inDouble && WHITESPACE.test(char)) {
			pushWord();
			continue;
		}
		buffer += char;
	}
	pushWord();
	return words;
}

function parseCommand(command: string): ParsedCommand | null {
	const words = parseShellWords(command);
	if (words.length === 0) {
		return null;
	}

	const normalizedCommand = basename(words[0]).toLowerCase();
	const args = words.slice(1);
	return {
		command: normalizedCommand,
		args,
		normalized: [normalizedCommand, ...args].join(" ").trim(),
	};
}

function hasAnyArg(args: string[], values: string[]): boolean {
	return args.some((arg) => values.includes(arg));
}

function hasRecursiveFlag(args: string[]): boolean {
	return args.some((arg) => /^-[^-]*r/.test(arg) || arg === "-R" || arg === "--recursive");
}

function hasForceFlag(args: string[]): boolean {
	return args.some((arg) => /^-[^-]*f/.test(arg) || arg === "--force");
}

function hasDangerousDeletionTarget(args: string[]): boolean {
	return args.some((arg) => ["/", "/*", "~", "~/", "*", "./*", ".", "..", "../", "$HOME", "$HOME/"].includes(arg));
}

function joinedArgs(parsed: ParsedCommand): string {
	return parsed.args.join(" ");
}

function matchRule(parsed: ParsedCommand, config: SecurityConfig["commandGuard"]): CommandRuleMatch | null {
	const argsText = joinedArgs(parsed);
	const normalized = parsed.normalized;

	if (
		parsed.command === "rm" &&
		hasRecursiveFlag(parsed.args) &&
		(hasForceFlag(parsed.args) || hasDangerousDeletionTarget(parsed.args))
	) {
		return {
			category: "destructive-file-op",
			rule: "rm-recursive-force",
			reason: "Recursive deletion with force or dangerous targets is not allowed",
			matchedText: normalized,
		};
	}

	if (parsed.command === "find" && (argsText.includes(" -delete") || /\s-exec\s+rm(?:\s|$)/.test(` ${argsText}`))) {
		return {
			category: "destructive-file-op",
			rule: "find-delete",
			reason: "Destructive find operations are not allowed",
			matchedText: normalized,
		};
	}

	if (["shred", "mkfs", "wipefs"].includes(parsed.command)) {
		return {
			category: "destructive-file-op",
			rule: parsed.command,
			reason: "Irreversible destructive commands are not allowed",
			matchedText: normalized,
		};
	}

	if (["shutdown", "reboot", "halt", "poweroff"].includes(parsed.command)) {
		return {
			category: "system-manipulation",
			rule: parsed.command,
			reason: "System power control commands are not allowed",
			matchedText: normalized,
		};
	}

	if (
		(parsed.command === "systemctl" && hasAnyArg(parsed.args, ["stop", "disable", "mask", "reboot", "poweroff"])) ||
		(parsed.command === "service" && hasAnyArg(parsed.args, ["stop", "restart"])) ||
		(parsed.command === "launchctl" && hasAnyArg(parsed.args, ["unload", "remove", "bootout"])) ||
		(parsed.command === "sysctl" && parsed.args.includes("-w"))
	) {
		return {
			category: "system-manipulation",
			rule: parsed.command,
			reason: "System service or kernel mutation commands are not allowed",
			matchedText: normalized,
		};
	}

	if (
		parsed.command === "sudo" ||
		(parsed.command === "su" && parsed.args[0] === "root") ||
		["passwd", "visudo", "setcap"].includes(parsed.command) ||
		(parsed.command === "chmod" && parsed.args.some((arg) => arg.includes("+s"))) ||
		(parsed.command === "chown" && parsed.args.some((arg) => arg.startsWith("root")))
	) {
		return {
			category: "privilege-escalation",
			rule: parsed.command,
			reason: "Privilege escalation and account mutation commands are not allowed",
			matchedText: normalized,
		};
	}

	if (
		(parsed.command === "kill" &&
			(parsed.args.includes("-9") || parsed.args.includes("-KILL")) &&
			parsed.args.includes("1")) ||
		["killall", "pkill"].includes(parsed.command) ||
		(parsed.command === "history" && hasAnyArg(parsed.args, ["-c", "--clear"])) ||
		(parsed.command === "unset" && parsed.args.includes("HISTFILE")) ||
		normalized.includes("export HISTSIZE=0")
	) {
		return {
			category: "process-manipulation",
			rule: parsed.command,
			reason: "Process-kill or history tampering commands are not allowed",
			matchedText: normalized,
		};
	}

	if (
		(parsed.command === "curl" && parsed.args.includes("--upload-file")) ||
		(parsed.command === "wget" && parsed.args.includes("--post-file")) ||
		(parsed.command === "nc" && parsed.args.some((arg) => /^-[^-]*l/.test(arg) || arg === "--listen")) ||
		(parsed.command === "socat" && /\bexec\b/i.test(argsText)) ||
		normalized.includes("/dev/tcp/") ||
		(normalized.includes("mkfifo") && normalized.includes(" nc")) ||
		(parsed.command === "bash" && parsed.args.includes("-i") && /[>&]/.test(argsText))
	) {
		return {
			category: "network-abuse",
			rule: parsed.command,
			reason: "Network exfiltration or listener setup commands are not allowed",
			matchedText: normalized,
		};
	}

	if (
		parsed.command === "nsenter" ||
		(parsed.command === "docker" &&
			((parsed.args[0] === "run" && parsed.args.includes("--privileged")) ||
				(parsed.args[0] === "exec" && parsed.args.includes("--privileged")) ||
				(parsed.args[0] === "run" && parsed.args.some((arg) => arg.includes("/:")))))
	) {
		return {
			category: "container-escape",
			rule: parsed.command,
			reason: "Container escape and privileged container commands are not allowed",
			matchedText: normalized,
		};
	}

	if (config.blockObfuscation) {
		if (
			/\bbase64\b.*(?:-d|--decode).*?\|\s*(bash|sh|exec|eval)\b/i.test(normalized) ||
			/\beval\s+\$\(/i.test(normalized) ||
			((parsed.command === "python" || parsed.command === "python3") &&
				parsed.args.includes("-c") &&
				/(os\.system|subprocess|exec\(|eval\()/i.test(argsText)) ||
			(parsed.command === "perl" && parsed.args.includes("-e") && /\b(system|exec)\b/.test(argsText)) ||
			(parsed.command === "ruby" && parsed.args.includes("-e") && /\b(system|exec)\b/.test(argsText)) ||
			(parsed.command === "node" && parsed.args.includes("-e") && /\b(child_process|exec|spawn)\b/.test(argsText)) ||
			/\\x[0-9a-f]{2}/i.test(normalized) ||
			/\$'/.test(normalized)
		) {
			return {
				category: "obfuscation",
				rule: parsed.command,
				reason: "Obfuscated command execution is not allowed",
				matchedText: normalized,
			};
		}
	}

	for (const pattern of config.additionalDenyPatterns) {
		try {
			const regex = new RegExp(pattern, "i");
			if (regex.test(normalized)) {
				return {
					category: "configured-command-deny",
					rule: pattern,
					reason: "Command matched a configured deny pattern",
					matchedText: normalized,
				};
			}
		} catch {
			// Ignore invalid user patterns.
		}
	}

	return null;
}

export function guardCommand(command: string, config: SecurityConfig["commandGuard"]): CommandGuardResult {
	if (!config.enabled) {
		return { allowed: true };
	}

	const atoms = splitCommandChain(command);
	const normalizedWhole = stripNullAndNormalize(command);
	for (const allowPattern of config.allowPatterns) {
		if (normalizedWhole.includes(allowPattern)) {
			return { allowed: true };
		}
	}

	if (
		config.blockObfuscation &&
		(/\bbase64\b.*(?:-d|--decode).*?\|\s*(bash|sh|exec|eval)\b/i.test(normalizedWhole) ||
			/\beval\s+\$\(/i.test(normalizedWhole) ||
			/\\x[0-9a-f]{2}/i.test(normalizedWhole) ||
			/\$'/.test(normalizedWhole))
	) {
		return {
			allowed: false,
			category: "obfuscation",
			rule: "obfuscation-whole-command",
			reason: "Obfuscated command execution is not allowed",
			matchedText: normalizedWhole,
		};
	}

	for (const atom of atoms) {
		const parsed = parseCommand(atom);
		if (!parsed) {
			continue;
		}
		const match = matchRule(parsed, config);
		if (match) {
			return {
				allowed: false,
				category: match.category,
				rule: match.rule,
				reason: match.reason,
				matchedText: match.matchedText,
			};
		}
	}

	return { allowed: true };
}

export const internalCommandGuard = {
	parseShellWords,
	parseCommand,
	splitCommandChain,
};
