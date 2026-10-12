/**
 * Media (image / file) for DingTalk: outbound delivery (`MediaSender` contract), and the two-step
 * inbound download plus the per-message attachment resolution built on it (spec 049).
 */
import axios from "axios";
import type { MediaSendResult, OutboundMedia } from "../channel/channel-context.js";
import type { InboundImage } from "../channel/channel-event.js";
import * as log from "../log.js";
import { errorMessage } from "../shared/text-utils.js";
import { isRecord } from "../shared/type-guards.js";
import { formatSize } from "../tools/truncate.js";
import { type ConversationMeta, DINGTALK_API, DINGTALK_OAPI, http } from "./api.js";
import type { DingTalkConfig } from "./config.js";
import type { DingTalkHandler } from "./handler.js";
import {
	MAX_INBOUND_IMAGE_BYTES,
	MAX_INBOUND_IMAGES_PER_MESSAGE,
	MEDIA_DOWNLOAD_TIMEOUT_MS,
	type ParsedInboundMessage,
	sniffImageMimeType,
} from "./inbound-media.js";

// DingTalk caps robot image messages at 1MB and file messages at 20MB. We reject
// oversized files before spending an upload round-trip on a request the API rejects.
const MAX_IMAGE_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
// Uploads can move up to 20MB; the 15s default HTTP timeout is too tight for that.
const MEDIA_UPLOAD_TIMEOUT_MS = 60_000;
// File extensions the `sampleFile` message type accepts (per DingTalk docs).
const SUPPORTED_FILE_TYPES = new Set(["xlsx", "pdf", "zip", "rar", "doc", "docx", "ppt", "pptx", "csv", "txt"]);

/** Lowercased extension without the dot ("Report.PDF" → "pdf"); "" when none. */
function extractFileExtension(fileName: string): string {
	const dot = fileName.lastIndexOf(".");
	if (dot < 0 || dot === fileName.length - 1) return "";
	return fileName.slice(dot + 1).toLowerCase();
}

export interface DingTalkMediaDeps {
	config: DingTalkConfig;
	handler: DingTalkHandler;
	getAccessToken: () => Promise<string | null>;
	getConversationMeta: (channelId: string) => ConversationMeta | null;
	sendRobotMessage: (meta: ConversationMeta, msgKey: string, msgParam: string) => Promise<boolean>;
	/**
	 * The inbound file fetch used while resolving attachments. The bot supplies its own overridable
	 * `downloadMessageFile`, so the deterministic e2e harness can stub the network out.
	 */
	downloadMessageFile: (downloadCode: string) => Promise<{ data: Buffer } | null>;
}

export class DingTalkMedia {
	constructor(private deps: DingTalkMediaDeps) {}

	/**
	 * Deliver a local file to a channel as a native attachment. Uploads the bytes
	 * to get a `media_id`, then sends a `sampleImageMsg` (inline image) or
	 * `sampleFile` (downloadable file) robot message. `channelId` is supplied by
	 * the runtime (the tool is bound to its channel at build time), never by the
	 * model, so an agent cannot target a channel other than its own.
	 */
	async sendMedia(channelId: string, media: OutboundMedia): Promise<MediaSendResult> {
		const isImage = media.kind === "image";
		const limit = isImage ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
		if (media.data.length > limit) {
			return {
				ok: false,
				error: `File is ${(media.data.length / 1024 / 1024).toFixed(1)}MB, exceeds the ${limit / 1024 / 1024}MB DingTalk limit for ${media.kind} messages.`,
			};
		}

		const fileType = extractFileExtension(media.fileName);
		if (!isImage && !SUPPORTED_FILE_TYPES.has(fileType)) {
			return {
				ok: false,
				error: `DingTalk file messages do not support the "${fileType || "(none)"}" type. Supported: ${[...SUPPORTED_FILE_TYPES].join(", ")}.`,
			};
		}

		const meta = this.deps.getConversationMeta(channelId);
		if (!meta) {
			return { ok: false, error: "No conversation is known for this channel yet; cannot deliver a file." };
		}

		const mediaId = await this.uploadMedia(isImage ? "image" : "file", media.data, media.fileName);
		if (!mediaId) {
			return { ok: false, error: "Failed to upload the file to DingTalk (see server logs)." };
		}

		const { msgKey, msgParam } = isImage
			? { msgKey: "sampleImageMsg", msgParam: JSON.stringify({ photoURL: mediaId }) }
			: {
					msgKey: "sampleFile",
					msgParam: JSON.stringify({ mediaId, fileName: media.fileName, fileType }),
				};

		const sent = await this.deps.sendRobotMessage(meta, msgKey, msgParam);
		return sent ? { ok: true } : { ok: false, error: "DingTalk rejected the file message (see server logs)." };
	}

	/**
	 * Upload raw bytes to DingTalk and return the reusable `media_id`, or null on
	 * failure. The upload endpoint lives on the legacy oapi host and answers 200
	 * with a non-zero `errcode` on failure, so the body is inspected explicitly.
	 */
	private async uploadMedia(type: "image" | "file", data: Buffer, fileName: string): Promise<string | null> {
		const token = await this.deps.getAccessToken();
		if (!token) return null;

		const form = new FormData();
		form.append("media", new Blob([new Uint8Array(data)]), fileName);

		try {
			const resp = await http.post(
				`${DINGTALK_OAPI}/media/upload?access_token=${encodeURIComponent(token)}&type=${type}`,
				form,
				// Override the 15s default: a multi-MB upload over a slow link can take
				// longer, and unlike card streaming this call is not on the delivery loop.
				{ timeout: MEDIA_UPLOAD_TIMEOUT_MS },
			);
			const body = isRecord(resp.data) ? resp.data : {};
			if (body.errcode && body.errcode !== 0) {
				log.logWarn("dingtalk.media.upload_failed", "Media upload failed", {
					reason: String(body.errmsg ?? ""),
					fields: { errcode: body.errcode },
				});
				return null;
			}
			const mediaId = typeof body.media_id === "string" ? body.media_id : null;
			if (!mediaId) {
				log.logWarn("dingtalk.media.upload_failed", "Media upload returned no media_id", {
					reason: JSON.stringify(body),
				});
			}
			return mediaId;
		} catch (err) {
			if (axios.isAxiosError(err) && err.response) {
				log.logWarn("dingtalk.media.upload_failed", "Media upload failed", {
					reason: JSON.stringify(err.response.data),
					fields: { status: err.response.status },
				});
			} else {
				log.logWarn("dingtalk.media.upload_failed", "Media upload failed", { reason: errorMessage(err) });
			}
			return null;
		}
	}

