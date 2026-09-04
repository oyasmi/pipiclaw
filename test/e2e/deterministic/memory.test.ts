import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDeterministicHarness, type DeterministicHarness, reply } from "../../support/runtime-harness.js";
import { waitForFileContent } from "../helpers/wait.js";

describe("E2E deterministic: memory (spec 050)", () => {
	let harness: DeterministicHarness;
	afterEach(async () => {
		harness.assertNoUnmatchedRequests();
		await harness.shutdown();
	});

	const lastUserContent = (): string => {
		const users = (harness.lastMainTurnRequest()?.messages ?? []).filter((m) => m.role === "user");
		return users.at(-1)?.content ?? "";
	};

	it("M1: memory_save writes a file; the index is injected on a new session's first turn only", async () => {
		harness = await createDeterministicHarness();
		harness.model.script.route({
			name: "ack",
			when: (r) => r.isMainTurn,
			respond: [reply.text("好的")],
			repeat: true,
		});
		harness.model.script.prependRoute({
			name: "save",
			when: (r) => r.isMainTurn && r.lastUserText.includes("记住"),
			respond: [
				reply.toolCall("memory_save", {
					content: "生产数据库端口是 6432",
					name: "prod-db-port",
					type: "reference",
				}),
				reply.text("好的，已记住。"),
			],
		});
		await harness.sendUserMessage("记住：生产库端口 6432。");

		const saved = await waitForFileContent(
			join(harness.channelDir, "memory", "prod-db-port.md"),
			(c) => c.includes("6432"),
			{ timeoutMs: 10_000, intervalMs: 100 },
		);
		expect(saved).toContain("type: reference");

		// New session: the index is injected on the first turn.
		await harness.sendUserMessage("/new");
		await harness.sendUserMessage("你好");
		expect(lastUserContent()).toContain("<memory_index>");
		expect(lastUserContent()).toContain("生产数据库端口是 6432");

		// Second turn of the same session: no bootstrap block.
		await harness.sendUserMessage("再聊一句");
		expect(lastUserContent()).not.toContain("<memory_bootstrap>");
	});

	it("M6: a v1-layout channel is migrated to v2 on first use", async () => {
		harness = await createDeterministicHarness();
		mkdirSync(harness.channelDir, { recursive: true });
		writeFileSync(
			join(harness.channelDir, "MEMORY.md"),
			"# Channel Memory\n\n## Preferences\n\n- User speaks Chinese, calls me Ki <!--id:m-aaaa1111-->\n",
			"utf-8",
		);
		harness.model.script.route({ name: "ack", when: (r) => r.isMainTurn, respond: [reply.text("好的")] });

		await harness.sendUserMessage("你好");

		expect(existsSync(join(harness.channelDir, "memory", ".migrated-v2"))).toBe(true);
		expect(existsSync(join(harness.channelDir, ".memory-v1", "MEMORY.md"))).toBe(true);
		const files = readdirSync(join(harness.channelDir, "memory")).filter((f) => f.endsWith(".md"));
		expect(files.length).toBe(1);
	});
});
