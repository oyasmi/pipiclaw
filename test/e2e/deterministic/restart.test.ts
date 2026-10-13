import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { getDefaultChannelMemoryQueue } from "../../../src/memory/channel-maintenance-queue.js";
import { createDeterministicHarness, type DeterministicHarness, reply } from "../../support/runtime-harness.js";

describe("E2E deterministic: restart & persistence", () => {
	let harness: DeterministicHarness;
	afterEach(async () => {
		await harness.shutdown();
	});

	it("A12: a daemon restart resumes the same session file and keeps channel memory", async () => {
		// Mutation check: point resolveActiveSessionFile at a fresh name instead of the
		// existing context.jsonl and the post-restart turn branches from root — its
		// entry's parentId no longer chains onto the pre-restart assistant message.
		harness = await createDeterministicHarness();
		harness.model.script.route({ name: "t", when: (r) => r.isMainTurn, respond: [reply.text("好的")], repeat: true });

		await harness.sendUserMessage("请记住暗号 MARKER_XYZ_4242");
		const sessionFile = join(harness.channelDir, "context.jsonl");
		const before = readFileSync(sessionFile, "utf-8").trim().split("\n");
		const sessionId = JSON.parse(before[0]).id as string;
		const lastPreRestartId = JSON.parse(before.at(-1)!).id as string;

		await harness.restart();
		await harness.sendUserMessage("继续");

		const after = readFileSync(sessionFile, "utf-8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		// Same session (header id unchanged), appended to — not replaced.
		expect(after[0].id).toBe(sessionId);
		expect(after.length).toBeGreaterThan(before.length);
		expect(readFileSync(sessionFile, "utf-8")).toContain("MARKER_XYZ_4242");
		// The post-restart turn branches onto the pre-restart head, not root.
		expect(after.slice(before.length)[0].parentId).toBe(lastPreRestartId);
	});

	it("A11: a conversation secret is redacted before reflection and rejected by durable memory", async () => {
		// Catches secrets leaking in the reflect provider request, even when the store separately
		// rejects the returned secret. Mutation: bypass transcript redaction; provider assertion fails.
		const secret = "sk-live-AKQJ8f31PPqZ0mDeadBeef99";
		harness = await createDeterministicHarness();
		harness.model.script.route({
			name: "t",
			when: (r) => r.isMainTurn,
			respond: [reply.text("收到")],
			repeat: true,
		});
		harness.model.script.prependRoute({
			name: "reflect-secret",
			when: (r) => !r.isMainTurn && r.systemPrompt.includes("memory reflection worker"),
			respond: [
				reply.json({
					journal: [],
					ops: [
						{
							op: "add",
							type: "reference",
							description: `部署密钥是 ${secret}`,
							confidence: 0.99,
							necessity: "high",
							reason: "user shared it",
						},
					],
					discarded: [],
				}),
			],
			repeat: true,
		});

		const gate = harness.model.script.hold({
			when: (r) => !r.isMainTurn && r.systemPrompt.includes("memory reflection worker"),
		});
		await harness.sendUserMessage(`记一下部署密钥：${secret}`);
		await harness.sendUserMessage("好的谢谢");
		await harness.sendUserMessage("/new");
		try {
			const request = await gate.arrived;
			expect(JSON.stringify(request.messages)).not.toContain(secret);
		} finally {
			gate.release();
		}
		// Drain the actual channel maintenance queue: provider arrival alone precedes persistence.
		await getDefaultChannelMemoryQueue().run(harness.channelId, async () => {});

		expect(readFileSync(join(harness.channelDir, "MEMORY.md"), "utf-8")).not.toContain(secret);
		const memoryDir = join(harness.channelDir, "memory");
		if (existsSync(memoryDir)) {
			for (const file of readdirSync(memoryDir)) {
				expect(
					readFileSync(join(memoryDir, file), "utf-8"),
					`${file} must not contain the raw secret`,
				).not.toContain(secret);
			}
		}
	});
});
