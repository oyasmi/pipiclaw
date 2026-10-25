/**
 * Turning a request's `input` into what the runtime takes (spec 061, D15): one text with
 * `[图片N]` / `[文件N]` markers where attachments sit, and the attachments' bytes. The same
 * rules serve `response.create` and `response.steer`.
 *
 * Only data carried in the request is accepted. A `file_id` needs a Files API this server does
 * not have, and a URL would make the server fetch whatever a caller names (SSRF), so both are
 * refused. A base64 payload is measured before it is decoded.
 */
import { MAX_INBOUND_IMAGE_BYTES, MAX_INBOUND_IMAGES_PER_MESSAGE, sniffImageMimeType } from "../channel/attachments.js";
import type { InboundAttachment } from "../channel/ingress.js";
import type { ContextMessage, ContextPart } from "../channel/turn-context.js";
import { isPlainObject } from "../shared/type-guards.js";
import { badRequest } from "./errors.js";
import { newId } from "./ids.js";
import { MAX_INBOUND_FILE_BYTES } from "./limits.js";
import type { InputItem } from "./response-record.js";

export interface ParsedInput {
	context: ContextMessage[];
	/** The text the agent sees, with a marker at each attachment's place. */
	text: string;
	attachments: InboundAttachment[];
	/** What is recorded as the response's `input_items`: the shape of what was sent, without the bytes. */
	items: InputItem[];
}

type Part = import("openai/resources/responses/responses").ResponseInputContent;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const DATA_URL = /^data:([^,;]*)((?:;[^,;]*)*),(.*)$/s;

/** The bytes of a base64 payload (a `data:` URL, or bare base64 when `bare` allows it), measured before decoding. */
function decodeBase64(value: string, limit: number, param: string, what: string, bare: boolean): Buffer {
	let payload = value;
	const match = DATA_URL.exec(value);
	if (match) {
		if (!match[2].split(";").includes("base64")) {
			throw badRequest("invalid_value", `${what} must be base64 data.`, param);
		}
		payload = match[3];
	} else if (!bare) {
		throw badRequest("invalid_value", `${what} must be a base64 \`data:\` URL.`, param);
	}
	payload = payload.replace(/\s+/g, "");
	if (!BASE64.test(payload) || payload.length % 4 !== 0) {
		throw badRequest("invalid_value", `${what} is not valid base64.`, param);
	}
	const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
	if (Math.floor((payload.length * 3) / 4) - padding > limit) {
		throw badRequest("input_too_large", `${what} is larger than ${limit / (1024 * 1024)} MB.`, param);
	}
	return Buffer.from(payload, "base64");
}

function parseContent(content: unknown, itemParam: string, state: { images: number; files: number }) {
	const parts: Part[] = [];
	const attachments: InboundAttachment[] = [];
	let text = "";

	if (typeof content === "string") {
		return { parts: [{ type: "input_text", text: content } as Part], attachments, text: content };
	}
	if (!Array.isArray(content)) {
		throw badRequest("invalid_value", "`content` must be a string or an array of parts.", `${itemParam}.content`);
	}
	for (const [index, part] of content.entries()) {
		const param = `${itemParam}.content[${index}]`;
		if (!isPlainObject(part)) throw badRequest("invalid_value", "A content part must be an object.", param);
		switch (part.type) {
			case "output_text":
			case "input_text": {
				if (typeof part.text !== "string")
					throw badRequest("invalid_value", "`text` must be a string.", `${param}.text`);
				parts.push({ type: "input_text", text: part.text });
				text += part.text;
				break;
			}
			case "input_image": {
				if (part.file_id !== undefined && part.file_id !== null) {
					throw badRequest(
						"unsupported_parameter",
						"`file_id` is not supported: send the image as a base64 `data:` URL.",
						`${param}.file_id`,
					);
				}
				if (typeof part.image_url !== "string") {
					throw badRequest(
						"missing_required_parameter",
						"`image_url` is required (a base64 `data:` URL).",
						`${param}.image_url`,
					);
				}
				if (!part.image_url.startsWith("data:")) {
					throw badRequest(
						"unsupported_value",
						"Image URLs are not fetched: send the image as a base64 `data:` URL.",
						`${param}.image_url`,
					);
				}
				if (state.images >= MAX_INBOUND_IMAGES_PER_MESSAGE) {
					throw badRequest(
						"input_too_large",
						`A message carries at most ${MAX_INBOUND_IMAGES_PER_MESSAGE} images.`,
						param,
					);
				}
				const data = decodeBase64(
					part.image_url,
					MAX_INBOUND_IMAGE_BYTES,
					`${param}.image_url`,
					"The image",
					false,
				);
				state.images++;
				attachments.push({ kind: "image", index: state.images, data });
				parts.push({ type: "input_image", detail: "auto" });
				text += `[图片${state.images}]`;
				break;
			}
			case "input_file": {
				if (part.file_id !== undefined || part.file_url !== undefined) {
					throw badRequest(
						"unsupported_parameter",
						"`file_id` and `file_url` are not supported: send `file_data`.",
						param,
					);
				}
				if (typeof part.file_data !== "string" || typeof part.filename !== "string" || !part.filename.trim()) {
					throw badRequest("missing_required_parameter", "`file_data` and `filename` are required.", param);
				}
				const data = decodeBase64(part.file_data, MAX_INBOUND_FILE_BYTES, `${param}.file_data`, "The file", true);
				state.files++;
				attachments.push({ kind: "file", index: state.files, data, fileName: part.filename });
				parts.push({ type: "input_file", filename: part.filename });
				text += `[文件${state.files}]`;
				break;
			}
			default:
				throw badRequest(
					"unsupported_value",
					"Only `input_text`, `input_image` and `input_file` parts are supported.",
					`${param}.type`,
				);
		}
	}
	return { parts, attachments, text };
}

