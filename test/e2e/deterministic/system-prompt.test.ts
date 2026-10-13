import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionHost } from "../../../src/agent/session/session-host.js";
import { createDeterministicHarness, type DeterministicHarness, reply } from "../../support/runtime-harness.js";

/**
 * System-prompt ownership (spec 048 D5). Asserted directly on the body the
 * provider received — no `PIPICLAW_DEBUG`, no `last_prompt.json` intermediary.
 */
describe("E2E deterministic: system prompt", () => {
	let harness: DeterministicHarness;
	afterEach(async () => {
		vi.restoreAllMocks();
		await harness.shutdown();
	});

	it("sends the Pipiclaw prompt with pi's default base prompt gone, boundary last", async () => {
		// Catches SDK/session assembly restoring pi's base prompt or appending resource text
		// after the runtime boundary. These assertions inspect provider input, not model quality.
		let host!: SessionHost;
		const buildPrompt = SessionHost.prototype.buildSystemPrompt;
		vi.spyOn(SessionHost.prototype, "buildSystemPrompt").mockImplementation(function (this: SessionHost) {
			host = this;
			return buildPrompt.call(this);
		});
		harness = await createDeterministicHarness();
		harness.model.script.route({
			name: "t",
			when: (r) => r.lastUserText.includes("你好"),
			respond: [reply.text("ok")],
		});
		await harness.sendUserMessage("你好");

		const request = harness.model.requests.find((request) => request.lastUserText.includes("你好"));
		const prompt = request?.systemPrompt ?? "";
		expect(prompt).toContain("## Pipiclaw");
		expect(request?.tools).toContain("read");
		expect(request?.tools).not.toContain("ls");
		expect(prompt).not.toContain("operating inside pi, a coding agent harness");
		expect(prompt).not.toContain("Pi documentation");

		// pi's tail is present, and the runtime boundary is appended after it and is last.
		const cwdAt = prompt.indexOf("<cwd>");
		const boundaryAt = prompt.lastIndexOf("## Runtime Boundary");
		expect(cwdAt).toBeGreaterThan(-1);
		expect(boundaryAt).toBeGreaterThan(cwdAt);
		expect(prompt.trimEnd().length - boundaryAt).toBeLessThan(400);

		// Channel id / directory ride the turn, never the system prompt.
		expect(prompt).not.toContain(harness.channelId);
		// Reload must update the provider's actual declaration and executable tool instances.
		const fixturePath = join(harness.workspaceDir, "fixture.txt");
		writeFileSync(fixturePath, "RELOADED_TOOL_RESULT");
		writeFileSync(join(harness.homeDir, "tools.json"), JSON.stringify({ tools: { tasks: { enabled: false } } }));
		await host.refreshSessionResources();
		harness.model.script.route({
			name: "reloaded",
			when: (r) => r.lastUserText.includes("RELOAD"),
			respond: [reply.toolCall("read", { path: fixturePath }), reply.text("ok")],
		});
		await harness.sendUserMessage("RELOAD");
		const reloaded = harness.lastMainTurnRequest()!;
		expect(reloaded.tools).toContain("read");
		expect(reloaded.tools).not.toContain("task_create");
		expect(JSON.stringify(reloaded.messages)).toContain("RELOADED_TOOL_RESULT");
	});
});
