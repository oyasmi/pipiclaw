import { existsSync, lstatSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, normalize, resolve } from "node:path";
import { PLAYBOOKS_DIR } from "../paths.js";
import type { PathGuardContext, PathGuardResult } from "./types.js";

const PRIVATE_KEY_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx"]);
const PRIVATE_KEY_NAME_HINTS = /(id_rsa|id_ed25519|private|secret|credentials)/i;
const PROC_MEM_PATH = /^\/proc\/\d+\/mem(?:\/|$)/;

const HOME_SENSITIVE_PREFIXES = [
	"~/.ssh/",
	"~/.gnupg/",
	"~/.gpg/",
	"~/.aws/",
	"~/.azure/",
	"~/.gcloud/",
	"~/.config/gcloud/",
	"~/.kube/",
	"~/.docker/",
	"~/Library/Keychains/",
	"~/.local/share/keyrings/",
	"~/Library/Application Support/Google/Chrome/",
	"~/Library/Application Support/Firefox/",
	"~/.config/google-chrome/",
	"~/.mozilla/firefox/",
];

const HOME_SENSITIVE_FILES = ["~/.netrc", "~/.npmrc", "~/.pypirc", "~/.bash_history", "~/.zsh_history"];

const WRITE_DENY_HOME_FILES = ["~/.bashrc", "~/.zshrc", "~/.profile", "~/.bash_profile", "~/.config/fish/config.fish"];

const SYSTEM_SENSITIVE_PREFIXES = ["/etc/sudoers.d/", "/var/run/secrets/"];
const SYSTEM_SENSITIVE_FILES = ["/etc/shadow", "/etc/gshadow", "/etc/sudoers", "/proc/kcore"];

const TEMP_PREFIXES = ["/tmp/", "/var/tmp/", "/private/tmp/"];
const SYSTEM_DENY_PREFIXES = [
	"/etc/",
	"/usr/",
	"/bin/",
	"/sbin/",
	"/lib/",
	"/lib64/",
	"/boot/",
	"/dev/",
	"/proc/",
	"/sys/",
	"/opt/",
	"/System/",
	"/Library/",
	"/var/",
];

function stripNullAndNormalize(text: string): string {
	return text.replace(/\0/g, "").normalize("NFKC");
}

function withTrailingSlash(path: string): string {
	return path.endsWith("/") ? path : `${path}/`;
}

function startsWithPathPrefix(path: string, prefix: string): boolean {
	return path === prefix || path.startsWith(withTrailingSlash(prefix));
}

function maybeExpandHome(path: string, homeDir: string): string {
	if (path === "~") {
		return homeDir;
	}
	if (path.startsWith("~/")) {
		return resolve(homeDir, path.slice(2));
	}
	return path;
}

function resolveHomeConfiguredPath(rawPath: string, homeDir: string): string {
	return normalize(maybeExpandHome(stripNullAndNormalize(rawPath), homeDir));
}

function resolveConfiguredPath(rawPath: string, ctx: PathGuardContext): string {
	const homeDir = ctx.homeDir ?? homedir();
	const normalized = stripNullAndNormalize(rawPath);
	const expanded = maybeExpandHome(normalized, homeDir);
	if (isAbsolute(expanded)) {
		return normalize(expanded);
	}
	return resolve(ctx.workspaceDir, expanded);
}

function resolveTargetPath(rawPath: string, ctx: PathGuardContext): string {
	const homeDir = ctx.homeDir ?? homedir();
	const cwd = ctx.cwd ?? process.cwd();
	const normalized = stripNullAndNormalize(rawPath);
	const expanded = maybeExpandHome(normalized, homeDir);
	if (isAbsolute(expanded)) {
		return normalize(expanded);
	}
	return resolve(cwd, expanded);
}

function resolveExistingAncestor(path: string): string {
	let current = normalize(path);
	while (true) {
		if (existsSync(current)) {
			return realpathSync(current);
		}
		const parent = dirname(current);
		if (parent === current) {
			return current;
		}
		current = parent;
	}
}

/**
 * `resolveForGuard` for the two roots every call resolves: the workspace and the home directory.
 *
 * Unlike a guarded target, these are existing directories that do not move for the life of the
 * process, so their realpath is stable — but resolving them cost two `realpathSync` calls on
 * *every* guarded read and write. Cached on the literal input so a different workspace (tests,
 * a second runtime in-process) still resolves correctly.
 */
const rootRealPathCache = new Map<string, string>();

function resolveRootForGuard(path: string, ctx: PathGuardContext): string {
	const key = `${ctx.config.resolveSymlinks !== false}\0${path}`;
	const cached = rootRealPathCache.get(key);
	if (cached !== undefined) {
		return cached;
	}
	const resolved = resolveForGuard(path, ctx);
	rootRealPathCache.set(key, resolved);
	return resolved;
}

