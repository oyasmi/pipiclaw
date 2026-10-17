import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDotMemoryQueue } from "../../../src/memory/dot-memory-queue.js";
import { createTaskDriverEvent } from "../../../src/runtime/task-driver.js";
import { localDayKey } from "../../../src/shared/local-time.js";
import { readActiveTasks } from "../../../src/tasks/contract.js";
import { createDeterministicHarness, type DeterministicHarness, reply } from "../../support/runtime-harness.js";
import { waitForFileContent } from "../helpers/wait.js";

describe("E2E deterministic: memory (spec 050)", () => {
	let harness: DeterministicHarness;
	const taskId = "e2e-det-memory-task";
	afterEach(async () => {
		await harness.shutdown();
	});

	const lastUserContent = (): string => {
		const users = (harness.lastMainTurnRequest()?.messages ?? []).filter((m) => m.role === "user");
		return users.at(-1)?.content ?? "";
	};

	it("M2/DOT-1: two channels of one dot share memory and journal, never each other's conversation", async () => {
		// Spec 058, G1/D1: memory belongs to the dot, conversations to the channel. Catches (a) a
		// first-turn bootstrap built from the conversation directory instead of the dot, and (b) two
		// channels resolving to one conversation. Mutation checks (2026-10-18): building
		// `<memory_bootstrap>` from `conversation.conversationDir` drops the fact from B's request;
		// making `findConversation` return `dm-1` for every channel leaks A_PRIVATE_TEXT into B.
		// The journal half is the original M2 regression: omitting journal.days in memory-manage.ts
		// fails the tool-message assertion.
		const peer = "dm_e2e_peer";
		harness = await createDeterministicHarness({ extraChannels: [{ channelId: peer }] });
		mkdirSync(join(harness.dotDir, "journal"), { recursive: true });
		writeFileSync(join(harness.dotDir, "journal", "2020-01-02.md"), "- release checkpoint: JOURNAL-EVIDENCE-73\n");
		harness.model.script.route({
			name: "a-saves",
			when: (r) => r.isMainTurn && r.lastUserText.includes("A_PRIVATE_TEXT"),
			respond: [
				reply.toolCall("memory_save", { content: "DOT-SHARED-FACT 发布窗口是周四", name: "release-window" }),
				reply.text("好的"),
			],
		});
		harness.model.script.route({
			name: "b-searches",
			when: (r) => r.isMainTurn && r.lastUserText.includes("B_ASKS"),
			respond: [reply.toolCall("memory_search", { query: "release checkpoint" }), reply.text("ok")],
		});

		await harness.sendUserMessage("A_PRIVATE_TEXT 记住发布窗口");
		await harness.sendUserMessage("B_ASKS 查询之前的 release checkpoint。", { channelId: peer });

		const bRequests = harness.mainTurnRequests().filter((r) => r.lastUserText.includes("B_ASKS"));
		expect(bRequests.length).toBeGreaterThan(0);
		const bFirst = JSON.stringify(bRequests[0]?.messages);
		expect(bFirst).toContain("DOT-SHARED-FACT");
		for (const request of bRequests) expect(JSON.stringify(request.messages)).not.toContain("A_PRIVATE_TEXT");
		const toolMessages = bRequests.at(-1)?.messages.filter((message) => message.role === "tool") ?? [];
		expect(
			toolMessages.some(
				(message) =>
					message.content.includes("JOURNAL-EVIDENCE-73") && message.content.includes("journal/2020-01-02.md"),
			),
		).toBe(true);
	});

	it("DOT-2: memory writes from two channels of one dot are serialized on the dot", async () => {
		// Spec 058, INV-8: channel A's boundary reflect and channel B's memory_save write the same
		// memory/ and MEMORY.md, so B's write must wait for A's reflect to finish. Mutation check
		// (2026-10-18): letting memory_save run its job without `queue.run` makes B's fact appear
		// on disk while A's reflect is still held, and the "not yet" assertion goes red.
		const peer = "dm_e2e_peer";
		harness = await createDeterministicHarness({ extraChannels: [{ channelId: peer }] });
		harness.model.script.route({
			name: "ack",
			when: (r) => r.isMainTurn,
			respond: [reply.text("好的")],
			repeat: true,
		});
		harness.model.script.prependRoute({
			name: "b-saves",
			when: (r) => r.isMainTurn && r.lastUserText.includes("B_SAVES"),
			respond: [
				reply.toolCall("memory_save", { content: "FACT-FROM-B 值班表在 wiki", name: "oncall-wiki" }),
				reply.text("好的"),
			],
		});
		harness.model.script.prependRoute({
			name: "reflect",
			when: (r) => !r.isMainTurn && r.systemPrompt.includes("memory reflection worker"),
			respond: [
				reply.json({
					journal: [],
					ops: [
						{
							op: "add",
							type: "project",
							description: "FACT-FROM-A 部署脚本是 scripts/deploy.sh",
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
		const reflect = harness.model.script.hold({
			when: (r) => !r.isMainTurn && r.systemPrompt.includes("memory reflection worker"),
		});
		// B's request after its tool call: it can only exist once B's memory_save has returned.
		const bFinished = harness.model.script.hold({
			when: (r) => r.isMainTurn && r.lastUserText.includes("B_SAVES") && r.messages.some((m) => m.role === "tool"),
		});
		// Observe the real queue: B's write is "waiting" exactly when its job has been handed to it.
		const queue = getDotMemoryQueue();
		const run = queue.run.bind(queue);
		let bSent = false;
		let bQueued!: () => void;
		const bEntered = new Promise<void>((resolve) => {
			bQueued = resolve;
		});
		const spy = vi.spyOn(queue, "run").mockImplementation((target, job) => {
			if (bSent) bQueued();
			return run(target, job);
		});
		try {
			await harness.sendUserMessage("部署脚本在哪？");
			await harness.sendUserMessage("/new"); // A's boundary reflect, held at the provider below
			await reflect.arrived;

			bSent = true;
			await harness.sendUserMessageNoWait("B_SAVES 记住值班表", { channelId: peer });
			// Either B's write is waiting on the dot queue (correct), or it already finished.
			await Promise.race([bEntered, bFinished.arrived]);
			const memoryFiles = () => readdirSync(join(harness.dotDir, "memory")).filter((f) => f.endsWith(".md"));
			const hasFact = (fact: string) =>
				existsSync(join(harness.dotDir, "memory")) &&
				memoryFiles().some((f) => readFileSync(join(harness.dotDir, "memory", f), "utf8").includes(fact));
			expect(hasFact("FACT-FROM-B")).toBe(false);

			reflect.release();
			bFinished.release();
			await harness.waitForIdle();
			await getDotMemoryQueue().run(harness, async () => {});
			expect(hasFact("FACT-FROM-A")).toBe(true);
			expect(hasFact("FACT-FROM-B")).toBe(true);
			const index = readFileSync(join(harness.dotDir, "MEMORY.md"), "utf8");
			expect(index).toContain("oncall-wiki");
		} finally {
			reflect.release();
			bFinished.release();
			spy.mockRestore();
		}
	});

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
			join(harness.dotDir, "memory", "prod-db-port.md"),
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

	it("M1b: a task step does not make the chat session re-inject its bootstrap", async () => {
		// Regression: `bindTaskSession`/`bindChatSession` each set one runner-wide "first turn
		// pending" boolean to true, so returning to a chat session that already carried the
		// bootstrap paid for the whole index a second time — and handed the model a duplicate
		// block. Mutation check: set `firstTurnMemoryBootstrapPending = true` in `bindChatSession`
		// instead of re-deriving it from the bound session, and the last assertion fails.
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
					content: "构建命令是 npm run check",
					name: "build-command",
					type: "reference",
				}),
				reply.text("好的，已记住。"),
			],
		});
		harness.model.script.prependRoute({
			name: "create-task",
			when: (r) => r.isMainTurn && r.lastUserText.includes("建个任务"),
			respond: [
				reply.toolCall("task_create", {
					id: taskId,
					title: "记录一个数字",
					goal: "把数字 42 记录到任务里",
					dod: "- [x] 把 42 记录下来",
				}),
				reply.text("任务已创建。"),
			],
		});
		harness.model.script.prependRoute({
			name: "drive",
			when: (r) => r.isMainTurn && r.lastUserText.includes("[TASK_STEP:"),
			respond: [
				reply.toolCall("task_step_end", { outcome: "continue", note: "看了一眼，继续。" }),
				reply.text("继续。"),
			],
			repeat: true,
		});

		await harness.sendUserMessage("记住：构建命令是 npm run check。");
		await harness.sendUserMessage("帮我建个任务");
		await harness.sendUserMessage("/new");

		// First turn of the fresh chat session: the bootstrap lands, as it should.
		await harness.sendUserMessage("你好");
		expect(lastUserContent()).toContain("<memory_bootstrap>");

		// One task step in between. The task cycle gets its own session, so it gets its own
		// bootstrap — that part is correct and stays.
		const tasksDir = join(harness.dotDir, "tasks");
		const entry = (await readActiveTasks(tasksDir)).find((e) => e.id === taskId);
		expect(entry).toBeDefined();
		const driver = createTaskDriverEvent(harness.dot, harness.channelId, entry!, Date.now());
		await harness.sendWake(driver.text, { user: "TASK_DRIVER", userName: "TASK_DRIVER" });
		expect(lastUserContent()).toContain("<memory_bootstrap>");

		// Back on chat, which already has one: it must not be sent again.
		await harness.sendUserMessage("再聊一句");
		expect(lastUserContent()).not.toContain("<memory_bootstrap>");
	});

	it("M3: the boundary reflect pass writes memory + journal and does not reprocess an empty window", async () => {
		// Regression: reflecting an empty session wastes a model call and can duplicate durable facts.
		// Mutation verified: bypass runReflect's hasMeaningfulExchange guard; the final count is 2, not 1.
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

		const indexPath = join(harness.dotDir, "MEMORY.md");
		await waitForFileContent(indexPath, (c) => c.includes("部署脚本是 scripts/deploy.sh"), {
			timeoutMs: 10_000,
			intervalMs: 100,
		});
		// The journal filename is the *local* calendar day (`localDayKey`), not the UTC one — deriving
		// it from `toISOString()` made this case fail for every hour the two disagree (found 2026-09-06).
		const today = localDayKey();
		const journalPath = join(harness.dotDir, "journal", `${today}.md`);
		const journal = await waitForFileContent(journalPath, (c) => c.includes("完成一次部署"), {
			timeoutMs: 10_000,
			intervalMs: 100,
		});
		expect(journal).toContain("01:00 完成一次部署");
		expect(readdirSync(join(harness.dotDir, "memory")).filter((f) => f.endsWith(".md"))).toHaveLength(1);

		// A second /new with nothing said in between reflects on an empty window — no new call.
		// Instantiate the empty session: /new alone can take the runner-free runtime path.
		await harness.sendUserMessage("/session");
		await harness.sendUserMessage("/new");
		// Drain the queue used by the detached boundary reflect; no observation-time guess.
		await getDotMemoryQueue().run(harness, async () => {});
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
		await waitForFileContent(join(harness.dotDir, "memory", "prod-key-location.md"), () => true, {
			timeoutMs: 10_000,
			intervalMs: 100,
		});

		await harness.sendUserMessage("/new");
		const reviewLogPath = join(harness.dotDir, "memory-review.jsonl");
		await waitForFileContent(
			reviewLogPath,
			(c) => c.includes("prod-key-location") && c.includes("cannot be auto-deleted"),
			{ timeoutMs: 10_000, intervalMs: 100 },
		);

		expect(existsSync(join(harness.dotDir, "memory", "prod-key-location.md"))).toBe(true);
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

		const memoryDir = join(harness.dotDir, "memory");
		mkdirSync(memoryDir, { recursive: true });
		const yesterday = localDayKey(new Date(Date.now() - 24 * 60 * 60 * 1000));
		const farFuture = localDayKey(new Date(Date.now() + 20 * 24 * 60 * 60 * 1000));
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
			join(harness.dotDir, "MEMORY.md"),
			(c) => c.includes("touched probationary fact") && !c.includes("already-expired"),
			{ timeoutMs: 10_000, intervalMs: 100 },
		);
		expect(existsSync(join(memoryDir, "already-expired.md"))).toBe(false);
		const touchedRaw = readFileSync(join(memoryDir, "still-probationary.md"), "utf-8");
		expect(touchedRaw).not.toContain("expires:");
	});
});
