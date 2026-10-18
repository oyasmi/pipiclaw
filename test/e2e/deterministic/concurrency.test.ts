import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getActiveSessionRefPath } from "../../../src/channel/active-session-store.js";
import { createDeterministicHarness, type DeterministicHarness, reply } from "../../support/runtime-harness.js";

describe("E2E deterministic: concurrency & boundaries", () => {
	let harness: DeterministicHarness;
	afterEach(async () => {
		await harness.shutdown();
	});

	it("A4: messages that arrive mid-turn are serialized, not interleaved, and all answered", async () => {
		// Catches the per-channel queue starting a second model turn before its current turn ends.
		harness = await createDeterministicHarness();
		harness.model.script.route({
			name: "turn",
			when: (r) => r.isMainTurn,
			respond: [reply.text("ans-1"), reply.text("ans-2"), reply.text("ans-3")],
		});
		const gate = harness.model.script.hold({ when: (r) => r.isMainTurn && r.lastUserText.includes("MSG_ONE") });

		await harness.sendUserMessageNoWait("MSG_ONE");
		await gate.arrived;
		await harness.sendUserMessageNoWait("MSG_TWO");
		await harness.sendUserMessageNoWait("MSG_THREE");

		// While turn 1 is held at the provider, no later turn may have started.
		expect(harness.mainTurnRequests()).toHaveLength(1);
		expect(harness.model.unmatched()).toHaveLength(0);

		gate.release();
		await harness.waitForIdle();

		// All three turns ran, in arrival order, one at a time.
		const order = harness.mainTurnRequests().map((r) => r.lastUserText.match(/MSG_\w+/)?.[0]);
		expect(order).toEqual(["MSG_ONE", "MSG_TWO", "MSG_THREE"]);
		for (const marker of ["ans-1", "ans-2", "ans-3"]) {
			expect(harness.deliveries.some((d) => (d.text ?? "").includes(marker))).toBe(true);
		}
	});

	it("A7: /new is an atomic boundary — the next turn's request carries no prior history", async () => {
		// Catches a fresh session binding to the old persisted transcript after repeated idle /new.
		harness = await createDeterministicHarness();
		harness.model.script.route({
			name: "turn",
			when: (r) => r.isMainTurn,
			respond: Array.from({ length: 4 }, (_, i) => reply.text(`r${i}`)),
		});

		await harness.sendUserMessage("请记住暗号 MARKER_ALPHA_7788");
		expect(JSON.stringify(harness.lastMainTurnRequest()?.messages)).toContain("MARKER_ALPHA_7788");

		await harness.sendUserMessage("/new");
		await harness.sendUserMessage("/new"); // consecutive /new must not wedge

		await harness.sendUserMessage("现在说点别的");
		const afterNew = JSON.stringify(harness.lastMainTurnRequest()?.messages);
		expect(afterNew).not.toContain("MARKER_ALPHA_7788");
	});

	it("a held channel does not block another channel or leak its history into it", async () => {
		// Catches a process-wide turn queue or session cache reused across channel ids.
		// Mutation check: sharing the transport's channel queue across ids blocks the peer request.
		// Both channels share one dot (spec 058, D1): parallel turns and separate contexts must hold
		// even though their memory, tasks and files are shared.
		const otherChannel = "dm_isolated_peer";
		harness = await createDeterministicHarness({ extraChannels: [{ channelId: otherChannel }] });
		harness.model.script.route({
			name: "turn",
			when: (r) => r.isMainTurn,
			respond: [reply.text("ok")],
			repeat: true,
		});
		const held = harness.model.script.hold({ when: (r) => r.lastUserText.includes("CHANNEL_A_ONLY") });
		const peer = harness.model.script.hold({ when: (r) => r.lastUserText.includes("CHANNEL_B_ONLY") });
		try {
			await harness.sendUserMessageNoWait("CHANNEL_A_ONLY");
			await held.arrived;
			await harness.sendUserMessageNoWait("CHANNEL_B_ONLY", { channelId: otherChannel });
			const request = await peer.arrived;
			expect(JSON.stringify(request.messages)).not.toContain("CHANNEL_A_ONLY");
			peer.release();
			await harness.waitForDelivery((d) => d.channelId === otherChannel && d.method === "sendPlain");
			expect(harness.runtime.handler.isRunning(harness.channelId)).toBe(true);
			expect(
				harness.deliveries.filter((d) => d.channelId === harness.channelId && d.method === "sendPlain"),
			).toHaveLength(0);
		} finally {
			held.release();
			peer.release();
		}
		await harness.waitForIdle();
		const transcript = readFileSync(join(harness.dotDir, "conversations", "dm-2", "context.jsonl"), "utf8");
		expect(transcript).toContain("CHANNEL_B_ONLY");
		expect(transcript).not.toContain("CHANNEL_A_ONLY");
	});

	it("/new during a held turn discards the old queue and persists a clean session across restart", async () => {
		// Catches /new resetting the runner but keeping queued closures from the retired session.
		// Mutation check: making DingTalkBot.resetChannelQueue a no-op admits STALE_QUEUED.
		harness = await createDeterministicHarness();
		harness.model.script.route({
			name: "turn",
			when: (r) => r.isMainTurn,
			respond: [reply.text("ok")],
			repeat: true,
		});
		const gate = harness.model.script.hold({ when: (r) => r.lastUserText.includes("RETIRED_TURN") });
		await harness.sendUserMessageNoWait("RETIRED_TURN");
		await gate.arrived;
		await harness.sendUserMessageNoWait("STALE_QUEUED");
		try {
			await harness.sendUserMessageNoWait("/new");
		} finally {
			gate.release();
		}
		await harness.waitForIdle();
		const ref = JSON.parse(readFileSync(getActiveSessionRefPath(harness.conversationDir), "utf8"));
		await harness.restart();
		await harness.sendUserMessage("FRESH_TURN");
		const latest = harness.lastMainTurnRequest();
		expect(latest?.lastUserText).toContain("FRESH_TURN");
		expect(JSON.stringify(latest?.messages)).not.toMatch(/RETIRED_TURN|STALE_QUEUED/);
		expect(harness.mainTurnRequests().some((r) => r.lastUserText.includes("STALE_QUEUED"))).toBe(false);
		const persisted = readFileSync(join(harness.conversationDir, ref.file), "utf8");
		expect(persisted).toContain("FRESH_TURN");
		expect(persisted).not.toMatch(/RETIRED_TURN|STALE_QUEUED/);
	});
});
