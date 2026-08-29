import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import type { InboundImage } from "../../../src/channel/channel-event.js";
import { MAX_INBOUND_IMAGE_BYTES } from "../../../src/channel/channel-event.js";
import { createDeterministicHarness, type DeterministicHarness, reply } from "../../support/runtime-harness.js";
import { waitFor } from "../helpers/wait.js";

// Real JPEG magic bytes — enough for `prepareInboundImages` to read and base64-encode; the
// downstream mock model never actually decodes the picture.
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

function writeTestImage(channelDir: string, name: string, bytes: Buffer = JPEG_BYTES): InboundImage {
	const dir = join(channelDir, "inbox");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, name);
	writeFileSync(path, bytes);
	return { path, mimeType: "image/jpeg", byteSize: bytes.byteLength };
}

/** True if the request's last user message carries an OpenAI-completions `image_url` content part. */
function requestCarriesImage(raw: Record<string, unknown>): boolean {
	const messages = Array.isArray(raw.messages) ? (raw.messages as Array<Record<string, unknown>>) : [];
	const lastUser = [...messages].reverse().find((m) => m.role === "user");
	const content = lastUser?.content;
	return Array.isArray(content) && content.some((part) => (part as { type?: string })?.type === "image_url");
}

/**
 * spec 049: the runner-side half of the fix — images reaching (or correctly not reaching) the
 * model, gated on the resolved model's declared `input` capability. The transport-side download
 * and marker-substitution logic is covered separately in test/dingtalk.test.ts and
 * test/inbound-media.test.ts; here events are built with `images` already populated, exactly as
 * `onStreamMessage` would hand them to `routeInboundEvent` after a successful download.
 */
describe("E2E deterministic: inbound image attachments", () => {
	let harness: DeterministicHarness;
	afterEach(async () => {
		harness.assertNoUnmatchedRequests();
		await harness.shutdown();
	});

	it("a vision-capable model receives the image; the marker text reaches it unmodified", async () => {
		harness = await createDeterministicHarness({ visionModels: ["mock-main"] });
		harness.model.script.route({
			name: "vision-turn",
			when: (r) => r.isMainTurn,
			respond: [reply.text("图里是一只猫。")],
		});
		const image = writeTestImage(harness.channelDir, "photo.jpg");

		await harness.sendUserMessage("[图片1]", { images: [image] });

		const request = harness.lastMainTurnRequest();
		expect(request).toBeDefined();
		expect(request?.lastUserText).toContain("[图片1]");
		expect(requestCarriesImage(request!.raw)).toBe(true);
		// Mutation check: drop the D7 capability gate to "always pass images through" and this
		// still passes — the case that actually distinguishes the gate is the next test.
	});

	it("a text-only model never receives the image, and the user is told where it went instead", async () => {
		// Default deterministic models declare no `input` at all (text-only) — this is exactly
		// the 2026-08-30 incident's configuration.
		harness = await createDeterministicHarness();
		harness.model.script.route({
			name: "text-only-turn",
			when: (r) => r.isMainTurn,
			respond: [reply.text("师兄，这条消息里我没有收到图片。")],
		});
		const image = writeTestImage(harness.channelDir, "photo.jpg");

		await harness.sendUserMessage("[图片1]", { images: [image] });

		const request = harness.lastMainTurnRequest();
		expect(request).toBeDefined();
		// Mutation check: remove the D7 capability check in `prepareInboundImages` and this
		// flips to true — the exact silent-drop failure mode the spec exists to fix.
		expect(requestCarriesImage(request!.raw)).toBe(false);
		expect(
			harness.deliveries.some(
				(d) => (d.text ?? "").includes("不支持图片输入") && (d.text ?? "").includes(image.path),
			),
		).toBe(true);
	});

	it("an oversized image is excluded with a notice naming the size, without ever being read", async () => {
		harness = await createDeterministicHarness({ visionModels: ["mock-main"] });
		harness.model.script.route({
			name: "oversized-turn",
			when: (r) => r.isMainTurn,
			respond: [reply.text("ok")],
		});
		// The declared byteSize alone drives the size gate — a small file on disk with a lying
		// byteSize proves the check runs before any read, not after a slow decode.
		const image = writeTestImage(harness.channelDir, "huge.jpg");
		image.byteSize = MAX_INBOUND_IMAGE_BYTES + 1;

		await harness.sendUserMessage("[图片1]", { images: [image] });

		const request = harness.lastMainTurnRequest();
		expect(requestCarriesImage(request!.raw)).toBe(false);
		expect(harness.deliveries.some((d) => (d.text ?? "").includes("超过") && (d.text ?? "").includes("上限"))).toBe(
			true,
		);
	});

	it("images survive a busy-path steer without a queueing rejection", async () => {
		harness = await createDeterministicHarness({ visionModels: ["mock-main"], busyMessageDefault: "steer" });
		harness.model.script.route({
			name: "turn",
			when: (r) => r.isMainTurn,
			respond: [reply.text("continuing")],
			repeat: true,
		});
		const gate = harness.model.script.hold({ when: (r) => r.isMainTurn && r.lastUserText.includes("ORIGINAL") });

		await harness.sendUserMessageNoWait("开始 ORIGINAL 任务");
		await waitFor("turn 1 running", () => harness.mainTurnRequests().length >= 1, { intervalMs: 20 });

		const image = writeTestImage(harness.channelDir, "steer.jpg");
		await harness.sendUserMessageNoWait("这张图 STEER_IMG [图片1]", { images: [image] });

		gate.release();
		await harness.waitForIdle();

		// Mutation check: revert `handleBusyMessage`'s steer branch to drop `event.images` and the
		// second assertion below fails — the request lands but with no image_url part.
		expect(harness.deliveries.some((d) => (d.text ?? "").includes("无法排队"))).toBe(false);
		const steerRequest = harness.mainTurnRequests().find((r) => r.lastUserText.includes("STEER_IMG"));
		expect(steerRequest).toBeDefined();
		expect(requestCarriesImage(steerRequest!.raw)).toBe(true);
	});
});