function resolveForGuard(path: string, ctx: PathGuardContext): string {
	const normalized = normalize(path);
	const resolveSymlinks = ctx.config.resolveSymlinks !== false;
	if (!resolveSymlinks) {
		return normalized;
	}

	if (existsSync(normalized)) {
		return realpathSync(normalized);
	}

	const parentDir = dirname(normalized);
	const parentRealPath = resolveExistingAncestor(parentDir);
	return resolve(parentRealPath, basename(normalized));
}

function matchesAnyPath(path: string, exactPaths: string[], prefixes: string[]): boolean {
	return exactPaths.includes(path) || prefixes.some((prefix) => startsWithPathPrefix(path, prefix));
}

interface SensitivePathTable {
	homePrefixes: string[];
	homeFiles: string[];
	writeDenyHomeFiles: string[];
}

/**
 * The sensitive-path lists are module constants; only `homeDir` varies, and in practice it is one
 * value for the life of the process. Resolving all ~25 of them (null-strip, NFKC-normalize,
 * expand, normalize) on every single guarded read/write was pure repeated work, so the resolved
 * table is memoized per home directory.
 */
const sensitivePathTables = new Map<string, SensitivePathTable>();

function getSensitivePathTable(homeDir: string): SensitivePathTable {
	const cached = sensitivePathTables.get(homeDir);
	if (cached) {
		return cached;
	}
	const table: SensitivePathTable = {
		homePrefixes: HOME_SENSITIVE_PREFIXES.map((item) => resolveHomeConfiguredPath(item, homeDir)),
		homeFiles: HOME_SENSITIVE_FILES.map((item) => resolveHomeConfiguredPath(item, homeDir)),
		writeDenyHomeFiles: WRITE_DENY_HOME_FILES.map((item) => resolveHomeConfiguredPath(item, homeDir)),
	};
	sensitivePathTables.set(homeDir, table);
	return table;
}

/** Path-independent, so resolved once at module load. */
const SENSITIVE_SYSTEM_PREFIXES = SYSTEM_SENSITIVE_PREFIXES.map((item) => normalize(item));
const SENSITIVE_SYSTEM_FILES = SYSTEM_SENSITIVE_FILES.map((item) => normalize(item));
const NORMALIZED_SYSTEM_DENY_PREFIXES = SYSTEM_DENY_PREFIXES.map((prefix) => normalize(prefix));
const NORMALIZED_TEMP_PREFIXES = TEMP_PREFIXES.map((prefix) => normalize(prefix));

function matchesSensitiveReadPath(path: string, homeDir: string): boolean {
	const table = getSensitivePathTable(homeDir);

	if (matchesAnyPath(path, table.homeFiles, table.homePrefixes)) {
		return true;
	}
	if (matchesAnyPath(path, SENSITIVE_SYSTEM_FILES, SENSITIVE_SYSTEM_PREFIXES)) {
		return true;
	}
	if (PROC_MEM_PATH.test(path)) {
		return true;
	}

	const lowerBase = basename(path).toLowerCase();
	const extension = lowerBase.includes(".") ? lowerBase.slice(lowerBase.lastIndexOf(".")) : "";
	if (PRIVATE_KEY_EXTENSIONS.has(extension) && PRIVATE_KEY_NAME_HINTS.test(lowerBase)) {
		return true;
	}
	return PRIVATE_KEY_NAME_HINTS.test(lowerBase) && lowerBase.startsWith("id_");
}

function matchesSensitiveWritePath(path: string, homeDir: string): boolean {
	if (matchesSensitiveReadPath(path, homeDir)) {
		return true;
	}
	return getSensitivePathTable(homeDir).writeDenyHomeFiles.includes(path);
}

/**
 * Resolving the runtime temp directory costs an `existsSync` plus a `realpathSync` walk, and
 * `isWithinTemp` is consulted up to twice per guarded path. `tmpdir()` reads TMPDIR/TEMP each
 * time, so the cache is keyed on it: an env change still takes effect, it just stops paying for
 * the syscalls on every tool call.
 */
let tempPrefixCache: { tmpDir: string; prefixes: string[] } | null = null;

function getTempPrefixes(): string[] {
	const runtimeTmpDir = normalize(tmpdir());
	if (tempPrefixCache?.tmpDir === runtimeTmpDir) {
		return tempPrefixCache.prefixes;
	}
	const runtimePrefixes = existsSync(runtimeTmpDir)
		? [runtimeTmpDir, resolveExistingAncestor(runtimeTmpDir)]
		: [runtimeTmpDir];
	const prefixes = [...NORMALIZED_TEMP_PREFIXES, ...runtimePrefixes];
	tempPrefixCache = { tmpDir: runtimeTmpDir, prefixes };
	return prefixes;
}

function isWithinTemp(path: string): boolean {
	return getTempPrefixes().some((prefix) => startsWithPathPrefix(path, prefix));
}

function isWithinHome(path: string, homeDir: string): boolean {
	return startsWithPathPrefix(path, normalize(homeDir));
}

