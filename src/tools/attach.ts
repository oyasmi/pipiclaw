import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import { basename, resolve as resolvePath } from "path";
import { DEFAULT_SECURITY_CONFIG } from "../security/config.js";
import { logSecurityEvent } from "../security/logger.js";
import { guardPath } from "../security/path-guard.js";
import type { SecurityConfig, SecurityRuntimeContext } from "../security/types.js";

const attachSchema = Type.Object({
	label: Type.String({ description: "Brief description of what you're sharing (shown to user)" }),
	path: Type.String({ description: "Path to the file to attach" }),
	title: Type.Optional(Type.String({ description: "Title for the file (defaults to filename)" })),
});

export type UploadFunction = (filePath: string, title?: string) => Promise<void>;

export interface AttachToolOptions {
	securityConfig?: SecurityConfig;
	securityContext?: SecurityRuntimeContext;
	channelId?: string;
}

/**
 * Create the attach tool. If no uploadFn is provided, the tool will throw
 * an informative error guiding the LLM to use alternative approaches.
 */
export function createAttachTool(
	uploadFn?: UploadFunction,
	options: AttachToolOptions = {},
): AgentTool<typeof attachSchema> {
	const securityConfig = options.securityConfig ?? DEFAULT_SECURITY_CONFIG;
	const securityContext = options.securityContext ?? {
		workspaceDir: process.cwd(),
		workspacePath: process.cwd(),
		cwd: process.cwd(),
	};

	return {
		name: "attach",
		label: "attach",
		description:
			"Attach a file to your response. Use this to share files, images, or documents with the user. Only files from /workspace/ can be attached.",
		parameters: attachSchema,
		execute: async (
			_toolCallId: string,
			{ path, title }: { label: string; path: string; title?: string },
			signal?: AbortSignal,
		) => {
			if (!uploadFn) {
				throw new Error(
					"File upload is not supported in DingTalk mode. Output file content as text instead, or use bash to host files.",
				);
			}

			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			const absolutePath = resolvePath(path);
			if (securityConfig.enabled && securityConfig.pathGuard.enabled) {
				const readGuard = guardPath(path, "read", { ...securityContext, config: securityConfig.pathGuard });
				if (!readGuard.allowed) {
					logSecurityEvent(securityContext.workspaceDir, securityConfig, {
						type: "path",
						tool: "attach",
						channelId: options.channelId,
						rawPath: path,
						operation: "read",
						resolvedPath: readGuard.resolvedPath,
						category: readGuard.category,
						reason: readGuard.reason,
					});
					throw new Error(
						[
							`Path blocked${readGuard.category ? ` [${readGuard.category}]` : ""}`,
							readGuard.reason ? `Reason: ${readGuard.reason}` : "",
							readGuard.resolvedPath ? `Resolved path: ${readGuard.resolvedPath}` : "",
						]
							.filter(Boolean)
							.join("\n"),
					);
				}
				const workspaceRoot = resolvePath(securityContext.workspaceDir);
				if (absolutePath !== workspaceRoot && !absolutePath.startsWith(`${workspaceRoot}/`)) {
					throw new Error("Attach is limited to files inside the workspace directory.");
				}
			}

			const fileName = title || basename(absolutePath);

			await uploadFn(absolutePath, fileName);

			return {
				content: [{ type: "text" as const, text: `Attached file: ${fileName}` }],
				details: undefined,
			};
		},
	};
}
