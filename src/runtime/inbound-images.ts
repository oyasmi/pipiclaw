/**
 * Inbound images on the runtime side: persist a downloaded image under the bound desk's `inbox/`,
 * and map absolute image paths back to desk-relative ones for the message archive.
 */
import { mkdir, writeFile } from "fs/promises";
import { join, relative } from "path";
import { extensionForMimeType } from "../channel/attachments.js";
import type { InboundImage } from "../channel/channel-event.js";
import { getDeskInboxDir } from "../desk/paths.js";
import * as log from "../log.js";
import { localStampForFilename } from "../shared/local-time.js";
import { errorMessage } from "../shared/text-utils.js";

/**
 * Absolute `InboundImage.path`s → paths relative to the desk directory, for `LoggedMessage.images`
 * (spec 049). An absolute path in `log.jsonl` would be dead on any machine other than the one that
 * wrote it, and `~/.pipiclaw` itself can move between backup and restore.
 */
export function relativeImagePaths(deskDir: string | undefined, images: InboundImage[] | undefined): string[] {
	if (!deskDir || !images || images.length === 0) return [];
	return images.map((image) => relative(deskDir, image.path));
}

/**
 * Persist one downloaded inbound image under the desk's `inbox/` (spec 049). The runtime owns this,
 * not the transport, because it resolves the binding; an unbound channel never gets here (D4). See
 * the doc comment on `DingTalkHandler.persistInboundImage` for the full contract.
 */
export async function persistInboundImage(
	deskDir: string,
	channelId: string,
	image: { data: Buffer; mimeType: string | null },
): Promise<InboundImage | null> {
	try {
		const dir = getDeskInboxDir(deskDir);
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