function isWithinWorkspace(path: string, workspaceDir: string): boolean {
	return startsWithPathPrefix(path, normalize(workspaceDir));
}

function isDeniedSystemPath(path: string): boolean {
	if (isWithinTemp(path)) {
		return false;
	}
	return NORMALIZED_SYSTEM_DENY_PREFIXES.some((prefix) => startsWithPathPrefix(path, prefix));
}

// Deliberately not cached: a configured allow/deny entry may not exist yet, and `resolveForGuard`
// resolves a missing path through its nearest existing ancestor. Caching that would freeze the
// pre-creation answer, so a path later created as a symlink would stop being resolved to its
// target. Both lists are empty by default, so this costs nothing unless the operator opts in.
function matchesConfiguredPath(path: string, entries: string[], ctx: PathGuardContext): boolean {
	return entries
		.map((entry) => resolveForGuard(resolveConfiguredPath(entry, ctx), ctx))
		.some((entry) => startsWithPathPrefix(path, entry));
}

function pathAllowedByDefaults(path: string, ctx: PathGuardContext): boolean {
	const homeDir = ctx.homeDir ?? homedir();
	return isWithinWorkspace(path, ctx.workspaceDir) || isWithinTemp(path) || isWithinHome(path, homeDir);
}

/** The runtime's own bundled playbooks are readable regardless of where the package is installed. */
function isBundledPlaybookRead(path: string, operation: "read" | "write"): boolean {
	return operation === "read" && startsWithPathPrefix(path, normalize(PLAYBOOKS_DIR));
}

function formatBlockedResult(
	operation: "read" | "write",
	rawPath: string,
	resolvedPath: string,
	category: string,
	reason: string,
): PathGuardResult {
	return {
		allowed: false,
		operation,
		rawPath,
		resolvedPath,
		category,
		reason,
	};
}

export function guardPath(rawPath: string, operation: "read" | "write", ctx: PathGuardContext): PathGuardResult {
	if (!ctx.config.enabled) {
		return { allowed: true, operation, rawPath };
	}

	const homeDir = ctx.homeDir ?? homedir();
	const effectiveCtx: PathGuardContext = {
		...ctx,
		workspaceDir: resolveRootForGuard(ctx.workspaceDir, ctx),
		homeDir: resolveRootForGuard(homeDir, ctx),
	};
	const resolvedTarget = resolveTargetPath(rawPath, ctx);
	const guardedPath = resolveForGuard(resolvedTarget, ctx);

	if (
		matchesConfiguredPath(
			guardedPath,
			operation === "read" ? effectiveCtx.config.readDeny : effectiveCtx.config.writeDeny,
			effectiveCtx,
		)
	) {
		return formatBlockedResult(
			operation,
			rawPath,
			guardedPath,
			"configured-deny",
			"Path is denied by security config",
		);
	}

	if (operation === "read" && matchesSensitiveReadPath(guardedPath, effectiveCtx.homeDir ?? homeDir)) {
		return formatBlockedResult(
			operation,
			rawPath,
			guardedPath,
			"sensitive-read-path",
			"Reading sensitive paths is not allowed",
		);
	}

	if (operation === "write" && matchesSensitiveWritePath(guardedPath, effectiveCtx.homeDir ?? homeDir)) {
		return formatBlockedResult(
			operation,
			rawPath,
			guardedPath,
			"sensitive-write-path",
			"Writing sensitive paths is not allowed",
		);
	}

	if (operation === "write" && existsSync(resolvedTarget)) {
		try {
			if (lstatSync(resolvedTarget).isSymbolicLink()) {
				return formatBlockedResult(
					operation,
					rawPath,
					guardedPath,
					"symlink-write",
					"Writing through symbolic links is not allowed",
				);
			}
		} catch {
			// Ignore lstat races and continue with resolved-path checks.
		}
	}

	if (
		matchesConfiguredPath(
			guardedPath,
			operation === "read" ? effectiveCtx.config.readAllow : effectiveCtx.config.writeAllow,
			effectiveCtx,
		)
	) {
		return { allowed: true, operation, rawPath, resolvedPath: guardedPath };
	}

	if (pathAllowedByDefaults(guardedPath, effectiveCtx) || isBundledPlaybookRead(guardedPath, operation)) {
		return { allowed: true, operation, rawPath, resolvedPath: guardedPath };
	}

	if (isDeniedSystemPath(guardedPath)) {
		return formatBlockedResult(
			operation,
			rawPath,
			guardedPath,
			"system-path",
			`${operation === "read" ? "Reading" : "Writing"} system paths is not allowed by default`,
		);
	}

	return formatBlockedResult(
		operation,
		rawPath,
		guardedPath,
		"outside-allowed-roots",
		`${operation === "read" ? "Reading" : "Writing"} outside workspace, home, and temp paths is not allowed`,
	);
}
