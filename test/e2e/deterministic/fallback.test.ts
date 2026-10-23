import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentSession, type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionHost } from "../../../src/agent/session/session-host.js";
import {
	createDeterministicHarness,
	type DeterministicHarness,
	reply,
	seedLegacySession,
} from "../../support/runtime-harness.js";

describe("E2E deterministic: model fallback", () => {
	let harness: DeterministicHarness;
	afterEach(async () => {
		vi.restoreAllMocks();
		await harness.shutdown();
	});

	it("A22: a 429 on the primary model falls back to the backup and the turn still completes", async () => {
		// 017 fallback logic. Mutation check: make shouldFallback() return false for a 429
		// message and the turn ends with an error delivery instead of the backup's answer.
		harness = await createDeterministicHarness({
			seed: ({ deskDir, conversationDir }) => {
				seedLegacySession("chat", join(conversationDir, "context.jsonl"), deskDir);
			},
		});
		harness.model.script.route({
			name: "answer",
			when: (r) => r.isMainTurn && r.lastUserText.includes("FALLBACK_TEST"),
			respond: [reply.text("备用模型答复。")],
			repeat: true,
		});
		harness.model.script.failNext({ status: 429 });

		await harness.sendUserMessage("FALLBACK_TEST 请回复");

		// Spec 055 mutation (executed 2026-10-13; restored green): memory-only truncation produces two FALLBACK_TEST inputs.
		const mains = harness.mainTurnRequests();
		expect(mains).toHaveLength(2);
		expect(mains[0]?.matchedRoute).toBe("__fail_429");
		expect(mains[1]?.model).toBe("mock-fallback");
		expect(
			mains[1]?.messages.filter((message) => message.role === "user" && message.content.includes("FALLBACK_TEST")),
		).toHaveLength(1);
		expect(mains[1]?.messages.some((message) => message.content.includes("OLD_HISTORY"))).toBe(true);
		const path = join(harness.conversationDir, "context.jsonl");
		const raw = readFileSync(path, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(raw.filter((entry) => entry.type === "context_edit")).toHaveLength(2);
		expect(raw.some((entry) => entry.message?.stopReason === "error")).toBe(true);
		expect(harness.deliveries.filter((delivery) => delivery.method === "finalizeExistingCard")).toHaveLength(1);
		await harness.restart();
		await harness.sendUserMessage("FALLBACK_TEST 继续");
		expect(
			harness
				.lastMainTurnRequest()
				?.messages.filter((message) => message.role === "user" && message.content.includes("FALLBACK_TEST")),
		).toHaveLength(2);
	});

	it("quarantines a partially edited SDK instance until a disk rebuild", async () => {
		// Spec 055 mutation (executed 2026-10-13; restored green): removing host's fault check lets NEXT_TURN reach the provider.
		// The first edit is durable; inject the second failure at the real persistence seam.
		harness = await createDeterministicHarness();
		writeFileSync(join(harness.workspaceDir, "MEMORY.md"), "## Fixture\nRESTORED_BOOTSTRAP\n");
		harness.model.script.route({
			name: "answer",
			when: (request) => request.isMainTurn,
			respond: [reply.text("ok")],
			repeat: true,
		});
		// The SDK indexes an entry before _persist; this fault leaves its cache ahead of disk.
		const prototype = SessionManager.prototype as unknown as { _persist(entry: SessionEntry): void };
		const persist = prototype._persist;
		let edits = 0;
		vi.spyOn(prototype, "_persist").mockImplementation(function (this: SessionManager, entry) {
			if (entry.type === "context_edit" && ++edits === 2) throw new Error("injected second edit failure");
			return persist.call(this, entry);
		});
		let faultedHost!: SessionHost;
		const markFault = SessionHost.prototype.markContextFault;
		vi.spyOn(SessionHost.prototype, "markContextFault").mockImplementation(function (
			this: SessionHost,
			session,
			error,
		) {
			faultedHost = this;
			return markFault.call(this, session, error);
		});
		harness.model.script.failNext({ status: 429 });
		await harness.sendUserMessage("PARTIAL_WRITE");
		expect(edits).toBe(2);
		expect(harness.mainTurnRequests()).toHaveLength(1);
		vi.restoreAllMocks();
		const disk = SessionManager.open(join(harness.conversationDir, "context.jsonl"));
		expect(disk.getBranch().filter((entry) => entry.type === "context_edit")).toHaveLength(1);
		expect(faultedHost.sessionManager.getBranch().filter((entry) => entry.type === "context_edit")).toHaveLength(2);
		vi.spyOn(AgentSession.prototype, "reload").mockRejectedValue(new Error("injected reload failure"));
		await faultedHost.refreshSessionResources();
		const beforeRefused = readFileSync(join(harness.conversationDir, "context.jsonl"), "utf8");
		await harness.sendUserMessage("NEXT_TURN");
		expect(harness.mainTurnRequests()).toHaveLength(1);
		expect(readFileSync(join(harness.conversationDir, "context.jsonl"), "utf8")).toBe(beforeRefused);
		vi.restoreAllMocks();
		await harness.restart();
		expect(harness.mainTurnRequests()).toHaveLength(1); // No automatic backup replay on rebuild.
		await harness.sendUserMessage("REBUILT_FROM_DISK");
		expect(harness.mainTurnRequests()).toHaveLength(2);
		expect(harness.lastMainTurnRequest()?.lastUserText).toContain("RESTORED_BOOTSTRAP");
		// /new must remain available through the transport's replacement path.
		await harness.sendUserMessage("/new");
		await harness.sendUserMessage("REBUILT");
		expect(harness.mainTurnRequests()).toHaveLength(3);
		expect(harness.lastMainTurnRequest()?.lastUserText).toContain("REBUILT");
	});
});
