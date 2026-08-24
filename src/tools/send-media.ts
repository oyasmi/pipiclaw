import type { AgentTool } from "@earendil-works/pi-agent-core";
import { basename, extname } from "path";
import { Type } from "typebox";
import type { Executor } from "../executor.js";
import type { MediaSender } from "../runtime/channel-context.js";
import { DEFAULT_SECURITY_CONFIG } from "../security/config.js";
import { logSecurityEvent } from "../security/logger.js";
import { guardPath } from "../security/path-guard.js";
import type { SecurityConfig, SecurityRuntimeContext } from "../security/types.js";
import { RecoverableToolError } from "../shared/recoverable-error.js";
import { shellEscape } from "../shared/shell-escape.js";
import { formatSize, MAX_INLINE_BINARY_BYTES } from "./truncate.js";

/** Extensions delivered as inline images; everything else goes as a file attachment. */
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);

const sendMediaSchema = Type.Object({
	label: Type.String({ description: "Brief description of what you're sending and why (shown to the user)" }),
	path: Type.String({ description: "Path to the local file to send (relative to the workspace, or absolute)" }),
	fileName: Type.Optional(
		Type.String({ description: "Display name for the recipient; defaults to the file's own name" }),
	),
});

export interface SendMediaToolOptions {
	/** Transport that actually delivers the attachment. Bound to `channelId`. */
	mediaSender: MediaSender;
	/** The channel this tool instance is bound to — supplied by the runtime, not the model. */
	channelId: string;
	securityConfig?: SecurityConfig;
	securityContext?: SecurityRuntimeContext;
}

function formatPathBlockMessage(resolvedPath: string | undefined, category?: string, reason?: string): string {
	const lines = [`Path blocked${category ? ` [${category}]` : ""}`];
	if (reason) lines.push(`Reason: ${reason}`);
	if (resolvedPath) lines.push(`Resolved path: ${resolvedPath}`);
	return lines.join("\n");
}

/**
 * Send a workspace file to the current channel as a native attachment (inline
 * image or downloadable file). Bound to its channel at build time — like `read`
 * and `bash` — so the model never chooses the destination. The file is read
 * through the `Executor` (base64, exactly as `read` does for images) so the tool
 * works regardless of where the executor runs, and every path passes the same
 * path-guard as the file tools before any bytes leave the box.
 */
export function createSendMediaTool(
	executor: Executor,
	options: SendMediaToolOptions,
): AgentTool<typeof sendMediaSchema> {
	const securityConfig = options.securityConfig ?? DEFAULT_SECURITY_CONFIG;
	const securityContext = options.securityContext ?? { agentWorkspaceDir: process.cwd(), projectRoot: process.cwd() };

	return {
		name: "send_media",
		label: "send_media",
		description:
			"Send a local file to the user in the current channel as a native attachment. " +
			"Image files (jpg, png, gif, webp, bmp) are delivered inline; everything else is sent as a downloadable file. " +
			"Use this to hand the user a generated report, screenshot, chart, or export — not for showing file contents to yourself (use `read` for that).",
		parameters: sendMediaSchema,
		execute: async (
			_toolCallId: string,
			{ path, fileName }: { label: string; path: string; fileName?: string },
			signal?: AbortSignal,
		): Promise<{ content: { type: "text"; text: string }[]; details: undefined }> => {
			if (securityConfig.enabled && securityConfig.pathGuard.enabled) {
				const guardResult = guardPath(path, "read", { ...securityContext, config: securityConfig.pathGuard });
				if (!guardResult.allowed) {
					await logSecurityEvent(securityContext.agentWorkspaceDir, securityConfig, {
						type: "path",
						tool: "send_media",
						channelId: options.channelId,
						rawPath: path,
						operation: "read",
						resolvedPath: guardResult.resolvedPath,
						category: guardResult.category,
						reason: guardResult.reason,
					});
					throw new Error(
						formatPathBlockMessage(guardResult.resolvedPath, guardResult.category, guardResult.reason),
					);
				}
			}

			// Confirm the target is a readable regular file and get its size before base64-encoding
			// it, in one exec. Size matters because base64 inflates to 4/3 and the executor caps
			// captured stdout at 10MB -- above the inline limit, base64 would be silently truncated
			// mid-encoding into a buffer that still decodes: a corrupt file "successfully" sent to
			// the user with no error at all (fix plan §2.3).
			const stat = await executor.exec(
				`if [ -f ${shellEscape(path)} ]; then wc -c < ${shellEscape(path)}; else echo NO; fi`,
				{ signal },
			);
			const statOutput = stat.stdout.trim();
			if (statOutput === "NO") {
				throw new RecoverableToolError(`Cannot send ${path}: not a regular file (does it exist?).`);
			}
			const sizeBytes = Number.parseInt(statOutput, 10);
			if (Number.isFinite(sizeBytes) && sizeBytes > MAX_INLINE_BINARY_BYTES) {
				throw new RecoverableToolError(
					`Cannot send ${path}: it is ${formatSize(sizeBytes)}, over the ${formatSize(MAX_INLINE_BINARY_BYTES)} send limit. ` +
						"Compress it first, or provide the path so the user can be told where to find it.",
				);
			}

			const encoded = await executor.exec(`base64 < ${shellEscape(path)}`, { signal });
			if (encoded.code !== 0) {
				throw new Error(encoded.stderr || `Failed to read file: ${path}`);
			}
			const data = Buffer.from(encoded.stdout.replace(/\s/g, ""), "base64");
			if (data.length === 0) {
				throw new RecoverableToolError(`Cannot send ${path}: the file is empty.`);
			}

			const name = fileName?.trim() || basename(path);
			const kind = IMAGE_EXTENSIONS.has(extname(name).toLowerCase()) ? "image" : "file";

			const result = await options.mediaSender.sendMedia(options.channelId, { data, fileName: name, kind });
			if (!result.ok) {
				throw new Error(result.error ?? "Failed to send the file to the channel.");
			}

			return {
				content: [
					{
						type: "text",
						text: `Sent ${kind === "image" ? "image" : "file"} "${name}" (${(data.length / 1024).toFixed(1)}KB) to the channel.`,
					},
				],
				details: undefined,
			};
		},
	};
}
