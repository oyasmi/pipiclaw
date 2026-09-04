import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

	it("M3: the boundary reflect pass writes memory + journal and does not reprocess an empty window", async () => {
		harness = await createDeterministicHarness();
		harness.model.script.route({
			name: "ack",
			when: (r) => r.isMainTurn,
			respond: [reply.text("好的")],
			repeat: true,
		});
		harness.model.script.prependRoute({
			name: "reflect-once",
			when: (r) => !r.isMainTurn && r.systemPrompt.includes("memory reflection worker"),
			respond: [
				reply.json({
					journal: ["01:00 完成一次部署"],
					ops: [
						{
							op: "add",
							type: "project",
							description: "部署脚本是 scripts/deploy.sh",
							confidence: 0.95,
							necessity: "high",
							reason: "user stated it",
						},
					],
					discarded: [],
				}),
			],
			repeat: true,
		});

		await harness.sendUserMessage("部署脚本在哪？");
		await harness.sendUserMessage("/new"); // boundary reflect, runs detached in the background

		const indexPath = join(harness.channelDir, "MEMORY.md");
		await waitForFileContent(indexPath, (c) => c.includes("部署脚本是 scripts/deploy.sh"), {
			timeoutMs: 10_000,
			intervalMs: 100,
		});
		const today = new Date().toISOString().slice(0, 10);
		const journalPath = join(harness.channelDir, "journal", `${today}.md`);
		const journal = await waitForFileContent(journalPath, (c) => c.includes("完成一次部署"), {
			timeoutMs: 10_000,
			intervalMs: 100,
		});
		expect(journal).toContain("01:00 完成一次部署");
		expect(readdirSync(join(harness.channelDir, "memory")).filter((f) => f.endsWith(".md"))).toHaveLength(1);

		// A second /new with nothing said in between reflects on an empty window — no new call.
		await harness.sendUserMessage("/new");
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(harness.model.requests.filter((r) => r.matchedRoute === "reflect-once")).toHaveLength(1);
	});

	it("M4: a source:user memory survives a reflect delete attempt, logged as skipped", async () => {
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
					content: "生产密钥保管在保险柜",
					name: "prod-key-location",
					type: "project",
				}),
				reply.text("已记住。"),
			],
		});
		harness.model.script.prependRoute({
			name: "reflect-delete-user-entry",
			when: (r) => !r.isMainTurn && r.systemPrompt.includes("memory reflection worker"),
			respond: [
				reply.json({
					journal: [],
					ops: [{ op: "delete", name: "prod-key-location", confidence: 0.99, reason: "seems outdated" }],
					discarded: [],
				}),
			],
			repeat: true,
		});

		await harness.sendUserMessage("记住：生产密钥保管在保险柜。");
		await waitForFileContent(join(harness.channelDir, "memory", "prod-key-location.md"), () => true, {
			timeoutMs: 10_000,
			intervalMs: 100,
		});

		await harness.sendUserMessage("/new");
		const reviewLogPath = join(harness.channelDir, "memory-review.jsonl");
		await waitForFileContent(
			reviewLogPath,
			(c) => c.includes("prod-key-location") && c.includes("cannot be auto-deleted"),
			{ timeoutMs: 10_000, intervalMs: 100 },
		);

		expect(existsSync(join(harness.channelDir, "memory", "prod-key-location.md"))).toBe(true);
	});

	it("M8: touch clears probation; an untouched, already-expired entry is deleted before the next reflect", async () => {
		harness = await createDeterministicHarness();
		harness.model.script.route({
			name: "ack",
			when: (r) => r.isMainTurn,
			respond: [reply.text("好的")],
			repeat: true,
		});

		// First turn establishes the channel (and its migration) before we hand-seed entries.
		await harness.sendUserMessage("你好");

		const memoryDir = join(harness.channelDir, "memory");
		mkdirSync(memoryDir, { recursive: true });
		const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
		const farFuture = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
		writeFileSync(
			join(memoryDir, "still-probationary.md"),
			`---\nname: still-probationary\ndescription: touched probationary fact\ntype: project\nsource: agent\ncreated: 2026-01-01\nupdated: 2026-01-01\nexpires: ${farFuture}\n---\n`,
			"utf-8",
		);
		writeFileSync(
			join(memoryDir, "already-expired.md"),
			`---\nname: already-expired\ndescription: expired probationary fact\ntype: project\nsource: agent\ncreated: 2026-01-01\nupdated: 2026-01-01\nexpires: ${yesterday}\n---\n`,
			"utf-8",
		);

		harness.model.script.prependRoute({
			name: "reflect-touch",
			when: (r) => !r.isMainTurn && r.systemPrompt.includes("memory reflection worker"),
			respond: [reply.json({ journal: [], ops: [{ op: "touch", names: ["still-probationary"] }], discarded: [] })],
			repeat: true,
		});

		await harness.sendUserMessage("继续");
		await harness.sendUserMessage("/new");

		await waitForFileContent(
			join(harness.channelDir, "MEMORY.md"),
			(c) => c.includes("touched probationary fact") && !c.includes("already-expired"),
			{ timeoutMs: 10_000, intervalMs: 100 },
		);
		expect(existsSync(join(memoryDir, "already-expired.md"))).toBe(false);
		const touchedRaw = readFileSync(join(memoryDir, "still-probationary.md"), "utf-8");
		expect(touchedRaw).not.toContain("expires:");
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