/** Normalize replayable output items as historical observations, never tool invocations. */
function replayMessage(entry: Record<string, unknown>, param: string): Record<string, unknown> {
	if (entry.type === "reasoning") {
		if (entry.encrypted_content !== undefined && entry.encrypted_content !== null)
			throw badRequest(
				"unsupported_parameter",
				"Encrypted reasoning cannot be replayed here; send message history or use `previous_response_id`.",
				`${param}.encrypted_content`,
			);
		if (
			!Array.isArray(entry.summary) ||
			entry.summary.some((p) => !isPlainObject(p) || p.type !== "summary_text" || typeof p.text !== "string")
		)
			throw badRequest("invalid_value", "Send reasoning summaries as summary_text parts.", param);
		return {
			role: "assistant",
			phase: "commentary",
			content: entry.summary.map((p) => ({ type: "input_text", text: (p as Record<string, unknown>).text })),
		};
	}
	if (entry.type === "mcp_call" && entry.server_label === "pipiclaw") {
		if (
			typeof entry.name !== "string" ||
			typeof entry.arguments !== "string" ||
			!(entry.output === null || typeof entry.output === "string")
		)
			throw badRequest("invalid_value", "Replay the complete mcp_call item returned by Pipiclaw.", param);
		return {
			role: "assistant",
			phase: "commentary",
			content: JSON.stringify({
				historical_tool: entry.name,
				arguments: entry.arguments,
				output: entry.output,
				error: entry.error,
			}),
		};
	}
	return entry;
}

export function parseInput(input: unknown, param = "input"): ParsedInput {
	if (typeof input !== "string" && !Array.isArray(input))
		throw badRequest("invalid_value", "`input` must be a string or an array of messages.", param);
	const entries: unknown[] = typeof input === "string" ? [{ role: "user", content: input }] : input;
	if (entries.length === 0) throw badRequest("invalid_value", "`input` must not be empty.", param);
	const items: InputItem[] = [];
	const attachments: InboundAttachment[] = [];
	const context: ContextMessage[] = [];
	const texts: string[] = [];
	const state = { images: 0, files: 0 };
	for (const [index, value] of entries.entries()) {
		const itemParam = typeof input === "string" ? param : `${param}[${index}]`;
		if (!isPlainObject(value)) throw badRequest("invalid_value", "An input item must be an object.", itemParam);
		const entry = replayMessage(value, itemParam);
		if (entry.type !== undefined && entry.type !== "message")
			throw badRequest(
				"unsupported_value",
				"Send message items or replay Pipiclaw's response output; client-side tool execution is not supported.",
				`${itemParam}.type`,
			);
		const role = entry.role;
		if (role !== "user" && role !== "assistant" && role !== "system" && role !== "developer")
			throw badRequest(
				"unsupported_value",
				"`role` must be user, assistant, system, or developer.",
				`${itemParam}.role`,
			);
		if (entry.phase !== undefined && entry.phase !== "commentary" && entry.phase !== "final_answer")
			throw badRequest("invalid_value", "`phase` must be commentary or final_answer.", `${itemParam}.phase`);
		if (
			role !== "user" &&
			Array.isArray(entry.content) &&
			entry.content.some((p) => isPlainObject(p) && p.type !== "input_text" && p.type !== "output_text")
		)
			throw badRequest(
				"unsupported_value",
				"Non-user messages support text content only; attach files and images to a user message.",
				`${itemParam}.content`,
			);
		const parsed = parseContent(entry.content, itemParam, state);
		attachments.push(...parsed.attachments);
		texts.push(parsed.text);
		let attachmentIndex = 0;
		const parts: ContextPart[] = parsed.parts.flatMap((p): ContextPart[] => {
			if (p.type === "input_text") return [{ type: "text", text: p.text }];
			const attachment = parsed.attachments[attachmentIndex++];
			if (!attachment) return [];
			if (attachment.kind === "image")
				return [
					{
						type: "image",
						data: attachment.data.toString("base64"),
						mimeType: sniffImageMimeType(attachment.data) ?? "image/png",
					},
				];
			return [{ type: "text", text: `[File: ${attachment.fileName}]\n${attachment.data.toString("utf8")}` }];
		});
		context.push({
			role,
			content: parts,
			...(entry.phase ? { phase: entry.phase as "commentary" | "final_answer" } : {}),
		});
		items.push(
			role === "assistant"
				? {
						id: newId("msg"),
						type: "message",
						role,
						status: "completed",
						...(entry.phase ? { phase: entry.phase as "commentary" | "final_answer" } : {}),
						content: parsed.parts.flatMap((p) =>
							p.type === "input_text" ? [{ type: "output_text" as const, text: p.text, annotations: [] }] : [],
						),
					}
				: { id: newId("msg"), type: "message", role, status: "completed", content: parsed.parts },
		);
	}
	const text = texts.join("\n");
	if (!text.trim() && attachments.length === 0) throw badRequest("invalid_value", "`input` is empty.", param);
	return { text, attachments, items, context };
}
