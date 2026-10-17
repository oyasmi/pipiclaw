import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getBindingsPath, getDotDir } from "../../../src/dot/paths.js";
import { type DurableDispatchRecord, DurableDispatchService } from "../../../src/runtime/durable-dispatch.js";
import { createTaskDocument } from "../../../src/tasks/create.js";
import { createDeterministicHarness, type DeterministicHarness, reply } from "../../support/runtime-harness.js";

/** Spec 058: dots, bindings and what an unbound channel may and may not do. */
describe("E2E deterministic: dots and bindings", () => {
	let harness: DeterministicHarness;
	afterEach(async () => {
		vi.restoreAllMocks();
		await harness.shutdown();
	});

	it("DOT-4: an unbound channel calls no model and creates nothing on disk", async () => {
		// Catches a regression back to "every message grows its own assistant" (INV-2): any path that
		// builds a runner, a dot or a conversation for an unbound channel. Mutation check (2026-10-18):
		// making `DotRuntime.resolve` fall back to another channel's binding for an unbound channel
		// lets the turn reach the provider (model request count 2), and the case goes red.
		harness = await createDeterministicHarness();
		const stranger = "group_cidNEW/unbound+AA==";
		const dotsDir = join(harness.workspaceDir, "dots");
		const dotsBefore = readdirSync(dotsDir).sort();
		const conversationsBefore = readdirSync(join(harness.dotDir, "conversations")).sort();
		const bindingsBefore = readFileSync(getBindingsPath(harness.workspaceDir), "utf8");

		const before = harness.deliveries.length;
		await harness.sendUserMessage("你好，帮我看看这个群", {
			channelId: stranger,
			type: "group",
			conversationType: "2",
		});

		expect(harness.modelRequestCount()).toBe(0);
		const replies = harness.deliveries.slice(before).filter((d) => d.channelId === stranger);
		expect(replies).toHaveLength(1);
		expect(readdirSync(dotsDir).sort()).toEqual(dotsBefore);
		expect(readdirSync(join(harness.dotDir, "conversations")).sort()).toEqual(conversationsBefore);
		expect(readFileSync(getBindingsPath(harness.workspaceDir), "utf8")).toBe(bindingsBefore);
		expect(existsSync(join(harness.workspaceDir, stranger))).toBe(false);
	});

	it("DOT-3: rebinding a channel suspends its old dot's work there and drops that dot's in-flight wake", async () => {
		// Catches a rebind that lets the old dot keep talking into the channel: a queued wake of the
		// old dot answered in the new dot's conversation, or the old dot's task still stepping.
		// Mutation checks (2026-10-18): removing the admission check in `runEventTurn` lets the stale
		// wake reach the provider; removing the task driver's binding filter puts the task's step on
		// the outbox while the channel is bound to `lab` (admission would then drop it, so the
		// outbox is where that shows). Either turns the case red.
		const dispatched: string[] = [];
		const originalDispatch = DurableDispatchService.prototype.dispatch;
		vi.spyOn(DurableDispatchService.prototype, "dispatch").mockImplementation(function (
			this: DurableDispatchService,
			event,
		) {
			if (event.dispatchId) dispatched.push(event.dispatchId);
			return originalDispatch.call(this, event);
		});
		// A second channel keeps `e2e` active after the rebind, so the driver still scans it and the
		// per-task binding filter (not the dot's dormancy) is what holds the task back.
		harness = await createDeterministicHarness({ extraChannels: [{ channelId: "group_cidKEEP+e2e==" }] });
		const taskId = "weekly-digest";
		await createTaskDocument({
			dotDir: harness.dotDir,
			id: taskId,
			input: { title: "Weekly digest", goal: "Send the digest", dod: "- [ ] digest sent" },
			channel: harness.channelId,
		});
		harness.model.script.route({
			name: "chat",
			when: (r) => r.isMainTurn && r.lastUserText.includes("IN_LAB"),
			respond: [reply.text("在 lab 里。")],
		});
		harness.model.script.route({
			name: "step",
			when: (r) => r.isMainTurn && r.lastUserText.includes(`[TASK_STEP:${taskId}]`),
			respond: [reply.toolCall("task_step_end", { outcome: "done", note: "digest sent" }), reply.text("ok")],
		});

		await harness.sendUserMessage("/dot new lab");
		await harness.sendUserMessage("/dot bind lab");
		expect(JSON.parse(readFileSync(getBindingsPath(harness.workspaceDir), "utf8")).bindings).toMatchObject({
			[harness.channelId]: { dot: "lab" },
		});

		// A completion wake the old dot produced before the rebind, still on the durable outbox.
		const dispatchId = `subagent:${harness.dot}:run_stale:done`;
		const dispatchDir = join(harness.homeDir, "state", "dispatch");
		mkdirSync(dispatchDir, { recursive: true });
		const wake = {
			type: "dm" as const,
			channelId: harness.channelId,
			ts: "1",
			user: "SUBAGENT",
			userName: "SUBAGENT",
			text: "[SUBAGENT:run_stale] finished: STALE_RESULT",
			conversationId: "conv_e2e",
			conversationType: "1",
			dispatchId,
			dot: harness.dot,
		};
		const record: DurableDispatchRecord = {
			version: 1,
			id: dispatchId,
			event: wake,
			status: "queued",
			deliveries: 1,
			createdAt: new Date().toISOString(),
			leaseExpiresAt: new Date(Date.now() + 900_000).toISOString(),
		};
		const recordPath = join(dispatchDir, `${encodeURIComponent(dispatchId)}.json`);
		writeFileSync(recordPath, JSON.stringify(record));
		const before = harness.modelRequestCount();
		expect(harness.enqueueWake(wake.text, wake)).toBe(true);
		await harness.waitForIdle();
		await harness.runtime.taskDriver.runOnce?.();
		await harness.waitForIdle();
		expect(harness.modelRequestCount()).toBe(before);
		expect(existsSync(recordPath)).toBe(false);
		expect(dispatched.filter((id) => id.startsWith(`task:${harness.dot}:${taskId}:`))).toEqual([]);

		// The channel's next turn runs in its conversation in `lab`, not in the old dot.
		await harness.sendUserMessage("IN_LAB 你在哪个 dot");
		const labConversation = join(getDotDir(harness.workspaceDir, "lab"), "conversations", "dm-1");
		const labSession = readdirSync(labConversation).find((name) => name.endsWith(".jsonl") && name !== "log.jsonl");
		expect(labSession && readFileSync(join(labConversation, labSession), "utf8")).toContain("IN_LAB");
		expect(readFileSync(join(harness.conversationDir, "context.jsonl"), "utf8")).not.toContain("IN_LAB");

		// Bound back, the old dot's task resumes on the driver's next pass.
		await harness.sendUserMessage("/dot bind e2e");
		await harness.runtime.taskDriver.runOnce?.();
		await harness.waitForIdle();
		expect(dispatched.some((id) => id.startsWith(`task:${harness.dot}:${taskId}:`))).toBe(true);
		expect(harness.mainTurnRequests().some((r) => r.matchedRoute === "step")).toBe(true);
		expect(JSON.stringify(harness.mainTurnRequests().map((r) => r.lastUserText))).not.toContain("STALE_RESULT");
	});
});
