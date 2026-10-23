/**
 * Preparing a user's input for a turn: the timestamped message line, oversized-input spill to disk,
 * raw-passthrough detection for slash commands, and inbound images turned into `ImageContent`.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import { type InboundImage, MAX_INBOUND_IMAGE_BYTES } from "../../channel/channel-event.js";
import * as log from "../../log.js";
import { formatModelReference } from "../../models/reference.js";
import { formatLocalTime, localStampForFilename } from "../../shared/local-time.js";
import { errorMessage } from "../../shared/text-utils.js";
import { formatSize } from "../../tools/truncate.js";

export function shouldPreserveRawInput(text: string): boolean {
	return text.trim().startsWith("/");
}
/**
 * Save a message that exceeds the per-turn input budget so its clipped middle stays reachable.
 *
 * Pasting a long build log or diff is a normal way to start driving work here, and the clip
 * keeps head and tail — which is where the failing frames usually are *not*. Landing the
 * original under the channel directory puts it inside the paths `read` already allows, so
 * recovery is the ordinary paging path rather than a special case.
 *
 * Best-effort: if the write fails the turn still runs on the clipped text, just without a
 * pointer.
 */
export async function persistOversizedInput(
	deskDir: string,
	channelId: string,
	text: string,
): Promise<string | undefined> {
	try {
		const dir = join(deskDir, "inbox");
		await mkdir(dir, { recursive: true });
		const path = join(dir, `message-${localStampForFilename()}.txt`);
		await writeFile(path, text.replace(/\r/g, ""), { mode: 0o600 });
		return path;
	} catch (error) {
		log.logWarn("agent.input.persist_failed", "Oversized user message could not be saved", {
			channelId: channelId,
			reason: errorMessage(error),
		});
		return undefined;
	}
}
export function formatUserMessage(text: string, userName?: string, now: Date = new Date()): string {
	return `[${formatLocalTime(now)}] [${userName || "unknown"}]: ${text}`;
}
/**
 * Turn `InboundImage`s (already downloaded and persisted by the transport, spec 049) into the
 * `ImageContent[]` `AgentSession.prompt`/`steer` accept, plus any notices to surface to the
 * user about images that did not make it into this turn.
 *
 * Two gates apply, both fail *open* toward "still deliver the message" rather than dropping
 * the whole turn over one bad attachment:
 *
 * - The current model's `input` capability (spec 049 D7). A model that does not declare
 *   `"image"` support has its image blocks silently replaced with a text placeholder by the
 *   SDK's provider layer — exactly the failure this spec exists to fix, so it is checked
 *   explicitly here rather than trusted to fail loudly on its own. Re-checked on every call
 *   (including a mid-turn steer after a model fallback), since a fallback model's capability
 *   can differ from the one the turn started with.
 * - A defense-in-depth size re-check against `MAX_INBOUND_IMAGE_BYTES`. The transport already
 *   enforces this at download time, but the check is cheap and free of assumptions about how
 *   an `InboundImage` reached this method.
 *
 * An image already marked `unsupportedFormat` (sniffing failed at download time) is skipped
 * without its own notice — the `[图片N：格式不支持，已保存]` marker already in the message text
 * covers it.
 */
export interface PreparedInboundImages {
	images: ImageContent[];
	notices: string[];
}

export async function prepareInboundImages(
	images: InboundImage[] | undefined,
	model: Model<Api>,
): Promise<PreparedInboundImages> {
	if (!images || images.length === 0) {
		return { images: [], notices: [] };
	}

	if (!model.input.includes("image")) {
		const modelRef = formatModelReference(model);
		return {
			images: [],
			notices: [
				`⚠️ 当前模型 ${modelRef} 不支持图片输入，收到的图片已保存但未加入本轮上下文：\n` +
					images.map((image) => `- \`${image.path}\``).join("\n") +
					"\n用 `/model` 切换到支持图片的模型后，再让我读取这些图片。",
			],
		};
	}

	const contents: ImageContent[] = [];
	const notices: string[] = [];
	for (const image of images) {
		if (image.unsupportedFormat) continue;
		if (image.byteSize > MAX_INBOUND_IMAGE_BYTES) {
			notices.push(
				`⚠️ 图片 \`${image.path}\`（${formatSize(image.byteSize)}）超过 ${formatSize(MAX_INBOUND_IMAGE_BYTES)} 上限，未加入本轮上下文；需要时让我读取这个文件。`,
			);
			continue;
		}
		try {
			const data = await readFile(image.path);
			contents.push({ type: "image", data: data.toString("base64"), mimeType: image.mimeType });
		} catch (error) {
			notices.push(`⚠️ 图片 \`${image.path}\` 读取失败：${errorMessage(error)}`);
		}
	}
	return { images: contents, notices };
}
