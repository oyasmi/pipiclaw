import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createDeterministicHarness,
	type DeterministicHarness,
	reply,
	writeWorkspaceFile,
} from "../../support/runtime-harness.js";
import { waitForFileContent } from "../helpers/wait.js";

function seedChannelMemory(harness: DeterministicHarness, section: string, ...bullets: string[]): void {
	mkdirSync(harness.channelDir, { recursive: true });
	writeFileSync(
		join(harness.channelDir, "MEMORY.md"),
		`# Channel Memory\n\n## ${section}\n\n${bullets.map((b) => `- ${b}`).join("\n")}\n`,
		"utf-8",
	);
}

describe("E2E deterministic: memory", () => {
	let harness: DeterministicHarness;
	afterEach(async () => {
		harness.assertNoUnmatchedRequests();
		await harness.shutdown();
	});

	it("A9: a turn that called a tool still writes a dictated fact to MEMORY.md", async () => {
		// Locks the 0.9.1 P0: any window that used a tool silently dropped memory
		// extraction. Mutation check: drop tool-call turns from the consolidation
		// input (sanitizeMessagesForMemory) and "6432" never reaches MEMORY.md.
		harness = await createDeterministicHarness();
		writeWorkspaceFile(harness, "notes.txt", "just some file content");

		harness.model.script.route({
			name: "read-then-answer",
			when: (r) => r.isMainTurn && r.lastUserText.includes("PORT_6432"),
			respond: [
				reply.toolCall("read", { path: join(harness.workspaceDir, "notes.txt") }),
				reply.text("已读取文件，并记住端口 6432。"),
			],
		});
		harness.model.script.prependRoute({
			name: "extract-port",
			when: (r) => !r.isMainTurn && r.systemPrompt.includes("durable memory extraction worker"),
			respond: [
				reply.json({
					memoryOps: [
						{
							op: "add",
							content: "生产数据库端口是 6432",
							kind: "fact",
							confidence: 0.95,
							necessity: "high",
							reason: "user explicitly asked to remember it",
						},
					],
					discarded: [],
					historyBlock: "",
				}),
			],
		});

		await harness.sendUserMessage("记住：生产库端口 PORT_6432。另外读一下 notes.txt。");
		await harness.sendUserMessage("/new"); // triggers background consolidation

		const memory = await waitForFileContent(join(harness.channelDir, "MEMORY.md"), (c) => c.includes("6432"), {
			timeoutMs: 20_000,
			intervalMs: 200,
		});
		expect(memory).toContain("生产数据库端口是 6432");
	});

	it("A10: recall injects a seeded memory only when the turn's query is relevant", async () => {
		harness = await createDeterministicHarness();
		seedChannelMemory(
			harness,
			"Durable Facts",
			"部署脚本是 scripts/deploy-prod.sh，运行前必须导出 ROLLBACK_TOKEN 环境变量",
		);

		harness.model.script.route({
			name: "any-turn",
			when: (r) => r.isMainTurn,
			respond: Array.from({ length: 6 }, () => reply.text("好的")),
		});

		// Recall is assembled into the *current* turn's user message (assembleTurnPrompt).
		// Older turns stay in the request as history, so assert on the last user message
		// only — otherwise turn 2's recalled block leaks into turn 3/4's history view.
		const currentTurnText = (): string => {
			const users = (harness.lastMainTurnRequest()?.messages ?? []).filter((m) => m.role === "user");
			return users.at(-1)?.content ?? "";
		};

		// Turn 1 consumes the first-turn bootstrap.
		await harness.sendUserMessage("你好");

		// Turn 2: query overlaps the seeded fact — recall should inject it into the turn.
		await harness.sendUserMessage("帮我回顾一下 deploy-prod.sh 部署脚本的步骤");
		expect(currentTurnText()).toContain("ROLLBACK_TOKEN");

		// Two unrelated turns so neither the query nor the previous-turn context
		// (recall's contextQuery) overlaps the seeded fact — it must not be recalled.
		await harness.sendUserMessage("你觉得今天适合去爬山吗");
		await harness.sendUserMessage("推荐一首轻音乐");
		expect(currentTurnText()).not.toContain("ROLLBACK_TOKEN");
	});
});
