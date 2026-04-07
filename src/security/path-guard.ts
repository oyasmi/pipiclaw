import { existsSync, lstatSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, normalize, resolve } from "node:path";
import { isWindowsPlatform } from "./platform.js";
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

function translateRuntimeWorkspacePath(path: string, ctx: PathGuardContext): string {
	if (!isAbsolute(path)) {
		return path;
	}
	if (!ctx.workspacePath || ctx.workspacePath === ctx.workspaceDir) {
		return path;
	}
	if (path === ctx.workspacePath) {
		return ctx.workspaceDir;
	}
	if (path.startsWith(withTrailingSlash(ctx.workspacePath))) {
		return resolve(ctx.workspaceDir, path.slice(ctx.workspacePath.length + 1));
	}
	return path;
}

function resolveConfiguredPath(rawPath: string, ctx: PathGuardContext): string {
	const homeDir = ctx.homeDir ?? homedir();
	const normalized = stripNullAndNormalize(rawPath);
	const expanded = maybeExpandHome(normalized, homeDir);
	const translated = translateRuntimeWorkspacePath(expanded, ctx);
	if (isAbsolute(translated)) {
		return normalize(translated);
	}
	return resolve(ctx.workspaceDir, translated);
}

function resolveTargetPath(rawPath: string, ctx: PathGuardContext): string {
	const homeDir = ctx.homeDir ?? homedir();
	const cwd = ctx.cwd ?? process.cwd();
	const normalized = stripNullAndNormalize(rawPath);
	const expanded = maybeExpandHome(normalized, homeDir);
	const translated = translateRuntimeWorkspacePath(expanded, ctx);
	if (isAbsolute(translated)) {
		return normalize(translated);
	}
	return resolve(cwd, translated);
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

function matchesSensitiveReadPath(path: string, homeDir: string): boolean {
	const sensitiveHomePrefixes = HOME_SENSITIVE_PREFIXES.map((item) => resolveHomeConfiguredPath(item, homeDir));
	const sensitiveHomeFiles = HOME_SENSITIVE_FILES.map((item) => resolveHomeConfiguredPath(item, homeDir));
	const sensitiveSystemPrefixes = SYSTEM_SENSITIVE_PREFIXES.map((item) => normalize(item));
	const sensitiveSystemFiles = SYSTEM_SENSITIVE_FILES.map((item) => normalize(item));

	if (matchesAnyPath(path, sensitiveHomeFiles, sensitiveHomePrefixes)) {
		return true;
	}
	if (matchesAnyPath(path, sensitiveSystemFiles, sensitiveSystemPrefixes)) {
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
	const writeDenyHomeFiles = WRITE_DENY_HOME_FILES.map((item) => resolveHomeConfiguredPath(item, homeDir));
	return writeDenyHomeFiles.includes(path);
}

function isWithinTemp(path: string): boolean {
	const configuredPrefixes = TEMP_PREFIXES.map((prefix) => normalize(prefix));
	const runtimeTmpDir = normalize(tmpdir());
	const runtimePrefixes = existsSync(runtimeTmpDir)
		? [runtimeTmpDir, resolveExistingAncestor(runtimeTmpDir)]
		: [runtimeTmpDir];
	return [...configuredPrefixes, ...runtimePrefixes].some((prefix) => startsWithPathPrefix(path, prefix));
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
	return SYSTEM_DENY_PREFIXES.some((prefix) => startsWithPathPrefix(path, normalize(prefix)));
}

function matchesConfiguredPath(path: string, entries: string[], ctx: PathGuardContext): boolean {
	return entries.map((entry) => resolveConfiguredPath(entry, ctx)).some((entry) => startsWithPathPrefix(path, entry));
}

function pathAllowedByDefaults(path: string, ctx: PathGuardContext): boolean {
	const homeDir = ctx.homeDir ?? homedir();
	return isWithinWorkspace(path, ctx.workspaceDir) || isWithinTemp(path) || isWithinHome(path, homeDir);
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
	if (isWindowsPlatform()) {
		return { allowed: true, operation, rawPath };
	}

	const homeDir = ctx.homeDir ?? homedir();
	const effectiveCtx: PathGuardContext = {
		...ctx,
		workspaceDir: resolveForGuard(ctx.workspaceDir, ctx),
		homeDir: resolveForGuard(homeDir, ctx),
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

	if (pathAllowedByDefaults(guardedPath, effectiveCtx)) {
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
