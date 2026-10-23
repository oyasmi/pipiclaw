import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionHost } from "../../../src/agent/session/session-host.js";
import { PLAYBOOKS_DIR } from "../../../src/paths.js";
import { createDeterministicHarness, type DeterministicHarness, reply } from "../../support/runtime-harness.js";

/**
 * System-prompt ownership (spec 048 D5). Asserted directly on the body the
 * provider received — no `PIPICLAW_DEBUG`, no `last_prompt.json` intermediary.
 */
describe("E2E deterministic: system prompt", () => {
	let harness: DeterministicHarness;
	afterEach(async () => {
		vi.restoreAllMocks();
		await harness?.shutdown();
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
		harness = await createDeterministicHarness({
			seed: ({ homeDir, deskDir }) => {
				const workspaceDir = join(homeDir, "workspace");
				const project = join(homeDir, "project");
				mkdirSync(project);
				const path = join(deskDir, "desk.json");
				writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), cwd: project }));
				writeFileSync(join(workspaceDir, "SOUL.md"), "SHARED_IDENTITY_060");
				writeFileSync(join(workspaceDir, "AGENTS.md"), "SHARED_RULES_060");
				writeFileSync(join(deskDir, "SOUL.md"), "LOCAL_IDENTITY_060");
			},
		});
		const guidePath = join(PLAYBOOKS_DIR, "runtime-orientation.md");
		const guide = readFileSync(guidePath, "utf8");
		harness.model.script.route({
			name: "t",
			when: (r) => r.lastUserText.includes("你好"),
			respond: [reply.toolCall("read", { path: guidePath }), reply.text("ok")],
		});
		await harness.sendUserMessage("你好");

		const request = harness.model.requests.find((request) => request.lastUserText.includes("你好"));
		const prompt = request?.systemPrompt ?? "";
		expect(prompt).toContain("## Pipiclaw");
		// Spec 060: shared identity survives a custom cwd and a desk-local SOUL file.
		// Mutation: loading identity from deskDir loses SHARED_IDENTITY_060; omitting the
		// workspace fact loses its path from the per-turn capsule. Both make this case red.
		expect(prompt).toContain("SHARED_IDENTITY_060");
		expect(prompt).toContain("SHARED_RULES_060");
		expect(prompt).not.toContain("LOCAL_IDENTITY_060");
		expect(prompt).not.toContain(guide);
		const capsule =
			request?.messages.find(
				(message) => message.role === "user" && message.content.includes("<runtime_turn_context>"),
			)?.content ?? "";
		expect(capsule).toContain(`Workspace: ${harness.workspaceDir}`);
		const history = JSON.stringify(harness.lastMainTurnRequest()!.messages);
		for (const path of [harness.deskDir, join(harness.homeDir, "project")]) expect(capsule).toContain(path);
		expect(history).toContain(JSON.stringify(guide).slice(1, -1));
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
		expect(reloaded.systemPrompt).toContain("runtime-orientation.md");
		expect(reloaded.tools).not.toContain("task_create");
		expect(JSON.stringify(reloaded.messages)).toContain("RELOADED_TOOL_RESULT");
	});
});
