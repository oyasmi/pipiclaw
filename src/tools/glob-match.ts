/**
 * Compile a shell-style glob pattern into a `RegExp` matched against a POSIX-relative file path.
 *
 * Semantics follow the convention the model already knows from `find`/`fd`/Claude Code's own glob
 * tool: a pattern with no `/` matches the *basename* at any depth (so `*.ts` searches the whole
 * tree, not just its top level); `**` matches any number of path segments, including zero, when it
 * sits between (or at the start/end of) path separators; `{a,b}` is brace-expanded into an
 * alternation. Matching is always case-sensitive and always against `/`-joined relative paths —
 * callers never see platform separators.
 */
export function compileGlobPattern(pattern: string): RegExp {
	const body = globToRegExpSource(pattern);
	return pattern.includes("/") ? new RegExp(`^${body}$`) : new RegExp(`(?:^|/)${body}$`);
}

/** Single-pass translation so `**` can see the literal `/` characters on either side of it. */
function globToRegExpSource(pattern: string): string {
	let out = "";
	let i = 0;
	const n = pattern.length;
	while (i < n) {
		const ch = pattern[i];
		if (ch === "*" && pattern[i + 1] === "*") {
			const precededByBoundary = i === 0 || pattern[i - 1] === "/";
			const followedBySlash = pattern[i + 2] === "/";
			const followedByEnd = i + 2 === n;
			if (precededByBoundary && followedBySlash) {
				// `**/`: zero or more complete path segments.
				out += "(?:.*/)?";
				i += 3;
				continue;
			}
			if (precededByBoundary && followedByEnd) {
				// trailing `**`: everything under this point.
				out += ".*";
				i += 2;
				continue;
			}
			// `**` not cleanly bounded by separators — fall back to single-segment `*` semantics.
			out += "[^/]*";
			i += 2;
			continue;
		}
		if (ch === "*") {
			out += "[^/]*";
			i += 1;
			continue;
		}
		if (ch === "?") {
			out += "[^/]";
			i += 1;
			continue;
		}
		if (ch === "{") {
			const close = pattern.indexOf("}", i);
			if (close === -1) {
				out += escapeRegExpChar(ch);
				i += 1;
				continue;
			}
			const alternatives = pattern
				.slice(i + 1, close)
				.split(",")
				.map((alt) => globToRegExpSource(alt));
			out += `(?:${alternatives.join("|")})`;
			i = close + 1;
			continue;
		}
		out += escapeRegExpChar(ch);
		i += 1;
	}
	return out;
}

function escapeRegExpChar(ch: string): string {
	return /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}
