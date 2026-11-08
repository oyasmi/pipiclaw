/**
 * The command guard: decides whether a shell command may run, against the configured allow/deny
 * rules and a wrapper-aware scan of every place a command can start.
 */
import { basename } from "node:path";
import { SHELL_DYNAMIC, ShellSyntaxError, shellCommands } from "./shell-parse.js";
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

function parseShellWords(command: string): string[] {
	const commands = shellCommands(command);
	if (commands.length > 1) throw new ShellSyntaxError("Expected one command");
	return commands[0] ?? [];
}

function splitCommandChain(command: string): string[] {
	return shellCommands(command).map((words) => words.join(" "));
}

function parsedFromWords(words: string[]): ParsedCommand | null {
	if (words.length === 0) {
		return null;
	}
	if (
		words[0].includes(SHELL_DYNAMIC.substitution) ||
		words[0].includes(SHELL_DYNAMIC.expansion) ||
		words[0].includes(SHELL_DYNAMIC.glob) ||
		/[*?[\]{}]/.test(words[0])
	)
		throw new ShellSyntaxError("Dynamic executable is unsupported");
	const normalizedCommand = basename(words[0]).toLowerCase();
	const args = words.slice(1);
	return {
		command: normalizedCommand,
		args,
		normalized: [normalizedCommand, ...args].join(" ").trim(),
	};
}

function parseCommand(command: string): ParsedCommand | null {
	return parsedFromWords(parseShellWords(command));
}

// Shells that take a script body as a `-c` argument; the body must be guarded
// recursively because its dangerous content is hidden inside a single token.
const SHELL_COMMANDS = new Set(["sh", "bash", "zsh", "dash", "ash", "ksh"]);

// Wrappers that run another command passed as their operands. The inner command
// must be guarded too, otherwise e.g. `xargs rm -rf` or `timeout 5 shred x`
// would slip past the direct-command rules.
const WRAPPER_COMMANDS = new Set([
	"xargs",
	"env",
	"time",
	"nice",
	"ionice",
	"nohup",
	"timeout",
	"stdbuf",
	"setsid",
	"chrt",
	"parallel",
]);

const MAX_GUARD_DEPTH = 6;

// Shell option clusters may put c anywhere (-lc, -cl). After the first script,
// further operands are positional parameters, not more shell options.
function extractShellScripts(parsed: ParsedCommand): string[] {
	if (!SHELL_COMMANDS.has(parsed.command)) return [];
	for (let i = 0; i < parsed.args.length; i++) {
		const arg = parsed.args[i];
		if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg)) {
			if (parsed.args[i + 1] === undefined) throw new ShellSyntaxError("Missing shell script");
			return [parsed.args[i + 1]];
		}
		if (!/^-[a-zA-Z]+$/.test(arg) || /^--/.test(arg)) throw new ShellSyntaxError("Unsupported shell invocation");
	}
	throw new ShellSyntaxError("Shell invocation without a literal -c script");
}

const FIND_OPERANDS = new Set([
	"-name",
	"-iname",
	"-path",
	"-ipath",
	"-wholename",
	"-iwholename",
	"-regex",
	"-iregex",
	"-type",
	"-xtype",
	"-size",
	"-perm",
	"-user",
	"-group",
	"-uid",
	"-gid",
	"-links",
	"-inum",
	"-mtime",
	"-mmin",
	"-ctime",
	"-cmin",
	"-atime",
	"-amin",
	"-newer",
	"-anewer",
	"-cnewer",
	"-printf",
	"-fprint",
	"-fprint0",
	"-fls",
	"-maxdepth",
	"-mindepth",
	"-regextype",
	"-files0-from",
]);
function findActions(parsed: ParsedCommand): { commands: string[][]; deletes: boolean } {
	const actions = { commands: [] as string[][], deletes: false };
	if (parsed.command !== "find") return actions;
	for (let i = 0; i < parsed.args.length; i++) {
		const arg = parsed.args[i];
		if (FIND_OPERANDS.has(arg) || /^-newer[acmBt][acmBt]$/.test(arg)) {
			i++;
			continue;
		}
		if (arg === "-fprintf") {
			i += 2;
			continue;
		}
		if (arg === "-delete") actions.deletes = true;
		if (!["-exec", "-execdir", "-ok", "-okdir"].includes(arg)) continue;
		const words: string[] = [];
		while (++i < parsed.args.length && ![";", "+"].includes(parsed.args[i])) words.push(parsed.args[i]);
		if (!words.length || i === parsed.args.length) throw new ShellSyntaxError("Unterminated find execution");
		actions.commands.push(words);
	}
	return actions;
}

