import { formatBlockMessage } from "./block-message.js";
import { logSecurityEvent } from "./logger.js";
import { guardPath } from "./path-guard.js";
import type { SecurityConfig, SecurityRuntimeContext } from "./types.js";

export interface PathGuardCheckOptions {
	tool: string;
	channelId?: string;
}

function formatPathBlockMessage(resolvedPath: string | undefined, category?: string, reason?: string): string {
	const details = [];
	if (reason) details.push({ label: "Reason", value: reason });
	if (resolvedPath) details.push({ label: "Resolved path", value: resolvedPath });
	return formatBlockMessage("Path", category, details);
}

/**
 * Run the path guard and return the single resolved path every file tool must operate on from
 * here on (spec 044, D1.1) -- what the guard judged and what `FileStore`/`Executor` actually opens
 * are the same value by construction, never re-derived. Always returns a `resolvedPath`, including
 * when `security.json` has the guard disabled: resolution is normalization, not policy, so turning
 * the guard off must not be the one case where a tool falls back to an unresolved raw path.
 */
export async function checkPathGuard(
	rawPath: string,
	operation: "read" | "write",
	securityConfig: SecurityConfig,
	securityContext: SecurityRuntimeContext,
	options: PathGuardCheckOptions,
): Promise<string> {
	const effectiveConfig = securityConfig.enabled
		? securityConfig.pathGuard
		: { ...securityConfig.pathGuard, enabled: false };
	const guardResult = guardPath(rawPath, operation, { ...securityContext, config: effectiveConfig });
	if (!guardResult.allowed) {
		await logSecurityEvent(securityContext.agentWorkspaceDir, securityConfig, {
			type: "path",
			tool: options.tool,
			channelId: options.channelId,
			rawPath,
			operation,
			resolvedPath: guardResult.resolvedPath,
			category: guardResult.category,
			reason: guardResult.reason,
		});
		throw new Error(formatPathBlockMessage(guardResult.resolvedPath, guardResult.category, guardResult.reason));
	}
	// `guardPath` always populates `resolvedPath` on an allowed result (see D1.1 above).
	return guardResult.resolvedPath as string;
}
