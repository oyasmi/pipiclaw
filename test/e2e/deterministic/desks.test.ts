import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getBindingsPath, getDeskDir } from "../../../src/desk/paths.js";
import type { InboundMessages } from "../../../src/dingtalk/inbound.js";
import type { DurableDispatchRecord } from "../../../src/runtime/durable-dispatch.js";
import { createTaskDocument } from "../../../src/tasks/create.js";
import { createDeterministicHarness, type DeterministicHarness, reply } from "../../support/runtime-harness.js";
import { waitFor } from "../helpers/wait.js";

/** Spec 058: desks, bindings and what an unbound channel may and may not do. */
describe("E2E deterministic: desks and bindings", () => {
	let harness: DeterministicHarness;
	afterEach(async () => {
		vi.restoreAllMocks();
		await harness.shutdown();
	});

	it("DESK-4: first contact shares default, persists across restart and preserves explicit bindings", async () => {
		// Catches missing human-ingress auto-binding, accidental per-channel assistants, lost
		// concurrent binding writes, and startup silently replacing an assistant whose data is gone.
		// Mutation checks (2026-10-23): removing ensureDefaultBinding makes first-contact requests
		// stay at zero; letting initialization recreate a bound default fails the final refusal.
		harness = await createDeterministicHarness();
		harness.model.script.route({
			name: "chat",
			when: (r) => r.isMainTurn,
			respond: [reply.text("ok")],
			repeat: true,
		});
		const channels = ["dingtalk:group:cidNEW/shared+AA==", "dingtalk:group:cidSECOND+AA==", "dingtalk:dm:new_user"];
		const defaultDir = getDeskDir(harness.workspaceDir, "default");
		const desksBefore = readdirSync(harness.workspaceDir)
			.filter((name) => name.startsWith("desk-"))
			.sort();
		// Historical background work cannot attach a channel: only a real message may do that.
		await harness.sendWake("orphan wake", { channelId: "dingtalk:dm:orphan", desk: "default" });
		expect(harness.runtime.desks.boundDesk("dingtalk:dm:orphan")).toBeUndefined();
		expect(harness.modelRequestCount()).toBe(0);
		const inbound = harness.bot as unknown as {
			inbound: InboundMessages;
		};

		// Real ingress, including authorization: a disallowed sender must create no binding.
		const config = inbound.inbound as unknown as { deps: { config: { allowFrom?: string[] } } };
		config.deps.config.allowFrom = ["allowed"];
		await inbound.inbound.onStreamMessage({ senderStaffId: "denied", text: { content: "hello" } });
		expect(harness.runtime.desks.boundDesk("dingtalk:dm:denied")).toBeUndefined();
		expect(harness.modelRequestCount()).toBe(0);
		await Promise.all(
			channels.map((channelId) =>
				inbound.inbound.onStreamMessage({
					senderStaffId: "allowed",
					conversationType: channelId.startsWith("dingtalk:group:") ? "2" : "1",
					conversationId: channelId.slice("dingtalk:group:".length),
					text: { content: channelId },
				}),
			),
		);
		await harness.waitForIdle();
		const actual = [channels[0], channels[1], "dingtalk:dm:allowed"];
		expect(harness.mainTurnRequests()).toHaveLength(3);
		const bindings = JSON.parse(readFileSync(getBindingsPath(harness.workspaceDir), "utf8")).bindings;
		for (const channelId of actual) expect(bindings[channelId].desk).toBe("default");
		expect(bindings[harness.channelId].desk).toBe("e2e");
		expect(
			readdirSync(harness.workspaceDir)
				.filter((name) => name.startsWith("desk-"))
				.sort(),
		).toEqual(desksBefore);
		const record = JSON.parse(readFileSync(join(defaultDir, "desk.json"), "utf8"));
		expect(new Set(Object.values(record.conversations).map((value) => (value as { dir: string }).dir)).size).toBe(3);
		for (const channelId of actual) expect(existsSync(join(harness.workspaceDir, channelId))).toBe(false);

		await harness.restart();
		await harness.sendUserMessage("AFTER_RESTART", { channelId: channels[0] });
		expect(JSON.parse(readFileSync(join(defaultDir, "desk.json"), "utf8"))).toEqual(record);
		expect(harness.mainTurnRequests()).toHaveLength(4);
		await harness.runtime.shutdown("manual");
		rmSync(defaultDir, { recursive: true });
		await harness.restart();
		const before = harness.modelRequestCount();
		await harness.sendUserMessage("do not recreate", {
			channelId: channels[0],
		});
		expect(harness.modelRequestCount()).toBe(before);
		expect(existsSync(defaultDir)).toBe(false);
	});

	it("DESK-3: rebinding a channel suspends its old desk's work there and drops that desk's in-flight wake", async () => {
		// Catches a rebind that lets the old desk keep talking into the channel: a queued wake of the
		// old desk answered in the new desk's conversation, or the old desk's task still stepping.
		// Mutation checks (2026-10-18): removing the admission check in `runEventTurn` lets the stale
		// wake reach the provider; removing the lane's freeze check lets the task step run while the
		// channel is bound to `lab` (the step's request reaches the provider). Either turns the case red.
		// R3 extension (2026-10-29): rebind while step 1 is held, then release it; step 2 must
		// not reach the provider until rebound. Mutation: remove the drive and beginStep binding
		// checks; step 2 reaches the provider while frozen and this case fails (verified).
		// A second channel keeps `e2e` active after the rebind, so the lane still scans it and the
		// per-task freeze (not the desk's dormancy) is what holds the task back.
		harness = await createDeterministicHarness({ extraChannels: [{ channelId: "dingtalk:group:cidKEEP+e2e==" }] });
		const taskId = "weekly-digest";
		await createTaskDocument({
			deskDir: harness.deskDir,
			id: taskId,
			input: { title: "Weekly digest", goal: "Send the digest", dod: "- [x] digest sent" },
			channel: harness.channelId,
		});
		harness.model.script.route({
			name: "chat",
			when: (r) => r.isMainTurn && r.lastUserText.includes("IN_LAB"),
			respond: [reply.text("在 lab 里。")],
		});
		harness.model.script.route({
			name: "step",
			when: (r) => r.isMainTurn && r.lastUserText.includes(`[TASK_STEP:${taskId} #2]`),
			respond: [reply.toolCall("task_close", { id: taskId, outcome: "complete", note: "digest sent" })],
		});

		harness.model.script.route({
			name: "before-freeze",
			when: (r) => r.isMainTurn && r.lastUserText.includes(`[TASK_STEP:${taskId} #1]`),
			respond: [
				reply.toolCall("read", { path: join(harness.deskDir, "tasks", `${taskId}.md`) }),
				reply.text("current step finished"),
			],
		});
		const running = harness.model.script.hold({ when: (r) => r.lastUserText.includes(`[TASK_STEP:${taskId} #1]`) });
		await harness.runtime.taskLane.runOnce();
		await running.arrived;
		await harness.sendUserMessage("/desk new lab");
		await harness.sendUserMessage("/desk bind lab");
		expect(JSON.parse(readFileSync(getBindingsPath(harness.workspaceDir), "utf8")).bindings).toMatchObject({
			[harness.channelId]: { desk: "lab" },
		});

		running.release();
		await harness.runtime.taskLane.drained();
		// A completion wake the old desk produced before the rebind, still on the durable outbox.
		const dispatchId = `subagent:${harness.desk}:run_stale:done`;
		const dispatchDir = join(harness.homeDir, "state", "dispatch");
		mkdirSync(dispatchDir, { recursive: true });
		const wake = {
			source: "wake" as const,
			channelId: harness.channelId,
			ts: "1",
			producer: "SUBAGENT",
			text: "[SUBAGENT:run_stale] finished: STALE_RESULT",
			dispatchId,
			desk: harness.desk,
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
		await harness.runtime.taskLane.runOnce();
		await harness.waitForIdle();
		expect(harness.modelRequestCount()).toBe(before);
		expect(existsSync(recordPath)).toBe(false);
		// Frozen, not dropped: no step ran, and the task is exactly where it was.
		expect(harness.mainTurnRequests().some((r) => r.matchedRoute === "step")).toBe(false);

		// The channel's next turn runs in its conversation in `lab`, not in the old desk.
		await harness.sendUserMessage("IN_LAB 你在哪个 desk");
		const labConversation = join(getDeskDir(harness.workspaceDir, "lab"), "conversations", "dm-1");
		const labSession = readdirSync(labConversation).find((name) => name.endsWith(".jsonl") && name !== "log.jsonl");
		expect(labSession && readFileSync(join(labConversation, labSession), "utf8")).toContain("IN_LAB");
		expect(readFileSync(join(harness.conversationDir, "context.jsonl"), "utf8")).not.toContain("IN_LAB");

		// Bound back, the old desk's task resumes on the lane's next pass.
		await harness.sendUserMessage("/desk bind e2e");
		await harness.runtime.taskLane.runOnce();
		await waitFor("the frozen task to run", () => harness.mainTurnRequests().some((r) => r.matchedRoute === "step"), {
			intervalMs: 25,
		});
		expect(JSON.stringify(harness.mainTurnRequests().map((r) => r.lastUserText))).not.toContain("STALE_RESULT");
	});
});