// Only wrapper options with known operand counts are accepted. Never treat an operand as
// another executable (e.g. env printf '%s' 'rm -rf /'), or stop scanning after a token budget.
const WRAPPER_OPTIONS: Record<string, [string[], string[]]> = {
	env: [
		["-i", "--ignore-environment", "-0", "--null"],
		["-u", "--unset", "-C", "--chdir"],
	],
	time: [
		["-p", "-v", "--verbose", "-a", "--append"],
		["-f", "--format", "-o", "--output"],
	],
	nice: [[], ["-n", "--adjustment"]],
	ionice: [
		["-t", "--ignore"],
		["-c", "--class", "-n", "--classdata", "-p", "-P", "-u"],
	],
	nohup: [[], []],
	timeout: [
		["--preserve-status", "--foreground", "-v", "--verbose"],
		["-s", "--signal", "-k", "--kill-after"],
	],
	stdbuf: [[], ["-i", "-o", "-e", "--input", "--output", "--error"]],
	setsid: [["-c", "--ctty", "-f", "--fork", "-w", "--wait"], []],
	chrt: [
		["-b", "-f", "-i", "-o", "-r", "-d", "-R", "-a", "--all-tasks"],
		["-T", "-P", "-D"],
	],
	xargs: [
		["-0", "--null", "-r", "--no-run-if-empty", "-t", "--verbose", "-p", "--interactive", "-x"],
		[
			"-n",
			"--max-args",
			"-P",
			"--max-procs",
			"-I",
			"-d",
			"--delimiter",
			"-s",
			"--max-chars",
			"-L",
			"--max-lines",
			"-E",
			"--eof",
		],
	],
	parallel: [
		["--will-cite", "--keep-order", "-k", "-0", "--null"],
		["-j", "--jobs", "-I", "--replace", "--colsep"],
	],
};
function extractWrapperCandidates(parsed: ParsedCommand): string[][] {
	if (!WRAPPER_COMMANDS.has(parsed.command)) return [];
	const [flags, operands] = WRAPPER_OPTIONS[parsed.command];
	let i = 0;
	while (i < parsed.args.length) {
		const arg = parsed.args[i];
		if (arg === "--") {
			i++;
			break;
		}
		if (parsed.command === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
			if (Object.values(SHELL_DYNAMIC).some((tag) => arg.includes(tag)))
				throw new ShellSyntaxError("Dynamic wrapper environment is unsupported");
			i++;
			continue;
		}
		if (parsed.command === "nice" && /^-\d+$/.test(arg)) {
			i++;
			continue;
		}
		if (!arg.startsWith("-")) break;
		if (parsed.command === "xargs" && (arg.startsWith("-I") || arg.startsWith("--replace")))
			throw new ShellSyntaxError("xargs template substitution is unsupported");
		if (flags.includes(arg)) {
			i++;
			continue;
		}
		if (operands.includes(arg)) {
			if (++i >= parsed.args.length) throw new ShellSyntaxError("Missing wrapper option operand");
			i++;
			continue;
		}
		if (
			operands.some((option) =>
				option.startsWith("--")
					? arg.startsWith(`${option}=`)
					: arg.startsWith(option) && arg.length > option.length,
			)
		) {
			i++;
			continue;
		}
		throw new ShellSyntaxError("Unsupported wrapper option");
	}
	if (["timeout", "chrt"].includes(parsed.command)) i++;
	if (i >= parsed.args.length) return [];
	const words = parsed.args.slice(i);
	if (words[0].startsWith("-")) throw new ShellSyntaxError("Unresolved wrapper executable");
	if (parsed.command === "parallel") {
		const boundary = words.findIndex((word) => word === ":::" || word === "::::");
		const template = boundary < 0 ? words : words.slice(0, boundary);
		if (!template.length) throw new ShellSyntaxError("Missing parallel template");
		// Literal operands stay operands. GNU parallel's command-template operators and shell
		// substitution combinations need a richer grammar; do not guess at those boundaries.
		if (template.slice(1).some((word) => /[;&|`$()<>]/.test(word)))
			throw new ShellSyntaxError("Complex parallel templates are unsupported");
		const quote = (word: string) => `'${word.replace(/'/g, "'\\''")}'`;
		return shellCommands([template[0], ...template.slice(1).map(quote)].join(" "));
	}
	return [words];
}

// An allow pattern exempts an atom only when it matches that atom's command
// line from the start at a word boundary (exact, or a `pattern + space` prefix).
// This replaces the old whole-command substring test that let an allowed
// fragment whitelist an entire chain (e.g. "git status" -> "git status; rm -rf /").
function atomAllowed(atomNormalized: string, allowPatterns: string[]): boolean {
	return allowPatterns.some((pattern) => {
		const trimmed = pattern.trim();
		if (!trimmed) {
			return false;
		}
		return atomNormalized === trimmed || atomNormalized.startsWith(`${trimmed} `);
	});
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

interface CompiledDenyPattern {
	pattern: string;
	regex: RegExp;
}

/**
 * `matchRule` runs once per atom per recursion level, so compiling the configured patterns inside
 * it recompiled the same regexes many times for a single guarded command. The list comes from
 * `security.json` and is rebuilt only when that file is reloaded, so caching on its identity is
 * enough. Invalid patterns are dropped here, once, instead of throwing on every evaluation.
 */
const denyPatternCache = new WeakMap<string[], CompiledDenyPattern[]>();

function compileDenyPatterns(patterns: string[]): CompiledDenyPattern[] {
	const cached = denyPatternCache.get(patterns);
	if (cached) {
		return cached;
	}
	const compiled: CompiledDenyPattern[] = [];
	for (const pattern of patterns) {
		try {
			compiled.push({ pattern, regex: new RegExp(pattern, "i") });
		} catch {
			// Ignore invalid user patterns.
		}
	}
	denyPatternCache.set(patterns, compiled);
	return compiled;
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

	const find = findActions(parsed);
	if (find.deletes || find.commands.some((words) => basename(words[0]).toLowerCase() === "rm")) {
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
			(parsed.command === "node" && parsed.args.includes("-e") && /\b(child_process|exec|spawn)\b/.test(argsText))
		) {
			return {
				category: "obfuscation",
				rule: parsed.command,
				reason: "Obfuscated command execution is not allowed",
				matchedText: normalized,
			};
		}
	}

	for (const { pattern, regex } of compileDenyPatterns(config.additionalDenyPatterns)) {
		if (regex.test(normalized)) {
			return {
				category: "configured-command-deny",
				rule: pattern,
				reason: "Command matched a configured deny pattern",
				matchedText: normalized,
			};
		}
	}

	return null;
}

// Evaluate a single already-parsed atom: its direct rule, plus any commands it
// wraps (shell `-c` bodies, find `-exec`, generic wrappers), recursively.
function inspectParsed(
	parsed: ParsedCommand,
	config: SecurityConfig["commandGuard"],
	depth: number,
	templateSubstitution = false,
): CommandRuleMatch | null {
	if (
		!WRAPPER_COMMANDS.has(parsed.command) &&
		!["echo", "printf"].includes(parsed.command) &&
		parsed.args.some((arg) => arg.includes(SHELL_DYNAMIC.expansion) || arg.includes(SHELL_DYNAMIC.substitution))
	)
		throw new ShellSyntaxError("Dynamic command operands are unsupported");
	if (
		!WRAPPER_COMMANDS.has(parsed.command) &&
		!["echo", "printf", "ls", "cat", "head", "tail", "wc", "sort", "uniq", "cut", "tr", "grep", "rg", "sed"].includes(
			parsed.command,
		) &&
		parsed.args.some((arg) => arg.includes(SHELL_DYNAMIC.glob))
	)
		throw new ShellSyntaxError("Dynamic pathname operands are unsupported for this command");
	const direct = atomAllowed(parsed.normalized, config.allowPatterns) ? null : matchRule(parsed, config);
	if (direct) {
		return direct;
	}

	if (depth >= MAX_GUARD_DEPTH) {
		throw new ShellSyntaxError("Command recursion limit");
	}

	for (const script of extractShellScripts(parsed)) {
		if (templateSubstitution && script.includes("{}"))
			throw new ShellSyntaxError("Template substitution into shell scripts is unsupported");
		const nested = evaluateCommand(script, config, depth + 1);
		if (nested) {
			return nested;
		}
	}

	for (const words of [...findActions(parsed).commands, ...extractWrapperCandidates(parsed)]) {
		const innerParsed = parsedFromWords(words);
		if (innerParsed) {
			const nested = inspectParsed(
				innerParsed,
				config,
				depth + 1,
				templateSubstitution || parsed.command === "find" || parsed.command === "parallel",
			);
			if (nested) {
				return nested;
			}
		}
	}

	return null;
}

function evaluateCommand(
	command: string,
	config: SecurityConfig["commandGuard"],
	depth: number,
): CommandRuleMatch | null {
	const commands = shellCommands(command);
	if (
		config.blockObfuscation &&
		commands.some(
			(words, index) =>
				words[0] === "base64" &&
				words.some((arg) => arg === "-d" || arg === "--decode") &&
				SHELL_COMMANDS.has(commands[index + 1]?.[0]),
		)
	) {
		return {
			category: "obfuscation",
			rule: "decoded-shell",
			reason: "Decoded shell input is not allowed",
			matchedText: command,
		};
	}
	for (const words of commands) {
		const parsed = parsedFromWords(words);
		if (!parsed) continue;
		const match = inspectParsed(parsed, config, depth);
		if (match) return match;
	}

	return null;
}

export function guardCommand(command: string, config: SecurityConfig["commandGuard"]): CommandGuardResult {
	if (!config.enabled) {
		return { allowed: true };
	}

	let match: CommandRuleMatch | null;
	try {
		match = evaluateCommand(command, config, 0);
	} catch (error) {
		if (!(error instanceof ShellSyntaxError)) throw error;
		return {
			allowed: false,
			category: "unsupported-shell",
			rule: "shell-parse",
			reason: `${error.message}. Use literal simple commands or separate tool calls.`,
			matchedText: command,
		};
	}
	if (match) {
		return {
			allowed: false,
			category: match.category,
			rule: match.rule,
			reason: match.reason,
			matchedText: match.matchedText,
		};
	}

	return { allowed: true };
}

export const internalCommandGuard = {
	parseShellWords,
	parseCommand,
	splitCommandChain,
};
