import { dirname } from "node:path";
import type { ExecResult, Executor } from "../executor.js";
import { DEFAULT_SECURITY_CONFIG } from "../security/config.js";
import { logSecurityEvent } from "../security/logger.js";
import { guardPath } from "../security/path-guard.js";
import type { SecurityConfig, SecurityRuntimeContext } from "../security/types.js";
import { shellEscape } from "../shared/shell-escape.js";

function getDir(path: string): string {
	return dirname(path);
}

function ensureSuccess(result: ExecResult, path: string): void {
	if (result.code !== 0) {
		throw new Error(result.stderr || `Failed to write file: ${path}`);
	}
}

export async function writeContent(
	executor: Executor,
	path: string,
	content: string,
	signal: AbortSignal | undefined,
	options?: {
		createParentDir?: boolean;
		securityConfig?: SecurityConfig;
		securityContext?: SecurityRuntimeContext;
		channelId?: string;
		toolName?: string;
	},
): Promise<void> {
	const createParentDir = options?.createParentDir ?? false;
	const securityConfig = options?.securityConfig ?? DEFAULT_SECURITY_CONFIG;
	const securityContext = options?.securityContext ?? {
		agentWorkspaceDir: process.cwd(),
		projectRoot: process.cwd(),
	};

	if (securityConfig.enabled && securityConfig.pathGuard.enabled) {
		const guardResult = guardPath(path, "write", { ...securityContext, config: securityConfig.pathGuard });
		if (!guardResult.allowed) {
			await logSecurityEvent(securityContext.agentWorkspaceDir, securityConfig, {
				type: "path",
				tool: options?.toolName ?? "write",
				channelId: options?.channelId,
				rawPath: path,
				operation: "write",
				resolvedPath: guardResult.resolvedPath,
				category: guardResult.category,
				reason: guardResult.reason,
			});
			const lines = [`Path blocked${guardResult.category ? ` [${guardResult.category}]` : ""}`];
			if (guardResult.reason) {
				lines.push(`Reason: ${guardResult.reason}`);
			}
			if (guardResult.resolvedPath) {
				lines.push(`Resolved path: ${guardResult.resolvedPath}`);
			}
			throw new Error(lines.join("\n"));
		}
	}

	const dirPrefix = createParentDir ? `mkdir -p ${shellEscape(getDir(path))} && ` : "";

	// Atomic write via a same-directory temp file + rename (fix plan §4.1): `cat > path` truncates
	// before writing, so a process death or full disk mid-write leaves a corrupted file. `cp -p`
	// copies the existing file's permission bits onto the temp file first -- `mv` onto an existing
	// path otherwise keeps the *destination's* inode and mode, but a fresh temp file created by the
	// shell has its own default mode, and simply overwriting via a new inode would silently strip
	// an executable file's permission bit on its very next edit.
	const tempPath = `${path}.pipiclaw-tmp`;
	const script =
		`${dirPrefix}tmp=${shellEscape(tempPath)}; ` +
		`[ -f ${shellEscape(path)} ] && cp -p ${shellEscape(path)} "$tmp" 2>/dev/null; ` +
		`cat > "$tmp" && mv -f "$tmp" ${shellEscape(path)}`;

	const result = await executor.exec(script, {
		signal,
		stdin: content,
	});
	ensureSuccess(result, path);
}
