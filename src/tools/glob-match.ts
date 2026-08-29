/**
 * Compile a shell-style glob pattern into a matcher for POSIX-relative file paths.
 *
 * Semantics follow the convention the model already knows from `find`/`fd`/Claude Code's own glob
 * tool: a pattern with no `/` matches the *basename* at any depth (so `*.ts` searches the whole
 * tree, not just its top level); `**` matches any number of path segments, including zero, when it
 * sits between (or at the start/end of) path separators; `{a,b}` is brace-expanded into
 * alternatives. Matching is always case-sensitive and always against `/`-joined relative paths —
 * callers never see platform separators.
 *
 * ## Why this is not a regular expression
 *
 * The obvious implementation compiles the whole pattern into one `RegExp` — and that regex is a
 * denial-of-service primitive, because the pattern is a model-supplied argument and the matcher
 * runs once per walked file on the event loop. Nested unbounded quantifiers backtrack
 * exponentially on a *near* miss: `**​/` repeated ten times took ~2s per path, `{*,*}` repeated
 * five times ~145ms and rising by ~17x per group, and `*a*a*a*a*a*a*a*azzz` — nineteen
 * characters, no `**`, no braces — took **32 seconds** against a sixty-character name. Folding
 * `**​/` or capping the pattern length only removes particular spellings; the blow-up belongs to
 * the whole class of "several stars separated by literals", which no length bound can exclude.
 *
 * So the pattern is matched structurally instead: braces expand to a bounded set of variants,
 * each variant is split into path segments, and both the segment sequence and each segment's
 * characters are matched by the classic single-backtrack-point wildcard algorithm. That is
 * O(n·m) in the worst case with no nested quantifiers, so every shape above matches in
 * microseconds and no pattern can stall the walk.
 */

/** A pattern longer than this is a mistake or an attack; neither deserves a match attempt. */
const MAX_PATTERN_LENGTH = 512;
/** Brace expansion multiplies: `{a,b}` ten times over is 1024 variants of the same walk. */
const MAX_BRACE_VARIANTS = 64;

export interface GlobMatcher {
	/** True when `path` — a `/`-joined path relative to the walk root — matches the pattern. */
	test(path: string): boolean;
}

/** A path segment that is exactly `**`: any number of segments, including none. */
const GLOBSTAR = Symbol("globstar");
/** `*` inside a segment: any run of characters, not crossing a separator. */
const STAR = Symbol("star");
/** `?` inside a segment: exactly one character. */
const ANY = Symbol("any");

type SegmentToken = typeof STAR | typeof ANY | string;
type PatternSegment = typeof GLOBSTAR | SegmentToken[];

interface CompiledVariant {
	segments: PatternSegment[];
	/**
	 * A trailing `**` means "everything under this point", which requires something to be under
	 * it: `docs/**` matches `docs/readme.md` but not a file named `docs`. Every other globstar
	 * matches zero or more segments.
	 */
	trailingGlobstar: boolean;
}

export function compileGlobPattern(pattern: string): GlobMatcher {
	if (pattern.length > MAX_PATTERN_LENGTH) {
		throw new Error(`pattern is longer than ${MAX_PATTERN_LENGTH} characters`);
	}
	// The anchoring decision is made on the pattern as written, before expansion: `{src/a,b}`
	// carries a separator and is therefore path-anchored for *both* of its alternatives.
	const matchBasenameOnly = !pattern.includes("/");
	const variants = expandBraces(pattern).map(compileVariant);

	return {
		test(path: string): boolean {
			const segments = matchBasenameOnly ? [path.slice(path.lastIndexOf("/") + 1)] : path.split("/");
			return variants.some((variant) => matchVariant(variant, segments));
		},
	};
}

/**
 * Expand `{a,b}` alternations into concrete patterns, innermost group last so nesting works.
 *
 * Braces are located by depth-counted scanning rather than the first `}` found, so `{a,{b,c}}`
 * and a comma inside a nested group are read the way the writer meant. An unmatched `{` stays a
 * literal character, as it did before.
 */
function expandBraces(pattern: string): string[] {
	const open = findBraceGroup(pattern);
	if (!open) return [pattern];

	const results: string[] = [];
	for (const alternative of open.alternatives) {
		for (const expanded of expandBraces(`${open.prefix}${alternative}${open.suffix}`)) {
			results.push(expanded);
			if (results.length > MAX_BRACE_VARIANTS) {
				throw new Error(`brace expansion produces more than ${MAX_BRACE_VARIANTS} patterns`);
			}
		}
	}
	return results;
}

