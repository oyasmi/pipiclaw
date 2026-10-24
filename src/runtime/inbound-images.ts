/**
 * Inbound attachments on the runtime side: persist what a transport downloaded under the bound
 * desk's `inbox/`, settle the `[图片N]` / `[文件N]` markers in the message text, and map absolute
 * image paths back to desk-relative ones for the message archive.
 */
import { mkdir, writeFile } from "fs/promises";
import { basename, join, relative } from "path";
import { extensionForMimeType, sniffImageMimeType } from "../channel/attachments.js";
import type { InboundImage } from "../channel/channel-event.js";
import type { InboundAttachment } from "../channel/ingress.js";
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
 * not the transport, because it resolves the binding; an unbound channel never gets here (D4).
 * `mimeType` is `null` when magic-byte sniffing did not recognize a supported image format: the
 * file is still persisted (for the archive) but never handed to a model. Returns `null` on a local
 * I/O failure.
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
		log.logWarn("runtime.inbound_image.persist_failed", "Inbound image persist failed", {
			channelId: channelId,
			reason: errorMessage(err),
		});
		return null;
	}
}

const MAX_INBOUND_FILE_NAME_CHARS = 100;

/** A transport-supplied file name made safe to use as the tail of a file name inside `inbox/`. */
function safeInboundFileName(fileName: string): string {
	const base = basename(fileName.replace(/\\/g, "/")).replace(/[^\p{L}\p{N}._-]+/gu, "_");
	const trimmed = base.replace(/^\.+/, "").slice(-MAX_INBOUND_FILE_NAME_CHARS);
	return trimmed || "file";
}

/** Persist one inbound file under the desk's `inbox/`; the path, or `null` on a local I/O failure. */
export async function persistInboundFile(
	deskDir: string,
	channelId: string,
	file: { data: Buffer; fileName: string },
): Promise<string | null> {
	try {
		const dir = getDeskInboxDir(deskDir);
		await mkdir(dir, { recursive: true });
		const path = join(dir, `file-${localStampForFilename()}-${safeInboundFileName(file.fileName)}`);
		await writeFile(path, file.data, { mode: 0o600 });
		return path;
	} catch (err) {
		log.logWarn("runtime.inbound_file.persist_failed", "Inbound file persist failed", {
			channelId: channelId,
			reason: errorMessage(err),
		});
		return null;
	}
}

/**
 * Settle one message's attachments once its channel's desk is known (D5): persist each under the
 * desk's `inbox/` and say in the text what became of it. An image that could not be saved, or is
 * not a recognizable image format, never reaches the model; it only changes its own marker. With
 * no desk (the channel is not bound to an available one) nothing is written and every attachment
 * reads as not saved.
 */
export async function resolveInboundAttachments(input: {
	deskDir: string | undefined;
	channelId: string;
	text: string;
	attachments: readonly InboundAttachment[];
}): Promise<{ text: string; images: InboundImage[] }> {
	const { deskDir, channelId } = input;
	let text = input.text;
	const appended: string[] = [];
	const replaceMarker = (marker: string, replacement: string) => {
		text = text.replace(marker, replacement);
	};
	const images: Array<{ index: number; image: InboundImage }> = [];

	await Promise.all(
		input.attachments.map(async (attachment) => {
			if (attachment.kind === "image") {
				const marker = `[图片${attachment.index}]`;
				const mimeType = sniffImageMimeType(attachment.data);
				const persisted = deskDir
					? await persistInboundImage(deskDir, channelId, { data: attachment.data, mimeType })
					: null;
				if (!persisted) {
					replaceMarker(marker, `[图片${attachment.index}：保存失败]`);
					return;
				}
				if (!mimeType) {
					// Persisted for the record, but never handed to a model.
					replaceMarker(marker, `[图片${attachment.index}：格式不支持，已保存]`);
					return;
				}
				images.push({ index: attachment.index, image: persisted });
				return;
			}
			const marker = `[文件${attachment.index}]`;
			const path = deskDir ? await persistInboundFile(deskDir, channelId, attachment) : null;
			if (!path) {
				replaceMarker(marker, `[文件${attachment.index}：保存失败]`);
				return;
			}
			appended.push(`[文件${attachment.index}：${attachment.fileName} 已保存到 ${path}]`);
		}),
	);

	appended.sort();
	return {
		text: appended.length > 0 ? `${text}\n${appended.join("\n")}` : text,
		images: images.sort((a, b) => a.index - b.index).map((entry) => entry.image),
	};
}
