import { describe, expect, it } from "vitest";
import { extensionForMimeType, parseInboundMessage, sniffImageMimeType } from "../src/runtime/inbound-media.js";

/**
 * spec 049: the 2026-08-30 incident's root cause lived entirely in the message-shape branching
 * this file tests. Two of the cases below (`richText` interleaving and the `picture` synthetic
 * marker) are exactly the two failure modes that produced "没有收到图片" for a real user —
 * `richText` silently dropped its image with no warning at all, `picture` was rejected outright
 * as an "empty message".
 */
describe("parseInboundMessage", () => {
	it("returns plain text unchanged with no image credentials", () => {
		expect(parseInboundMessage({ text: { content: "  hello  " } })).toEqual({
			text: "hello",
			downloadCodes: [],
		});
	});

	it("synthesizes a [图片1] marker for a text-less picture message", () => {
		// Mutation check: revert the synthetic-marker branch and this becomes { text: "",
		// downloadCodes: [...] } — the transport then drops the whole message as "empty".
		expect(parseInboundMessage({ msgtype: "picture", content: { downloadCode: "code-1" } })).toEqual({
			text: "[图片1]",
			downloadCodes: ["code-1"],
		});
	});

	it("drops a picture message with no downloadCode, same as any other empty message", () => {
		expect(parseInboundMessage({ msgtype: "picture", content: {} })).toEqual({ text: "", downloadCodes: [] });
	});

	it("interleaves text and image markers in richText payload order", () => {
		// Mutation check: append every marker after the joined text instead of interleaving, and
		// this collapses to "before after[图片1][图片2]" — the marker no longer sits where the
		// image the user is referring to ("this picture") was actually placed in the message.
		expect(
			parseInboundMessage({
				content: {
					richText: [
						{ text: "before " },
						{ downloadCode: "code-1" },
						{ text: " after " },
						{ downloadCode: "code-2" },
					],
				},
			}),
		).toEqual({
			text: "before [图片1] after [图片2]",
			downloadCodes: ["code-1", "code-2"],
		});
	});

	it("handles a richText message that is only images, no text at all", () => {
		expect(
			parseInboundMessage({
				content: { richText: [{ downloadCode: "code-1" }, { downloadCode: "code-2" }] },
			}),
		).toEqual({ text: "[图片1][图片2]", downloadCodes: ["code-1", "code-2"] });
	});

	it("drops a message with neither text nor image credentials", () => {
		// This is the one case the transport must still warn-and-discard — it must not regress
		// into a synthetic marker the way `picture`/`richText`-with-images legitimately do.
		expect(parseInboundMessage({ msgtype: "unknown" })).toEqual({ text: "", downloadCodes: [] });
		expect(parseInboundMessage({ content: { richText: [{ text: "" }] } })).toEqual({ text: "", downloadCodes: [] });
	});

	it("prefers text.content over a richText/picture fallback when both are present", () => {
		expect(
			parseInboundMessage({
				text: { content: "actual text" },
				content: { downloadCode: "code-1" },
			}),
		).toEqual({ text: "actual text", downloadCodes: [] });
	});
});

describe("sniffImageMimeType", () => {
	it("recognizes JPEG, PNG, GIF, and WebP by magic bytes", () => {
		expect(sniffImageMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
		expect(sniffImageMimeType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
		expect(sniffImageMimeType(Buffer.from("GIF89a"))).toBe("image/gif");
		expect(
			sniffImageMimeType(Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP")])),
		).toBe("image/webp");
	});

	it("trusts magic bytes, never a claimed content type — an arbitrary file is not sniffed as an image", () => {
		// This is the D8 guard: DingTalk's CDN Content-Type is never consulted by this function
		// at all, so there is nothing for a mislabeled or hostile upload to spoof.
		expect(sniffImageMimeType(Buffer.from("<html><body>not an image</body></html>"))).toBeNull();
		expect(sniffImageMimeType(Buffer.from([]))).toBeNull();
	});

	it("does not misidentify a short buffer as a match", () => {
		expect(sniffImageMimeType(Buffer.from([0xff, 0xd8]))).toBeNull();
		expect(sniffImageMimeType(Buffer.from("GIF8"))).toBeNull();
	});
});

describe("extensionForMimeType", () => {
	it("maps recognized types to their extension and falls back to .bin", () => {
		expect(extensionForMimeType("image/jpeg")).toBe("jpg");
		expect(extensionForMimeType("image/png")).toBe("png");
		expect(extensionForMimeType("image/gif")).toBe("gif");
		expect(extensionForMimeType("image/webp")).toBe("webp");
		expect(extensionForMimeType(null)).toBe("bin");
		expect(extensionForMimeType("application/octet-stream")).toBe("bin");
	});
});
