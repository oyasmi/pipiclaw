import { basename } from "node:path";
import type { Executor } from "../executor.js";
import { shellEscape } from "../shared/os.js";
import { IGNORED_DIR_SEGMENTS } from "./ignore-dirs.js";

const rgAvailability = new WeakMap<Executor, Promise<boolean>>();

export function isRgAvailable(executor: Executor): Promise<boolean> {
	let available = rgAvailability.get(executor);
	if (!available) {
		available = Promise.resolve()
			.then(() => executor.exec("command -v rg", { timeout: 2 }))
			.then(
				(result) => result.code === 0,
				() => false,
			);
		rgAvailability.set(executor, available);
	}
	return available;
}

interface SearchCommandOptions {
	mode: "content" | "files" | "count";
	pattern: string;
	target: string;
	glob?: string;
	literal?: boolean;
	caseSensitive?: boolean;
	readDeny: string[];
}

function denyBasenames(entries: string[]): Set<string> {
	const basenames = new Set<string>();
	for (const entry of entries) {
		// A literal basename pushdown can overexclude, so the complete policy still runs on returned paths.
		if (/[*?[\]{}]/.test(entry)) continue;
		const name = basename(entry.replace(/\/+$/, ""));
		if (name && name !== "." && name !== "..") basenames.add(name);
	}
	return basenames;
}

function rgFlags(options: SearchCommandOptions, denied: Set<string>): string[] {
	const flags = ["--no-config", "--null", "--no-messages", "--hidden", "--color=never"];
	if (options.mode === "files") flags.push("--files-with-matches");
	else if (options.mode === "count") flags.push("--count", "--with-filename");
	else flags.push("--line-number", "--with-filename", "--no-heading", "-B1", "-A3");
	flags.push(options.caseSensitive === false ? "-i" : "-s");
	if (options.literal) flags.push("-F");

	for (const segment of new Set([...IGNORED_DIR_SEGMENTS, ...denied])) {
		// Escape a literal backslash before using it in a ripgrep glob.
		const name = segment.replaceAll("\\", "\\\\");
		flags.push("--glob", shellEscape(`!**/${name}/**`));
		if (denied.has(segment)) flags.push("--glob", shellEscape(`!**/${name}`));
	}
	if (options.glob && !/[:/\\[\]{}]/.test(options.glob)) {
		// An include --glob overrides .gitignore. A file type filter keeps the ignore rules in effect.
		// Complex basename patterns are checked by the common output filter.
		flags.push("--type-add", shellEscape(`pipiclawbasename:${options.glob}`), "--type", "pipiclawbasename");
	}
	return flags;
}

function grepFlags(options: SearchCommandOptions, denied: Set<string>): string[] {
	const flags = ["--null", "-I", options.literal ? "-F" : "-E"];
	if (options.mode === "files") flags.push("-rlH");
	else flags.push("-rnH");
	if (options.mode === "content") flags.push("-B1", "-A3");
	// BSD grep's -c does not NUL-terminate its filenames. Count numbered matching lines instead.
	if (options.caseSensitive === false) flags.push("-i");
	for (const segment of IGNORED_DIR_SEGMENTS) flags.push(`--exclude-dir=${segment}`);
	for (const base of denied) {
		flags.push(`--exclude-dir=${shellEscape(base)}`, `--exclude=${shellEscape(base)}`);
	}
	// grep --include does not expand braces. The common basename filter handles those patterns.
	if (options.glob && !/[{}]/.test(options.glob)) flags.push(`--include=${shellEscape(options.glob)}`);
	return flags;
}

export function buildSearchCommand(useRg: boolean, options: SearchCommandOptions): string {
	const denied = denyBasenames(options.readDeny);
	const flags = useRg ? rgFlags(options, denied) : grepFlags(options, denied);
	return `${useRg ? "rg" : "grep"} ${flags.join(" ")} -- ${shellEscape(options.pattern)} ${shellEscape(options.target)}`;
}
