import type { BootstrapIO } from "../app/home.js";
import type { MediaSendResult, OutboundMedia } from "../channel/transport.js";

/**
 * Terminal implementation of `send_media`. There is no chat surface to push a file to, and the
 * bytes already came from a local file, so "sending" here just surfaces a notice — keeping the
 * `send_media` tool available and behaving symmetrically across transports rather than being
 * silently absent in the TUI.
 */
export function createTerminalSendMedia(io: BootstrapIO) {
	return async (_channelId: string, media: OutboundMedia): Promise<MediaSendResult> => {
		const sizeKb = (media.data.length / 1024).toFixed(1);
		io.log(`📎 [send_media] ${media.kind}: ${media.fileName} (${sizeKb}KB)`);
		return { ok: true };
	};
}
