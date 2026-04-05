import { dirname } from "node:path";
import type { ExecResult, Executor } from "../sandbox.js";
import { DEFAULT_SECURITY_CONFIG } from "../security/config.js";
import { logSecurityEvent } from "../security/logger.js";
import { guardPath } from "../security/path-guard.js";
import type { SecurityConfig, SecurityRuntimeContext } from "../security/types.js";
import { shellEscapePath } from "../shared/shell-escape.js";

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
		workspaceDir: process.cwd(),
		workspacePath: process.cwd(),
		cwd: process.cwd(),
	};

	if (securityConfig.enabled && securityConfig.pathGuard.enabled) {
		const guardResult = guardPath(path, "write", { ...securityContext, config: securityConfig.pathGuard });
		if (!guardResult.allowed) {
			logSecurityEvent(securityContext.workspaceDir, securityConfig, {
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

	const dirPrefix = createParentDir ? `mkdir -p ${shellEscapePath(getDir(path))} && ` : "";

	const result = await executor.exec(`${dirPrefix}cat > ${shellEscapePath(path)}`, {
		signal,
		stdin: content,
	});
	ensureSuccess(result, path);
}