interface BraceGroup {
	prefix: string;
	alternatives: string[];
	suffix: string;
}

function findBraceGroup(pattern: string): BraceGroup | undefined {
	const start = pattern.indexOf("{");
	if (start === -1) return undefined;

	let depth = 0;
	const alternatives: string[] = [];
	let current = "";
	for (let i = start; i < pattern.length; i++) {
		const char = pattern[i];
		if (char === "{") {
			depth++;
			if (depth === 1) continue; // the group's own opening brace is not content
		} else if (char === "}") {
			depth--;
			if (depth === 0) {
				alternatives.push(current);
				return { prefix: pattern.slice(0, start), alternatives, suffix: pattern.slice(i + 1) };
			}
		} else if (char === "," && depth === 1) {
			alternatives.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	return undefined; // unbalanced `{` — leave it as a literal
}

function compileVariant(pattern: string): CompiledVariant {
	const rawSegments = pattern.split("/");
	const segments: PatternSegment[] = rawSegments.map((segment) =>
		segment === "**" ? GLOBSTAR : compileSegment(segment),
	);
	const trailingGlobstar = segments.length > 1 && segments[segments.length - 1] === GLOBSTAR;
	return { segments, trailingGlobstar };
}

function compileSegment(segment: string): SegmentToken[] {
	const tokens: SegmentToken[] = [];
	for (const char of segment) {
		if (char === "*") {
			// Adjacent stars are the same star. A `**` that is not a whole segment (`a**b`) has
			// always meant single-segment `*`, and collapsing keeps that without a second token.
			if (tokens[tokens.length - 1] !== STAR) tokens.push(STAR);
			continue;
		}
		tokens.push(char === "?" ? ANY : char);
	}
	return tokens;
}

/**
 * Match a segment sequence, with `**` as the only construct that can span segments.
 *
 * The single backtrack point (`starIndex`/`starSegment`) is what keeps this linear-ish: on a
 * mismatch the matcher advances the most recent globstar by one segment instead of exploring
 * every combination of every globstar, which is the search space a regex engine would walk.
 */
function matchVariant(variant: CompiledVariant, path: string[]): boolean {
	const { segments, trailingGlobstar } = variant;
	// The trailing `**` is handled after the loop, so drop it here and require a remainder there.
	const patternLength = trailingGlobstar ? segments.length - 1 : segments.length;

	let patternIndex = 0;
	let pathIndex = 0;
	let starIndex = -1;
	let starPathIndex = 0;

	while (pathIndex < path.length) {
		const segment = patternIndex < patternLength ? segments[patternIndex] : undefined;
		// Pattern spent with path left over: a trailing `**` takes the whole remainder.
		if (segment === undefined && trailingGlobstar) break;
		if (segment === GLOBSTAR) {
			starIndex = patternIndex;
			starPathIndex = pathIndex;
			patternIndex++;
			continue;
		}
		if (segment !== undefined && matchSegment(segment, path[pathIndex])) {
			patternIndex++;
			pathIndex++;
			continue;
		}
		if (starIndex === -1) return false;
		// Let the last globstar swallow one more segment and retry from just after it.
		starPathIndex++;
		pathIndex = starPathIndex;
		patternIndex = starIndex + 1;
	}

	while (patternIndex < patternLength && segments[patternIndex] === GLOBSTAR) patternIndex++;
	if (patternIndex !== patternLength) return false;
	return trailingGlobstar ? pathIndex < path.length : pathIndex === path.length;
}

/** The same algorithm one level down: `*` is the backtrack point, `?` and literals advance. */
function matchSegment(tokens: SegmentToken[], text: string): boolean {
	let tokenIndex = 0;
	let textIndex = 0;
	let starIndex = -1;
	let starTextIndex = 0;

	while (textIndex < text.length) {
		const token = tokenIndex < tokens.length ? tokens[tokenIndex] : undefined;
		if (token === STAR) {
			starIndex = tokenIndex;
			starTextIndex = textIndex;
			tokenIndex++;
			continue;
		}
		if (token === ANY || (typeof token === "string" && token === text[textIndex])) {
			tokenIndex++;
			textIndex++;
			continue;
		}
		if (starIndex === -1) return false;
		starTextIndex++;
		textIndex = starTextIndex;
		tokenIndex = starIndex + 1;
	}

	while (tokenIndex < tokens.length && tokens[tokenIndex] === STAR) tokenIndex++;
	return tokenIndex === tokens.length;
}
