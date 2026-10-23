import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InboundImage } from "../../../src/channel/channel-event.js";
import { MAX_INBOUND_IMAGE_BYTES } from "../../../src/channel/channel-event.js";
import type { DingTalkBot } from "../../../src/dingtalk/bot.js";
import type { InboundMessages } from "../../../src/dingtalk/inbound.js";
import { createDeterministicHarness, type DeterministicHarness, reply } from "../../support/runtime-harness.js";

// Valid 1x1 PNG: the SDK now decodes attachments before sending them.
const PNG_BYTES = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
	"base64",
);

function writeTestImage(deskDir: string, name: string, bytes: Buffer = PNG_BYTES): InboundImage {
	const dir = join(deskDir, "inbox");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, name);
	writeFileSync(path, bytes);
	return { path, mimeType: "image/png", byteSize: bytes.byteLength };
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
		vi.restoreAllMocks();
		await harness.shutdown();
	});

	it("a vision-capable model receives the image; the marker text reaches it unmodified", async () => {
		harness = await createDeterministicHarness({ visionModels: ["mock-main"] });
		harness.model.script.route({
			name: "vision-turn",
			when: (r) => r.isMainTurn,
			respond: [reply.text("图里是一只猫。")],
		});
		// First contact is an image: the default binding must exist before media persistence,
		// not just when the resulting event reaches routeInboundEvent.
		// Mutation (2026-10-23): remove prepareChannel in inbound.ts; the image part is lost.
		const bot = (harness.runtime as typeof harness.runtime & { bot: DingTalkBot }).bot as unknown as {
			inbound: InboundMessages;
			downloadMessageFile(code: string): Promise<{ data: Buffer }>;
		};
		vi.spyOn(bot, "downloadMessageFile").mockResolvedValue({ data: PNG_BYTES });
		await bot.inbound.onStreamMessage({
			senderStaffId: "new-image-user",
			conversationType: "1",
			msgtype: "picture",
			content: { downloadCode: "offline-image" },
		});
		await harness.waitForIdle();
		expect(harness.runtime.desks.boundDesk("dm_new-image-user")).toBe("default");
		expect(existsSync(join(harness.workspaceDir, "desk-default", "inbox"))).toBe(true);

		const request = harness.lastMainTurnRequest();
		expect(request).toBeDefined();
		expect(request?.lastUserText).toContain("[图片1]");
		expect(requestCarriesImage(request!.raw)).toBe(true);
		// Catches runner/provider serialization discarding a supported attachment's image part.
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
		const image = writeTestImage(harness.deskDir, "photo.png");

		await harness.sendUserMessage("[图片1]", { images: [image] });

		const request = harness.lastMainTurnRequest();
		expect(request).toBeDefined();
		// Mutation check: remove the D7 capability check in `prepareInboundImages` and this
		// flips to true — the exact silent-drop failure mode the spec exists to fix.
		expect(requestCarriesImage(request!.raw)).toBe(false);
		expect(harness.deliveries.some((d) => d.method === "sendPlain" && (d.text ?? "").includes(image.path))).toBe(
			true,
		);
	});

	it("an image with oversized declared bytes is excluded and its saved path is reported", async () => {
		harness = await createDeterministicHarness({ visionModels: ["mock-main"] });
		harness.model.script.route({
			name: "oversized-turn",
			when: (r) => r.isMainTurn,
			respond: [reply.text("ok")],
		});
		// Catches accepting oversized declared metadata because the actual file happens to be small.
		const image = writeTestImage(harness.deskDir, "huge.png");
		image.byteSize = MAX_INBOUND_IMAGE_BYTES + 1;

		await harness.sendUserMessage("[图片1]", { images: [image] });

		const request = harness.lastMainTurnRequest();
		expect(requestCarriesImage(request!.raw)).toBe(false);
		expect(harness.deliveries.some((d) => d.method === "sendPlain" && (d.text ?? "").includes(image.path))).toBe(
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
		await gate.arrived;

		const image = writeTestImage(harness.deskDir, "steer.png");
		await harness.sendUserMessageNoWait("这张图 STEER_IMG [图片1]", { images: [image] });

		gate.release();
		await harness.waitForIdle();

		// Mutation check: revert `handleBusyMessage`'s steer branch to drop `event.images` and the
		// second assertion below fails — the request lands but with no image_url part.
		const steerRequest = harness.mainTurnRequests().find((r) => r.lastUserText.includes("STEER_IMG"));
		expect(steerRequest).toBeDefined();
		expect(requestCarriesImage(steerRequest!.raw)).toBe(true);
	});
});
