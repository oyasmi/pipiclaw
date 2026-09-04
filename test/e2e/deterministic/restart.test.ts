import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { createDeterministicHarness, type DeterministicHarness, reply } from "../../support/runtime-harness.js";
import { waitFor } from "../helpers/wait.js";

describe("E2E deterministic: restart & persistence", () => {
	let harness: DeterministicHarness;
	afterEach(async () => {
		harness.assertNoUnmatchedRequests();
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
		// Spec 050: the channel is on the v2 memory layout (SESSION.md is retired).
		expect(existsSync(join(harness.channelDir, "memory", ".migrated-v2"))).toBe(true);
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

	it("A11: a conversation secret never reaches a durable memory file", async () => {
		// secret-redaction (src/memory/secret-redaction.ts + store.ts guard). Mutation check:
		// drop redactSecrets() from sanitizeMessagesForMemory and the key lands in memory/
		// (the reflect route below actively tries to store it).
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

		await harness.sendUserMessage(`记一下部署密钥：${secret}`);
		await harness.sendUserMessage("好的谢谢");
		await harness.sendUserMessage("/new"); // triggers the boundary reflect pass, which runs in the background

		// The /new-triggered reflect runs detached in the background (spec 050, D7); it is not
		// awaited by sendUserMessage, so wait for the mock provider to actually see the call.
		await waitFor(
			"the boundary reflect pass to reach the mock provider",
			() => harness.model.requests.some((r) => r.matchedRoute === "reflect-secret"),
			{ timeoutMs: 10_000, intervalMs: 200 },
		);

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
