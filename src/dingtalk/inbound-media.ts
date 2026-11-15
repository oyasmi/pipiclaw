/**
 * Pure parsing of DingTalk inbound messages and attachments (spec 049 + audio/file/reply).
 *
 * Kept separate from `dingtalk.ts` — which owns the network calls (`downloadMessageFile`) and
 * the per-channel serialization of the download — so the message-shape parsing rules can be unit tested without a `DingTalkBot` instance or any I/O.
 */
export interface InboundQuotedMessage {
	msgType?: string;
	content?: {
		text?: string;
		title?: string;
		recognition?: string;
		fileName?: string;
		richText?: Array<Record<string, string>>;
	};
}

/** Structural subset of the raw DingTalk callback payload this module reads. */
export interface InboundMessagePayload {
	msgtype?: string;
	text?: {
		content?: string;
		isReplyMsg?: boolean;
		repliedMsg?: InboundQuotedMessage;
	};
	repliedMsg?: InboundQuotedMessage;
	content?: {
		richText?: Array<Record<string, string>>;
		/** Present on `picture`, `file` and `audio` messages; the credential `robot/messageFiles/download` needs. */
		downloadCode?: string;
		/** Present on `audio` messages when DingTalk Stream ASR transcribed the voice clip. */
		recognition?: string;
		audioType?: string;
		/** Present on `file` messages. */
		fileName?: string;
	};
}

export interface InboundFileDescriptor {
	downloadCode: string;
	fileName: string;
}

export interface ParsedInboundMessage {
	/**
	 * User text with `[图片N]` / `[文件N]` markers inserted, `[语音转写]` for ASR audio, and optional
	 * `[引用消息：...]` prefix when replying to an earlier message. Empty when the message carries
	 * neither text nor an attachment — the caller drops or hints on that case.
	 */
	text: string;
	/** In the same order as the `[图片N]` markers in `text`, one entry per image. */
	downloadCodes: string[];
	/** In the same order as the `[文件N]` markers in `text`; omitted when empty. */
	files?: InboundFileDescriptor[];
}

/** Mirrors `MEDIA_UPLOAD_TIMEOUT_MS`: a multi-MB download over a slow link needs more than the
 *  15s default HTTP timeout. */
export const MEDIA_DOWNLOAD_TIMEOUT_MS = 60_000;

const MAX_QUOTED_CHARS = 300;

function extractQuotedSummary(replied: InboundQuotedMessage | undefined): string {
	if (!replied?.content) return "";
	const { content, msgType } = replied;
	if (typeof content.text === "string" && content.text.trim()) {
		return content.text.trim();
	}
	if (Array.isArray(content.richText)) {
		const rich = content.richText
			.map((item) => item.text || (item.downloadCode ? "[图片]" : ""))
			.join("")
			.trim();
		if (rich) return rich;
	}
	if (typeof content.recognition === "string" && content.recognition.trim()) {
		return `[语音转写] ${content.recognition.trim()}`;
	}
	if (typeof content.title === "string" && content.title.trim()) {
		return content.title.trim();
	}
	if (typeof content.fileName === "string" && content.fileName.trim()) {
		return `[文件: ${content.fileName.trim()}]`;
	}
	if (msgType === "picture") return "[图片]";
	return "";
}

function withReplyContext(body: string, data: InboundMessagePayload): string {
	if (!body) return "";
	const rawQuote = extractQuotedSummary(data.text?.repliedMsg ?? data.repliedMsg);
	if (!rawQuote) return body;
	const normalized = rawQuote.replace(/\s+/g, " ").trim();
	const clipped = normalized.length > MAX_QUOTED_CHARS ? `${normalized.slice(0, MAX_QUOTED_CHARS)}…` : normalized;
	return `[引用消息：${clipped}]\n${body}`;
}

/**
 * Parse one raw DingTalk callback payload into text + ordered attachment credentials.
 *
 * - `text` messages: text content (with `[引用消息：...]` when replying to a prior message).
 * - `audio` messages: uses DingTalk's built-in `content.recognition` ASR transcript when present;
 *   falls back to downloading the voice file via `downloadCode` when ASR is empty.
 * - `file` messages: synthetic `[文件1]` marker + `{ downloadCode, fileName }` descriptor.
 * - `picture` messages: synthetic `[图片1]` marker + `downloadCode`.
 * - `richText` messages: text and image credentials interleave in payload order.
 */
export function parseInboundMessage(data: InboundMessagePayload): ParsedInboundMessage {
	const textContent = (data.text?.content || "").trim();
	if (textContent) {
		return { text: withReplyContext(textContent, data), downloadCodes: [] };
	}

	if (data.msgtype === "audio") {
		const recognition = data.content?.recognition?.trim();
		if (recognition) {
			return { text: withReplyContext(`[语音转写] ${recognition}`, data), downloadCodes: [] };
		}
		if (data.content?.downloadCode) {
			const ext = (data.content.audioType || "amr").replace(/[^a-z0-9]/gi, "").toLowerCase() || "amr";
			return {
				text: withReplyContext("[文件1]", data),
				downloadCodes: [],
				files: [{ downloadCode: data.content.downloadCode, fileName: `voice.${ext}` }],
			};
		}
	}

	if (data.msgtype === "file" && data.content?.downloadCode) {
		const fileName = data.content.fileName?.trim() || "attachment.bin";
		return {
			text: withReplyContext("[文件1]", data),
			downloadCodes: [],
			files: [{ downloadCode: data.content.downloadCode, fileName }],
		};
	}

	if (data.msgtype === "picture" && data.content?.downloadCode) {
		return { text: withReplyContext("[图片1]", data), downloadCodes: [data.content.downloadCode] };
	}

	if (data.content?.richText) {
		const parts: string[] = [];
		const downloadCodes: string[] = [];
		for (const item of data.content.richText) {
			if (item.text) {
				parts.push(item.text);
			} else if (item.downloadCode) {
				downloadCodes.push(item.downloadCode);
				parts.push(`[图片${downloadCodes.length}]`);
			}
		}
		const joined = parts.join("").trim();
		if (joined) {
			return { text: withReplyContext(joined, data), downloadCodes };
		}
	}

	return { text: "", downloadCodes: [] };
}