	/**
	 * Two-step DingTalk inbound file download (spec 049): `messageFiles/download` exchanges the
	 * message's `downloadCode` for a short-lived `downloadUrl`, then that URL is fetched for the
	 * actual bytes. Both hops reuse the shared access token — the same app access token works across
	 * DingTalk's hosts, as the comment on `DINGTALK_OAPI` explains for the outbound side.
	 *
	 * This runs from the inbound per-channel ingestion queue, never from inside a turn: a busy
	 * channel can queue a message for minutes (`USER_MESSAGE_QUEUE_LIMIT`), and by the time a
	 * queued turn actually ran, a `downloadCode`/`downloadUrl` fetched only then could easily have
	 * already expired.
	 */
	async downloadMessageFile(downloadCode: string): Promise<{ data: Buffer } | null> {
		const token = await this.deps.getAccessToken();
		if (!token) return null;

		const robotCode = this.deps.config.robotCode || this.deps.config.clientId;

		try {
			const downloadUrlResp = await http.post(
				`${DINGTALK_API}/v1.0/robot/messageFiles/download`,
				{ robotCode, downloadCode },
				{ headers: { "x-acs-dingtalk-access-token": token } },
			);
			const downloadUrl = isRecord(downloadUrlResp.data) ? downloadUrlResp.data.downloadUrl : undefined;
			if (typeof downloadUrl !== "string" || !downloadUrl) {
				log.logWarn("dingtalk.file.download_failed", "Inbound file download returned no downloadUrl", {
					reason: JSON.stringify(downloadUrlResp.data),
				});
				return null;
			}

			const fileResp = await http.get(downloadUrl, {
				responseType: "arraybuffer",
				// Reject an oversized body before it fully lands in memory rather than after.
				maxContentLength: MAX_INBOUND_IMAGE_BYTES,
				timeout: MEDIA_DOWNLOAD_TIMEOUT_MS,
			});
			return { data: Buffer.from(fileResp.data as ArrayBuffer) };
		} catch (err) {
			if (axios.isAxiosError(err) && err.response) {
				log.logWarn("dingtalk.file.download_failed", "Inbound file download failed", {
					reason: JSON.stringify(err.response.data),
					fields: { status: err.response.status },
				});
			} else {
				log.logWarn("dingtalk.file.download_failed", "Inbound file download failed", { reason: errorMessage(err) });
			}
			return null;
		}
	}

	/**
	 * Resolve one parsed message's image credentials into persisted `InboundImage`s and a text
	 * with every `[图片N]` marker either left as-is (success) or replaced with a reason (spec 049
	 * D8): a download failure, an unrecognized format, an oversized file, or a message that
	 * simply carried more images than `MAX_INBOUND_IMAGES_PER_MESSAGE` allows. A failure on one
	 * image never drops the rest of the message — only that one marker changes.
	 *
	 * No-op (no network call at all) when the message carries no image credentials, so a plain
	 * text message never pays for this method's existence.
	 */
	async resolveInboundAttachments(
		channelId: string,
		parsed: ParsedInboundMessage,
	): Promise<{ text: string; images: InboundImage[] }> {
		if (parsed.downloadCodes.length === 0) {
			return { text: parsed.text, images: [] };
		}

		let text = parsed.text;
		const images: (InboundImage | undefined)[] = [];
		const replaceMarker = (index: number, replacement: string) => {
			text = text.replace(`[图片${index + 1}]`, replacement);
		};

		await Promise.all(
			parsed.downloadCodes.map(async (downloadCode, index) => {
				const marker = index + 1;
				if (index >= MAX_INBOUND_IMAGES_PER_MESSAGE) {
					replaceMarker(index, `[图片${marker}：超出单条消息图片数量上限，已丢弃]`);
					return;
				}

				const downloaded = await this.deps.downloadMessageFile(downloadCode);
				if (!downloaded) {
					replaceMarker(index, `[图片${marker}：接收失败]`);
					return;
				}

				if (downloaded.data.byteLength > MAX_INBOUND_IMAGE_BYTES) {
					replaceMarker(index, `[图片${marker}：文件过大（${formatSize(downloaded.data.byteLength)}），已丢弃]`);
					return;
				}

				const mimeType = sniffImageMimeType(downloaded.data);
				const persisted = await this.deps.handler.persistInboundImage?.(channelId, {
					data: downloaded.data,
					mimeType,
				});
				if (!persisted) {
					replaceMarker(index, `[图片${marker}：保存失败]`);
					return;
				}

				if (!mimeType) {
					// Persisted for the record, but never handed to a model — see the handler
					// contract's doc comment on `persistInboundImage`.
					replaceMarker(index, `[图片${marker}：格式不支持，已保存]`);
				}
				images[index] = persisted;
			}),
		);

		return { text, images: images.filter((image): image is InboundImage => image !== undefined) };
	}
}
