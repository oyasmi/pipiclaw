import { existsSync, lstatSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
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
	return resolve(ctx.agentWorkspaceDir, expanded);
}

function resolveTargetPath(rawPath: string, ctx: PathGuardContext): string {
	const homeDir = ctx.homeDir ?? homedir();
	const cwd = ctx.projectRoot ?? process.cwd();
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

	// Walk up to the nearest existing ancestor, remembering every missing path segment along the
	// way, then reattach them onto that ancestor's realpath (spec 044: a file tool's real write
	// target is now this resolved path, not a raw `mkdir -p`'d one, so this has to be exact). A
	// naive "existing ancestor + basename" only handles a single missing directory level -- writing
	// `a/b/c.txt` where neither `a` nor `a/b` exist yet used to silently drop the `a/b` segment and
	// resolve to `<ancestor>/c.txt` instead of `<ancestor>/a/b/c.txt`.
	const missingSegments: string[] = [];
	let current = normalized;
	while (!existsSync(current)) {
		missingSegments.unshift(basename(current));
		const parent = dirname(current);
		if (parent === current) {
			break;
		}
		current = parent;
	}
	const ancestorRealPath = existsSync(current) ? realpathSync(current) : current;
	return resolve(ancestorRealPath, ...missingSegments);
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

function isWithinAgentWorkspace(path: string, agentWorkspaceDir: string): boolean {
	return startsWithPathPrefix(path, normalize(agentWorkspaceDir));
}

function isWithinProjectRoot(path: string, ctx: PathGuardContext): boolean {
	const root = ctx.projectRoot;
	if (!root) {
		return false;
	}
	return startsWithPathPrefix(path, normalize(root));
}

/** Runtime-owned exception: the AgentWorkspace's `skills/` tree stays reachable under
 * `boundary: "project"` regardless of which project is selected (spec 043, D6.2) -- reads so the
 * model can load a skill's playbook, and writes so `write`/`edit` can author one (the `skill` tool
 * itself is read-only; authoring goes through the generic file tools). The symlink-write check
 * above this call in `guardPath` still applies, so a skill file that is itself a symlink cannot be
 * written through even inside this exception. */
function isAgentWorkspaceSkillsAccess(path: string, ctx: PathGuardContext): boolean {
	return startsWithPathPrefix(path, normalize(join(ctx.agentWorkspaceDir, "skills")));
}

/**
 * Runtime-owned exception for the channel's own directory, in the same spirit as `skills/`: spec
 * 043's D5 puts `SESSION.md`, channel `MEMORY.md`, `HISTORY.md` and `tasks/` in the AgentWorkspace
 * precisely so a channel keeps its continuity across project switches — but D6.2's project bound
 * then put them outside every allowed root, so a task wake could tell the model to open
 * `tasks/<id>.md` and the guard would refuse.
 *
 * Reads are allowed throughout. Writes are allowed only under `tasks/`: the three memory files are
 * runtime-maintained and go through the memory tools (a file write there races the maintenance
 * queue), while a task's body is model-authored prose that `task_update` cannot rewrite — it
 * replaces frontmatter and keeps the body verbatim, so revising a task contract needs `edit`.
 */
function isChannelDirAccess(path: string, operation: "read" | "write", ctx: PathGuardContext): boolean {
	if (!ctx.channelDir) {
		return false;
	}
	const channelDir = normalize(ctx.channelDir);
	if (!startsWithPathPrefix(path, channelDir)) {
		return false;
	}
	return operation === "read" || startsWithPathPrefix(path, normalize(join(channelDir, "tasks")));
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
	if (ctx.boundary === "project") {
		return isWithinProjectRoot(path, ctx);
	}
	const homeDir = ctx.homeDir ?? homedir();
	return isWithinAgentWorkspace(path, ctx.agentWorkspaceDir) || isWithinTemp(path) || isWithinHome(path, homeDir);
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
		// Resolution is normalization, not policy, so `resolvedPath` stays populated even with the
		// guard off (spec 044, D1.1): callers rely on it being the one path every file tool actually
		// opens, and a guard-disabled deployment must not be the one case that breaks that invariant.
		return { allowed: true, operation, rawPath, resolvedPath: resolveForGuard(resolveTargetPath(rawPath, ctx), ctx) };
	}

	const homeDir = ctx.homeDir ?? homedir();
	const effectiveCtx: PathGuardContext = {
		...ctx,
		agentWorkspaceDir: resolveRootForGuard(ctx.agentWorkspaceDir, ctx),
		homeDir: resolveRootForGuard(homeDir, ctx),
		projectRoot: ctx.projectRoot ? resolveRootForGuard(ctx.projectRoot, ctx) : ctx.projectRoot,
		channelDir: ctx.channelDir ? resolveRootForGuard(ctx.channelDir, ctx) : ctx.channelDir,
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
		) &&
		// D6.2: `boundary: "project"` is pathGuard's outer bound — a configured allow entry can
		// narrow within the project but never widen a generic tool past it.
		(effectiveCtx.boundary !== "project" || isWithinProjectRoot(guardedPath, effectiveCtx))
	) {
		return { allowed: true, operation, rawPath, resolvedPath: guardedPath };
	}

	if (
		pathAllowedByDefaults(guardedPath, effectiveCtx) ||
		isBundledPlaybookRead(guardedPath, operation) ||
		isAgentWorkspaceSkillsAccess(guardedPath, effectiveCtx) ||
		isChannelDirAccess(guardedPath, operation, effectiveCtx)
	) {
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

	// The reason names the roots that are actually in effect. Under `boundary: "project"` the
	// generic wording ("outside workspace, home, and temp") is worse than unhelpful: workspace and
	// home are themselves out of bounds there, so a model taking it at face value retries against a
	// path that can never be allowed.
	const verb = operation === "read" ? "Reading" : "Writing";
	return formatBlockedResult(
		operation,
		rawPath,
		guardedPath,
		"outside-allowed-roots",
		effectiveCtx.boundary === "project"
			? `${verb} outside the current project root (${effectiveCtx.projectRoot ?? "unset"}) is not allowed`
			: `${verb} outside workspace, home, and temp paths is not allowed`,
	);
}
