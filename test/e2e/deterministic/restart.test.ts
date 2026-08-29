import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { createDeterministicHarness, type DeterministicHarness, reply } from "../../support/runtime-harness.js";

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
		expect(existsSync(join(harness.channelDir, "SESSION.md"))).toBe(true);
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
		// secret-redaction (src/memory/secret-redaction.ts + files.ts guard). Mutation check:
		// drop redactSecrets() from sanitizeMessagesForMemory and the key lands in MEMORY.md
		// (the extraction route below actively tries to store it).
		const secret = "sk-live-AKQJ8f31PPqZ0mDeadBeef99";
		harness = await createDeterministicHarness();
		harness.model.script.route({
			name: "t",
			when: (r) => r.isMainTurn,
			respond: [reply.text("收到")],
			repeat: true,
		});
		harness.model.script.prependRoute({
			name: "extract-secret",
			when: (r) => !r.isMainTurn && r.systemPrompt.includes("durable memory extraction worker"),
			respond: [
				reply.json({
					memoryOps: [
						{
							op: "add",
							content: `部署密钥是 ${secret}`,
							kind: "fact",
							confidence: 0.99,
							necessity: "high",
							reason: "user shared it",
						},
					],
					discarded: [],
					historyBlock: "",
				}),
			],
			repeat: true,
		});

		await harness.sendUserMessage(`记一下部署密钥：${secret}`);
		await harness.sendUserMessage("好的谢谢");
		await harness.sendUserMessage("/new"); // consolidation

		for (const file of ["MEMORY.md", "SESSION.md", "HISTORY.md"]) {
			const path = join(harness.channelDir, file);
			if (existsSync(path)) {
				expect(readFileSync(path, "utf-8"), `${file} must not contain the raw secret`).not.toContain(secret);
			}
		}
	});
});
