import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { ConfigDiagnostic } from "../shared/config-diagnostic.js";
import type { SecurityConfig } from "./types.js";

/** Spec 043, D6.3: the runtime must never claim `system` without an explicit bootstrap-injected
 * host sandbox. Nothing wires that injection point yet, so this is the only reachable value today. */
export interface ProjectSandboxStatus {
	level: "application" | "system";
	provider: string;
	summary: string;
}

/** The effective result a runner generation uses; see D2.1. Not the raw request. */
export interface ProjectScope {
	/** Realpath of an existing directory. */
	projectRoot: string;
	/** `project`: generic file tools are bounded to `projectRoot`. `unbounded`: today's global pathGuard defaults. */
	boundary: "project" | "unbounded";
	sandbox: ProjectSandboxStatus;
}

/** The app-level policy resolved from `security.json`'s `projectAccess` section (D3.1). */
export interface ProjectAccessPolicy {
	/** Realpath. Always a member of `allowedRoots`. */
	defaultRoot: string;
	/** Realpaths. */
	allowedRoots: readonly string[];
}

export interface ProjectAccessResolution {
	policy: ProjectAccessPolicy;
	/** False in the unconfigured-compat state, or when `defaultRoot` itself fails to canonicalize. */
	mutable: boolean;
	/** Whether `security.json` had a `projectAccess` key at all (distinct from mutable — see D3.2). */
	configured: boolean;
	diagnostics: ConfigDiagnostic[];
}

const DIAGNOSTIC_SOURCE = "security" as const;

function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
	return path;
}

/** Absolute, existing, real directory — or `undefined` if any of that doesn't hold. */
function canonicalizeRoot(raw: string): string | undefined {
	const expanded = expandHome(raw);
	if (!isAbsolute(expanded)) return undefined;
	try {
		const real = realpathSync(expanded);
		return statSync(real).isDirectory() ? real : undefined;
	} catch {
		return undefined;
	}
}

function realpathOrResolve(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

/**
 * Resolves the app's project-access policy for a fresh runner generation. `startupCwd` is only
 * used as the implicit default when `projectAccess` is configured but omits `defaultRoot` (D3.2
 * row 3) — the unconfigured-compat row (row 1) also uses it, but never persists it as a "chosen"
 * default the way a configured policy's `defaultRoot` is.
 */
export function resolveProjectAccessPolicy(config: SecurityConfig, startupCwd: string): ProjectAccessResolution {
	const diagnostics: ConfigDiagnostic[] = [];
	const raw = config.projectAccess;
	const fallbackRoot = realpathOrResolve(startupCwd);

	if (!raw) {
		return {
			policy: { defaultRoot: fallbackRoot, allowedRoots: [fallbackRoot] },
			mutable: false,
			configured: false,
			diagnostics,
		};
	}

	const defaultRootRaw = raw.defaultRoot ?? startupCwd;
	const defaultRoot = canonicalizeRoot(defaultRootRaw);
	if (!defaultRoot) {
		diagnostics.push({
			source: DIAGNOSTIC_SOURCE,
			path: "projectAccess.defaultRoot",
			severity: "error",
			message: `${JSON.stringify(defaultRootRaw)} is not an absolute, existing directory; project scope changes are disabled until this is fixed`,
		});
		return {
			policy: { defaultRoot: fallbackRoot, allowedRoots: [fallbackRoot] },
			mutable: false,
			configured: true,
			diagnostics,
		};
	}

	const rawAllowed = raw.allowedRoots && raw.allowedRoots.length > 0 ? raw.allowedRoots : [defaultRootRaw];
	const allowedRoots = new Set<string>([defaultRoot]);
	for (const entry of rawAllowed) {
		const canonical = canonicalizeRoot(entry);
		if (!canonical) {
			diagnostics.push({
				source: DIAGNOSTIC_SOURCE,
				path: "projectAccess.allowedRoots",
				severity: "warning",
				message: `entry ${JSON.stringify(entry)} is not an absolute, existing directory; ignored`,
			});
			continue;
		}
		allowedRoots.add(canonical);
	}

	return {
		policy: { defaultRoot, allowedRoots: [...allowedRoots] },
		mutable: true,
		configured: true,
		diagnostics,
	};
}

function withTrailingSlash(path: string): string {
	return path.endsWith("/") ? path : `${path}/`;
}

/** Prefix match with a path-separator boundary, so `/repo-ab` is not treated as within `/repo-a`. */
export function isWithinAllowedRoots(root: string, policy: ProjectAccessPolicy): boolean {
	return policy.allowedRoots.some((allowed) => root === allowed || root.startsWith(withTrailingSlash(allowed)));
}

/** True until a host sandbox injection point exists (D6.3, D9 risk #2) — see `ProjectSandboxStatus`. */
export function currentProjectSandboxStatus(): ProjectSandboxStatus {
	return {
		level: "application",
		provider: "pipiclaw-path-guard",
		summary: "文件工具被约束在项目目录内；shell 仅设置了 cwd，未受系统沙箱隔离，可通过 cd/绝对路径/子进程逃逸。",
	};
}

/** True if `raw` resolves (after `~`-expansion) to an existing directory — used by `/project set` validation. */
export function resolveExistingDirectory(raw: string): string | undefined {
	return canonicalizeRoot(raw);
}
