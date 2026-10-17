/**
 * Inbound images on the runtime side: persist a downloaded image under the channel's `inbox/`, and
 * map absolute image paths back to channel-relative ones for the message archive.
 */
import { mkdir, writeFile } from "fs/promises";
import { join, relative } from "path";
import type { InboundImage } from "../channel/channel-event.js";
import { getChannelDir } from "../channel/channel-paths.js";
import { extensionForMimeType } from "../dingtalk/inbound-media.js";
import * as log from "../log.js";
import { localStampForFilename } from "../shared/local-time.js";
import { errorMessage } from "../shared/text-utils.js";

/**
 * Absolute `InboundImage.path`s → paths relative to the channel directory, for
 * `LoggedMessage.images` (spec 049). `log.jsonl` already stores everything else channel-relative
 * (it lives inside the channel directory itself); an absolute path there would be dead on any
 * machine other than the one that wrote it, and `~/.pipiclaw` itself can move between backup and
 * restore.
 */
export function relativeImagePaths(
	workspaceDir: string,
	channelId: string,
	images: InboundImage[] | undefined,
): string[] {
	if (!images || images.length === 0) return [];
	const dotDir = getChannelDir(workspaceDir, channelId);
	return images.map((image) => relative(dotDir, image.path));
}

/**
 * Persist one downloaded inbound image under the channel's `inbox/` (spec 049). The runtime owns
 * this, not the transport, because it holds the workspace root; see the doc comment on
 * `DingTalkHandler.persistInboundImage` for the full contract (`mimeType: null` case included).
 */

export async function persistInboundImage(
	workspaceDir: string,
	channelId: string,
	image: { data: Buffer; mimeType: string | null },
): Promise<InboundImage | null> {
	try {
		const dir = join(getChannelDir(workspaceDir, channelId), "inbox");
		await mkdir(dir, { recursive: true });
		const extension = extensionForMimeType(image.mimeType);
		const path = join(dir, `image-${localStampForFilename()}-${Math.random().toString(36).slice(2, 8)}.${extension}`);
		await writeFile(path, image.data, { mode: 0o600 });
		return {
			path,
			mimeType: image.mimeType ?? "application/octet-stream",
			byteSize: image.data.byteLength,
			...(image.mimeType === null ? { unsupportedFormat: true } : {}),
		};
	} catch (err) {
		log.logWarn("dingtalk.media.persist_failed", "Inbound image persist failed", {
			channelId: channelId,
			reason: errorMessage(err),
		});
		return null;
	}
}
