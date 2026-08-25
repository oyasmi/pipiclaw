import type { AgentTool } from "@earendil-works/pi-agent-core";
import { basename, extname } from "path";
import { Type } from "typebox";
import type { FileStore } from "../file-store.js";
import type { MediaSender } from "../runtime/channel-context.js";
import { DEFAULT_SECURITY_CONFIG } from "../security/config.js";
import { checkPathGuard } from "../security/path-guard-check.js";
import type { SecurityConfig, SecurityRuntimeContext } from "../security/types.js";
import { RecoverableToolError } from "../shared/recoverable-error.js";
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

/**
 * Send a workspace file to the current channel as a native attachment (inline
 * image or downloadable file). Bound to its channel at build time — like `read`
 * and `bash` — so the model never chooses the destination. The file is read
 * through `FileStore` (spec 044, D7) rather than shelling out to `base64`, so
 * there is no 4/3 blow-up through a captured stdout string to size against, and
 * every path passes the same path-guard as the file tools before any bytes leave
 * the box.
 */
export function createSendMediaTool(
	fileStore: FileStore,
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
			const target = await checkPathGuard(path, "read", securityConfig, securityContext, {
				tool: "send_media",
				channelId: options.channelId,
			});

			const stat = await fileStore.stat(target);
			if (!stat || !stat.isFile) {
				throw new RecoverableToolError(`Cannot send ${path}: not a regular file (does it exist?).`);
			}
			if (stat.size > MAX_INLINE_BINARY_BYTES) {
				throw new RecoverableToolError(
					`Cannot send ${path}: it is ${formatSize(stat.size)}, over the ${formatSize(MAX_INLINE_BINARY_BYTES)} send limit. ` +
						"Compress it first, or provide the path so the user can be told where to find it.",
				);
			}
			if (stat.size === 0) {
				throw new RecoverableToolError(`Cannot send ${path}: the file is empty.`);
			}

			const { data } = await fileStore.readBytes(target, { signal });

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
