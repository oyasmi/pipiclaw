import type { BootstrapIO } from "../runtime/bootstrap.js";
import type { MediaSender, MediaSendResult, OutboundMedia } from "../runtime/channel-context.js";

/**
 * Terminal implementation of the `MediaSender` port. There is no chat surface to
 * push a file to, and the bytes already came from a local file, so "sending" here
 * just surfaces a notice — keeping the `send_media` tool available and behaving
 * symmetrically across transports rather than being silently absent in the TUI.
 */
export function createTerminalMediaSender(io: BootstrapIO): MediaSender {
	return {
		async sendMedia(_channelId: string, media: OutboundMedia): Promise<MediaSendResult> {
			const sizeKb = (media.data.length / 1024).toFixed(1);
			io.log(`📎 [send_media] ${media.kind}: ${media.fileName} (${sizeKb}KB)`);
			return { ok: true };
		},
	};
}
