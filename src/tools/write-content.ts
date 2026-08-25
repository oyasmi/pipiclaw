import type { FileStore } from "../file-store.js";
import { DEFAULT_SECURITY_CONFIG } from "../security/config.js";
import { checkPathGuard } from "../security/path-guard-check.js";
import type { SecurityConfig, SecurityRuntimeContext } from "../security/types.js";

export async function writeContent(
	fileStore: FileStore,
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

	const target = await checkPathGuard(path, "write", securityConfig, securityContext, {
		tool: options?.toolName ?? "write",
		channelId: options?.channelId,
	});

	// Atomic write via a same-directory temp file + rename, with fsync (spec 044, D3): `writeAtomic`
	// preserves the existing file's permission bits across the rename, exactly as the old
	// `cp -p` + `cat > tmp && mv` shell script did, but content now goes straight to `node:fs`
	// instead of a stdin pipe into `sh -c` -- it never exists in memory twice, and there is no
	// shell script to escape or an EPIPE to swallow.
	await fileStore.writeAtomic(target, content, { createParentDir, preserveMode: true, signal });
}
