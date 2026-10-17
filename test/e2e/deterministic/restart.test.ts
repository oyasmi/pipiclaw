import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { getDotMemoryQueue } from "../../../src/memory/dot-memory-queue.js";
import {
	createDeterministicHarness,
	type DeterministicHarness,
	reply,
	seedLegacySession,
} from "../../support/runtime-harness.js";

describe("E2E deterministic: restart & persistence", () => {
	let harness: DeterministicHarness;
	afterEach(async () => {
		await harness.shutdown();
	});

	it("A12: a daemon restart resumes the same session file and keeps channel memory", async () => {
		// Mutation check: point resolveActiveSessionFile at a fresh name instead of the
		// existing context.jsonl and the post-restart turn branches from root — its
		// entry's parentId no longer chains onto the pre-restart assistant message.
		harness = await createDeterministicHarness({
			seed: ({ dotDir, conversationDir }) => {
				seedLegacySession("branch", join(conversationDir, "context.jsonl"), dotDir);
			},
		});
		harness.model.script.route({ name: "t", when: (r) => r.isMainTurn, respond: [reply.text("好的")], repeat: true });

		await harness.sendUserMessage("请记住暗号 MARKER_XYZ_4242");
		const request = harness.lastMainTurnRequest();
		expect(request?.model).toBe("mock-main");
		expect(request?.tools).toContain("read");
		const history = JSON.stringify(request?.messages);
		expect(history).toContain("FIXTURE_SUMMARY");
		expect(history).toContain("KEPT_HISTORY");
		expect(history).toContain("BRANCH_ANSWER");
		expect(history).not.toContain("DISCARDED_ANSWER");
		const sessionFile = join(harness.conversationDir, "context.jsonl");
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

		// Consume old interrupted/Azure histories through the host, with explicit current configuration.
		await harness.shutdown();
		for (const name of ["fork", "interrupted", "azure"]) {
			harness = await createDeterministicHarness({
				seed: ({ dotDir, conversationDir, homeDir }) => {
					seedLegacySession(name, join(conversationDir, "context.jsonl"), dotDir);
					if (name === "azure") {
						const modelsPath = join(homeDir, "models.json");
						const models = JSON.parse(readFileSync(modelsPath, "utf8"));
						const provider = models.providers["e2e-mock"];
						provider.models = [
							{
								id: "fixture-deployment",
								name: "fixture-deployment",
								reasoning: true,
								contextWindow: 200000,
								maxTokens: 8192,
							},
						];
						provider.compat.supportsReasoningEffort = true;
						models.providers = { azure: provider };
						writeFileSync(modelsPath, JSON.stringify(models));
						writeFileSync(
							join(homeDir, "settings.json"),
							JSON.stringify({
								defaultProvider: "azure",
								defaultModel: "fixture-deployment",
								retry: { enabled: false },
							}),
						);
					}
				},
			});
			harness.model.script.route({
				name: "legacy",
				when: (request) => request.isMainTurn,
				respond: [reply.text("ok")],
			});
			expect(harness.modelRequestCount()).toBe(0); // No automatic retry of a historical failure.
			await harness.sendUserMessage("LEGACY_CONTINUE");
			expect(harness.mainTurnRequests()).toHaveLength(1);
			const legacy = harness.lastMainTurnRequest()!;
			expect(legacy.tools).toContain("read");
			expect(JSON.stringify(legacy.messages)).toContain(name === "fork" ? "FIXTURE_SUMMARY" : "OLD_HISTORY");
			if (name === "fork")
				expect(
					JSON.parse(readFileSync(join(harness.conversationDir, "context.jsonl"), "utf8").split("\n")[0]!)
						.parentSession,
				).toBe("/fixture/branch.jsonl");
			if (name === "azure") {
				expect(legacy.model).toBe("fixture-deployment");
				expect(legacy.raw.reasoning_effort).toBe("medium");
			}
			const entries = readFileSync(join(harness.conversationDir, "context.jsonl"), "utf8");
			if (name === "interrupted") expect(entries).toContain("INTERRUPTED_INPUT");
			else if (name === "azure") expect(entries).toContain('"provider":"azure-openai-responses"');
			if (name !== "azure") await harness.shutdown();
		}
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
		await getDotMemoryQueue().run(harness, async () => {});

		expect(readFileSync(join(harness.dotDir, "MEMORY.md"), "utf-8")).not.toContain(secret);
		const memoryDir = join(harness.dotDir, "memory");
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
