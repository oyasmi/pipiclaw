import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, readFile, readlink } from "node:fs/promises";
import { isAbsolute, join, win32 } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * The legacy subject has HEAD plus separate staged/unstaged diffs in its input. It remains the
 * default so attestations written before the base-relative subject was introduced can still be
 * read and compared without silently changing their meaning.
 */
export interface WorkspaceSubjectHashOptions {
	/** Compare the checkout's current content to this commit, not to its current HEAD. */
	baseCommit?: string;
	/** Untracked paths, plus ignored non-transient paths, that existed when the subject was captured. */
	baselineUntrackedPaths?: readonly string[];
}

/** The metadata a new purpose=verify run persists for a base-relative subject. */
export interface WorkspaceSubjectSnapshot {
	hash: string;
	baseCommit: string;
	baselineUntrackedPaths: string[];
}

/**
 * New files in these named locations are conventional test/build/runtime outputs. They are an
 * explicit, deliberately small artifact scope: a new untracked file anywhere else remains part of
 * the subject and makes a verifier PASS fail. The directory names apply at the checkout root;
 * `src/coverage/...` is not silently treated as generated output. Existing untracked paths are
 * always retained in the subject through `baselineUntrackedPaths`, even when they live below one of
 * these directories. Ignored paths are read separately with `git ls-files`; ignored paths in the
 * same explicit transient scope are treated as generated at every snapshot, while ignored paths
 * elsewhere are protected just like ordinary untracked product files. This avoids treating Git's
 * default omission of ignored paths as permission to change arbitrary product files, without
 * recording the entire `node_modules` tree in every attestation.
 */
const TRANSIENT_UNTRACKED_DIRECTORY_NAMES = new Set([
	".cache",
	".next",
	".nuxt",
	".nyc_output",
	".parcel-cache",
	".pnpm-store",
	".pytest_cache",
	".temp",
	".tmp",
	".run",
	".turbo",
	".vite",
	"build",
	"coverage",
	"dist",
	"dist-evals",
	"node_modules",
	".npm",
	"playwright-report",
	"subagent-artifacts",
	"target",
	"temp",
	"test-results",
	"tmp",
]);

/** Cypress's source/test tree is not an output directory. Keep only its conventional generated
 * screenshot/video roots transient; `cypress/e2e`, fixtures, support, and downloads remain subject
 * to verification. */
const TRANSIENT_UNTRACKED_DIRECTORY_PREFIXES = ["cypress/screenshots", "cypress/videos"];

const TRANSIENT_UNTRACKED_FILE_NAMES = new Set([".eslintcache", ".stylelintcache"]);

