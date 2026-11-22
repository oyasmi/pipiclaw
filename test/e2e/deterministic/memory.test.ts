import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDeskMemoryQueue } from "../../../src/memory/desk-memory-queue.js";
import { localDayKey } from "../../../src/shared/local-time.js";
import { createDeterministicHarness, type DeterministicHarness, reply } from "../../support/runtime-harness.js";
import { waitForFileContent } from "../helpers/wait.js";

describe("E2E deterministic: memory (spec 050)", () => {
	let harness: DeterministicHarness;
	afterEach(async () => {
		await harness.shutdown();
	});

	it("M2/DESK-1: two channels of one desk share memory and journal, never each other's conversation", async () => {
		// Spec 058, G1/D1: memory belongs to the desk, conversations to the channel. Catches (a) a
		// first-turn bootstrap built from the conversation directory instead of the desk, and (b) two
		// channels resolving to one conversation. Mutation checks (2026-10-18): building
		// `<memory_bootstrap>` from `conversation.conversationDir` drops the fact from B's request;
		// making `findConversation` return `dm-1` for every channel leaks A_PRIVATE_TEXT into B.
		// The journal half is the original M2 regression: omitting journal.days in memory-manage.ts
		// fails the tool-message assertion.
		const peer = "dingtalk:dm:e2e_peer";
		harness = await createDeterministicHarness({ extraChannels: [{ channelId: peer }] });
		mkdirSync(join(harness.deskDir, "journal"), { recursive: true });
		writeFileSync(join(harness.deskDir, "journal", "2020-01-02.md"), "- release checkpoint: JOURNAL-EVIDENCE-73\n");
		harness.model.script.route({
			name: "a-saves",
			when: (r) => r.isMainTurn && r.lastUserText.includes("A_PRIVATE_TEXT"),
			respond: [
				reply.toolCall("memory_save", { content: "DESK-SHARED-FACT 发布窗口是周四", name: "release-window" }),
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
		expect(bFirst).toContain("DESK-SHARED-FACT");
		for (const request of bRequests) expect(JSON.stringify(request.messages)).not.toContain("A_PRIVATE_TEXT");
		const toolMessages = bRequests.at(-1)?.messages.filter((message) => message.role === "tool") ?? [];
		expect(
			toolMessages.some(
				(message) =>
					message.content.includes("JOURNAL-EVIDENCE-73") && message.content.includes("journal/2020-01-02.md"),
			),
		).toBe(true);
	});

	it("DESK-2: memory writes from two channels of one desk are serialized on the desk", async () => {
		// Spec 058, INV-8: channel A's boundary reflect and channel B's memory_save write the same
		// memory/ and MEMORY.md, so B's write must wait for A's reflect to finish. Mutation check
		// (2026-10-18): letting memory_save run its job without `queue.run` makes B's fact appear
		// on disk while A's reflect is still held, and the "not yet" assertion goes red.
		const peer = "dingtalk:dm:e2e_peer";
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
		const queue = getDeskMemoryQueue();
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
			// Either B's write is waiting on the desk queue (correct), or it already finished.
			await Promise.race([bEntered, bFinished.arrived]);
			const memoryFiles = () => readdirSync(join(harness.deskDir, "memory")).filter((f) => f.endsWith(".md"));
			const hasFact = (fact: string) =>
				existsSync(join(harness.deskDir, "memory")) &&
				memoryFiles().some((f) => readFileSync(join(harness.deskDir, "memory", f), "utf8").includes(fact));
			expect(hasFact("FACT-FROM-B")).toBe(false);

			reflect.release();
			bFinished.release();
			await harness.waitForIdle();
			await getDeskMemoryQueue().run(harness, async () => {});
			expect(hasFact("FACT-FROM-A")).toBe(true);
			expect(hasFact("FACT-FROM-B")).toBe(true);
			const index = readFileSync(join(harness.deskDir, "MEMORY.md"), "utf8");
			expect(index).toContain("oncall-wiki");
		} finally {
			reflect.release();
			bFinished.release();
			spy.mockRestore();
		}
	});

	it("M1: memory_save writes a file; the index is injected on a new session's first turn only", async () => {
		// A saved fact must stay user-owned on disk and enter the new session exactly once.
		// Mutation: bypassing firstTurnMemoryBootstrapPending puts a second index in the follow-up request.
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
			join(harness.deskDir, "memory", "prod-db-port.md"),
			(c) => c.includes("6432"),
			{ timeoutMs: 10_000, intervalMs: 100 },
		);
		expect(saved).toContain("type: reference");
		expect(saved).toContain("source: user");

		const requestFor = async (marker: string) => {
			const before = harness.mainTurnRequests().length;
			await harness.sendUserMessage(marker);
			const requests = harness.mainTurnRequests().slice(before);
			expect(requests).toHaveLength(1);
			expect(requests[0].lastUserText).toContain(marker);
			return requests[0];
		};

		await harness.sendUserMessage("/new");
		const first = await requestFor("BOOTSTRAP_FIRST");
		expect(first.lastUserText).toContain("<memory_index>");
		expect(first.lastUserText).toContain("生产数据库端口是 6432");
		const next = await requestFor("BOOTSTRAP_FOLLOWUP");
		expect(next.lastUserText).not.toContain("<memory_index>");
		const bootstraps = next.messages.filter(
			(message) => message.role === "user" && message.content.includes("<memory_index>"),
		);
		expect(bootstraps.map((message) => message.content)).toEqual([first.lastUserText]);
	});

	it("M3: the boundary reflect pass writes memory + journal and does not reprocess an empty window", async () => {
		// Regression: reflecting an empty session wastes a model call and can duplicate durable facts.
		// Mutation verified: bypass runReflect's hasMeaningfulExchange guard; the empty reset adds a request.
		// Mutation 2026-10-31: consuming the full source window makes the batch assertions fail;
		// the provider then receives a head/tail sample instead of every seeded exchange.
		harness = await createDeterministicHarness({
			seed: ({ deskDir, conversationDir }) => {
				const session = SessionManager.open(join(conversationDir, "context.jsonl"), conversationDir, deskDir);
				for (let index = 0; index < 4; index++) {
					session.appendMessage({
						role: "user",
						content: `MEMORY-BATCH-FACT-${index} ${"中".repeat(7500)}`,
						timestamp: index * 2,
					});
					session.appendMessage({
						role: "assistant",
						content: [{ type: "text", text: "文".repeat(7500) }],
						timestamp: index * 2 + 1,
						api: "openai-completions",
						provider: "e2e-mock",
						model: "mock-main",
						stopReason: "stop",
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					});
				}
			},
		});
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

		// Settle each real producer -> durable worker -> checkpoint batch, not just provider arrival.
		const pending = () =>
			readdirSync(join(harness.deskDir, ".memory-work", basename(harness.conversationDir))).filter((name) =>
				name.endsWith(".json"),
			);
		await getDeskMemoryQueue().run(harness, async () => {});
		for (let batch = 0; batch < 8 && pending().length; batch++) await harness.runtime.memoryMaintenance.runOnce?.();
		expect(pending()).toHaveLength(0);
		const reflected = harness.model.requests.filter((request) => request.matchedRoute === "reflect-once");
		expect(reflected.length).toBeGreaterThan(1);
		for (let index = 0; index < 4; index++) {
			expect(
				reflected.filter((request) => request.lastUserText.includes(`MEMORY-BATCH-FACT-${index}`)),
			).toHaveLength(1);
		}
		const indexPath = join(harness.deskDir, "MEMORY.md");
		await waitForFileContent(indexPath, (c) => c.includes("部署脚本是 scripts/deploy.sh"), {
			timeoutMs: 10_000,
			intervalMs: 100,
		});
		// The journal filename is the *local* calendar day (`localDayKey`), not the UTC one — deriving
		// it from `toISOString()` made this case fail for every hour the two disagree (found 2026-09-06).
		const today = localDayKey();
		const journalPath = join(harness.deskDir, "journal", `${today}.md`);
		const journal = await waitForFileContent(journalPath, (c) => c.includes("完成一次部署"), {
			timeoutMs: 10_000,
			intervalMs: 100,
		});
		expect(journal).toContain("01:00 完成一次部署");
		expect(readdirSync(join(harness.deskDir, "memory")).filter((f) => f.endsWith(".md"))).toHaveLength(1);
		// Mutation: suppressing journal actions in reviewLogEntryFor loses the persisted audit evidence.
		const audit = readFileSync(join(harness.deskDir, "memory-review.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(audit.flatMap((entry) => entry.actions ?? [])).toContainEqual(
			expect.objectContaining({ target: "journal", action: "append", count: 1 }),
		);

		// A second /new with nothing said in between reflects on an empty window — no new call.
		// Instantiate the empty session: /new alone can take the runner-free runtime path.
		await harness.sendUserMessage("/session");
		await harness.sendUserMessage("/new");
		// Drain the queue used by the detached boundary reflect; no observation-time guess.
		await getDeskMemoryQueue().run(harness, async () => {});
		expect(harness.model.requests.filter((r) => r.matchedRoute === "reflect-once")).toHaveLength(reflected.length);
	});
});