/** Exposed for focused tests and documentation that needs to describe the artifact scope. */
export function isTransientUntrackedPath(relativePath: string): boolean {
	if (isAbsolute(relativePath) || win32.isAbsolute(relativePath)) return false;
	const normalized = relativePath.replace(/^\.\//, "").replaceAll("\\", "/");
	const segments = normalized.split("/").filter(Boolean);
	if (segments.includes("..")) return false;
	if (
		TRANSIENT_UNTRACKED_DIRECTORY_PREFIXES.some(
			(prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
		)
	)
		return true;
	if (
		segments.length > 0 &&
		TRANSIENT_UNTRACKED_DIRECTORY_NAMES.has(segments[0]!) &&
		(segments.length > 1 || normalized.endsWith("/"))
	)
		return true;
	const basename = segments.at(-1) ?? normalized;
	return segments.length === 1 && (TRANSIENT_UNTRACKED_FILE_NAMES.has(basename) || basename.endsWith(".tsbuildinfo"));
}

/**
 * git quotes a path containing special characters in double quotes with C-style escapes (spec
 * 040, D9). `JSON.parse` accepts the same escape set for the characters git actually emits
 * (`\"`, `\\`, `\t`, `\n`) and is close enough for a hash input; a path so exotic it defeats this
 * still contributes a value to the hash; it just won't be the literal decoded path.
 */
function unquoteGitPath(raw: string): string {
	if (raw.startsWith('"') && raw.endsWith('"')) {
		try {
			return JSON.parse(raw) as string;
		} catch {
			return raw;
		}
	}
	return raw;
}

function parseStatusPaths(statusOutput: string, prefix: "?? " | "!! "): string[] {
	const nulSeparated = statusOutput.includes("\0");
	const entries = nulSeparated ? statusOutput.split("\0") : statusOutput.split("\n");
	return Array.from(
		new Set(
			entries
				.filter((entry) => entry.startsWith(prefix))
				.map((entry) => {
					// `git status -z` emits raw paths. Only remove the three-byte status prefix: a
					// leading/trailing space is part of the filename and must remain in the subject.
					const rawPath = entry.slice(prefix.length);
					return nulSeparated ? rawPath : unquoteGitPath(rawPath.trim());
				})
				.filter(Boolean),
		),
	).sort();
}

function parseUntrackedPaths(statusOutput: string): string[] {
	return parseStatusPaths(statusOutput, "?? ");
}

function parseNulPathList(output: string): string[] {
	return Array.from(new Set(output.split("\0").filter(Boolean))).sort();
}

/** New base-relative subjects include ignored paths outside the explicit transient scope. */
function protectedWorkspacePaths(statusOutput: string, ignoredPaths: readonly string[] = []): string[] {
	const paths = new Set(parseUntrackedPaths(statusOutput));
	for (const path of ignoredPaths) {
		if (!isTransientUntrackedPath(path)) paths.add(path);
	}
	return [...paths].sort();
}

/**
 * Preserve the exact untracked digest used by the pre-base-relative subject. This is intentionally
 * separate from the new digest: changing the default would make an old attestation stale merely
 * because the checkout already contained an untracked file.
 */
async function legacyUntrackedFileDigest(workingDirectory: string, statusOutput: string): Promise<string> {
	const paths = parseUntrackedPaths(statusOutput);
	const hash = createHash("sha256");
	for (const relativePath of paths) {
		hash.update(relativePath);
		try {
			hash.update(await readFile(join(workingDirectory, relativePath)));
		} catch {
			// Unreadable — the path alone still went into the hash above.
		}
	}
	return hash.digest("hex");
}

/**
 * Select the untracked paths for a base-relative subject. Paths present at the initial snapshot
 * stay protected forever for that attestation. Only newly appearing paths under the explicit
 * transient artifact scope are omitted; new source/config/product files remain visible.
 */
function baseRelativeUntrackedPaths(
	currentPaths: readonly string[],
	baselineUntrackedPaths: readonly string[] | undefined,
): string[] {
	if (baselineUntrackedPaths === undefined) return [...currentPaths].sort();
	const baseline = new Set(baselineUntrackedPaths);
	const selected = new Set(baseline);
	for (const path of currentPaths) {
		if (baseline.has(path) || !isTransientUntrackedPath(path)) selected.add(path);
	}
	return [...selected].sort();
}

/** Read the current content for a canonical path set. This is deliberately content-based rather
 * than diff-text-based: a normal commit changes Git's representation, but not the checked content.
 * Baseline paths that disappear still contribute a missing marker.
 */
async function baseRelativeFileDigest(workingDirectory: string, paths: readonly string[]): Promise<string> {
	const hash = createHash("sha256");
	for (const relativePath of paths) {
		hash.update(`path:${relativePath}\0`);
		try {
			// Never follow a checkout entry while constructing an attestation. A symlink can point
			// outside the checkout, and hashing its target content would both read an unrelated path
			// and make regular-file -> symlink(same content) invisible.
			const { filePath, fileStat } = await lstatWorkspaceEntry(workingDirectory, relativePath);
			const type = fileType(fileStat);
			hash.update(`type:${type}\0`);
			hash.update(`mode:${fileStat.mode & 0o7777}\0`);
			if (fileStat.isSymbolicLink()) {
				hash.update(`target:${await readlink(filePath, "utf8")}\0`);
			} else if (fileStat.isFile()) {
				hash.update(await readFile(filePath));
			} else {
				// Git status normally expands untracked files, but an ignored/special entry may
				// still be a directory or device. Its type/mode are evidence; never recurse or
				// open an arbitrary special file while hashing a verifier subject.
				hash.update("<non-regular>\0");
			}
		} catch {
			hash.update("<missing>\0");
		}
		hash.update("\0");
	}
	return hash.digest("hex");
}

/** lstat the final entry and reject symlinked parent components, so a path cannot redirect a
 * content read outside the checkout through an intermediate directory symlink. The working
 * directory itself may be a symlink (it is the explicitly selected checkout root). */
async function lstatWorkspaceEntry(
	workingDirectory: string,
	relativePath: string,
): Promise<{ filePath: string; fileStat: Stats }> {
	if (isAbsolute(relativePath) || win32.isAbsolute(relativePath)) throw new Error("unsafe absolute subject path");
	const segments = relativePath.replaceAll("\\", "/").split("/").filter(Boolean);
	if (segments.length === 0 || segments.includes("..")) throw new Error("unsafe subject path");

	let filePath = workingDirectory;
	let fileStat: Stats | undefined;
	for (const [index, segment] of segments.entries()) {
		filePath = join(filePath, segment);
		fileStat = await lstat(filePath);
		if (index < segments.length - 1 && fileStat.isSymbolicLink()) {
			throw new Error("symlinked subject path component");
		}
	}
	return { filePath, fileStat: fileStat! };
}

function fileType(fileStat: Stats): string {
	if (fileStat.isSymbolicLink()) return "symlink";
	if (fileStat.isFile()) return "file";
	if (fileStat.isDirectory()) return "directory";
	if (fileStat.isBlockDevice()) return "block-device";
	if (fileStat.isCharacterDevice()) return "character-device";
	if (fileStat.isFIFO()) return "fifo";
	if (fileStat.isSocket()) return "socket";
	return "other";
}

async function baseRelativeTrackedPaths(workingDirectory: string, baseCommit: string): Promise<string[]> {
	const { stdout } = await execFileAsync(
		"git",
		["-C", workingDirectory, "diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", baseCommit, "--"],
		{ maxBuffer: 8 * 1024 * 1024 },
	);
	return Array.from(new Set(stdout.split("\0").filter(Boolean))).sort();
}

async function readGitStatus(workingDirectory: string, nulSeparated = false): Promise<string> {
	const args = ["-C", workingDirectory, "status", "--porcelain=v1", "--untracked-files=all"];
	if (nulSeparated) args.push("-z");
	const { stdout } = await execFileAsync("git", args, { maxBuffer: 4 * 1024 * 1024 });
	return stdout;
}

/**
 * P2-2: a plain-language "what changed" line for a completion wake, so the agent that reads it
 * does not have to spend its own first tool call finding out. `git status --porcelain` only — not
 * a full subject hash — since this is a convenience for the reader, not a verification input.
 * Returns `undefined` on any failure (not a git repo, `git` unavailable) or when nothing changed;
 * a caller with nothing to show should simply omit the line.
 */
export async function changedPathsSummary(workingDirectory: string, limit = 20): Promise<string | undefined> {
	let statusOutput: string;
	try {
		statusOutput = await readGitStatus(workingDirectory);
	} catch {
		return undefined;
	}
	const lines = statusOutput
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length === 0) return undefined;
	const shown = lines.slice(0, limit).join(", ");
	const overflow = lines.length > limit ? ` (+${lines.length - limit} more)` : "";
	return `${shown}${overflow}`;
}

/** Git status deliberately omits ignored paths. Enumerate them separately so an ignored product
 * file cannot disappear from the subject merely because it matches `.gitignore`. */
async function readGitIgnoredPaths(workingDirectory: string): Promise<string[]> {
	const { stdout } = await execFileAsync(
		"git",
		["-C", workingDirectory, "ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
		{ maxBuffer: 64 * 1024 * 1024 },
	);
	return parseNulPathList(stdout);
}

async function readGitHead(workingDirectory: string): Promise<string> {
	const { stdout } = await execFileAsync("git", ["-C", workingDirectory, "rev-parse", "HEAD"], {
		maxBuffer: 1024 * 1024,
	});
	return stdout.trim();
}

/** Compute the subject used by a new verifier run, with a fixed base commit. */
async function baseRelativeSubjectHash(
	workingDirectory: string,
	statusOutput: string,
	ignoredPaths: readonly string[],
	baseCommit: string,
	baselineUntrackedPaths: readonly string[] | undefined,
): Promise<string> {
	const trackedPaths = await baseRelativeTrackedPaths(workingDirectory, baseCommit);
	const untrackedPaths = baseRelativeUntrackedPaths(
		protectedWorkspacePaths(statusOutput, ignoredPaths),
		baselineUntrackedPaths,
	);
	const paths = Array.from(new Set([...trackedPaths, ...untrackedPaths])).sort();
	const contentDigest = await baseRelativeFileDigest(workingDirectory, paths);
	return createHash("sha256").update(["base-relative-v3", baseCommit, contentDigest].join("\0")).digest("hex");
}

/**
 * Capture the base-relative subject and the untracked manifest needed to compare it after a test
 * or build. The snapshot is deliberately a single new mode; callers that need legacy semantics
 * should continue using `workspaceSubjectHash()` without options.
 */
export async function workspaceSubjectSnapshot(
	workingDirectory: string,
): Promise<WorkspaceSubjectSnapshot | undefined> {
	try {
		const [statusOutput, ignoredPaths, baseCommit] = await Promise.all([
			readGitStatus(workingDirectory, true),
			readGitIgnoredPaths(workingDirectory),
			readGitHead(workingDirectory),
		]);
		const baselineUntrackedPaths = protectedWorkspacePaths(statusOutput, ignoredPaths);
		const hash = await baseRelativeSubjectHash(
			workingDirectory,
			statusOutput,
			ignoredPaths,
			baseCommit,
			baselineUntrackedPaths,
		);
		return { hash, baseCommit, baselineUntrackedPaths };
	} catch {
		return undefined;
	}
}

/**
 * A compact, deterministic description of the code/artifact subject a verifier observed. Without
 * options this retains the original HEAD + staged/unstaged + all-untracked behavior for old
 * attestations. With `baseCommit`, it compares the current checkout's content relative to that
 * fixed commit so committing the already-verified content does not invalidate the attestation.
 */
export async function workspaceSubjectHash(
	workingDirectory: string,
	options: WorkspaceSubjectHashOptions = {},
): Promise<string | undefined> {
	if (options.baseCommit !== undefined) {
		try {
			const [statusOutput, ignoredPaths] = await Promise.all([
				readGitStatus(workingDirectory, true),
				readGitIgnoredPaths(workingDirectory),
			]);
			return await baseRelativeSubjectHash(
				workingDirectory,
				statusOutput,
				ignoredPaths,
				options.baseCommit.trim(),
				options.baselineUntrackedPaths,
			);
		} catch {
			return undefined;
		}
	}

	try {
		const statusOutput = await readGitStatus(workingDirectory);
		const [head, unstaged, staged, untrackedDigest] = await Promise.all([
			readGitHead(workingDirectory),
			execFileAsync("git", ["-C", workingDirectory, "diff", "--no-ext-diff", "--binary"], {
				maxBuffer: 4 * 1024 * 1024,
			}),
			execFileAsync("git", ["-C", workingDirectory, "diff", "--cached", "--no-ext-diff", "--binary"], {
				maxBuffer: 4 * 1024 * 1024,
			}),
			legacyUntrackedFileDigest(workingDirectory, statusOutput),
		]);
		return createHash("sha256")
			.update([head, statusOutput, unstaged.stdout, staged.stdout, untrackedDigest].join("\0"))
			.digest("hex");
	} catch {
		return undefined;
	}
}
