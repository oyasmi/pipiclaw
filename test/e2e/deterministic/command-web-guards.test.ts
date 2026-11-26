import { existsSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createDeterministicHarness,
	type DeterministicHarness,
	reply,
	writeWorkspaceFile,
} from "../../support/runtime-harness.js";

describe("E2E deterministic: command & network guards", () => {
	let harness: DeterministicHarness;
	afterEach(async () => {
		await harness.shutdown();
	});

	it("A20: command and web tools use the runtime guards and audit refused actions", async () => {
		// Catches a web_search backend bypassing the shared network guard or swallowing its refusal.
		harness = await createDeterministicHarness({
			web: true,
			seed: ({ homeDir }) => {
				writeFileSync(
					join(homeDir, "tools.json"),
					JSON.stringify({
						tools: {
							web: {
								enable: true,
								search: { provider: "searxng", baseUrl: "http://127.0.0.1:1", fallback: null },
							},
						},
					}),
				);
			},
		});
		const victim = join(harness.workspaceDir, "e2e-guard-victim");
		writeWorkspaceFile(harness, "e2e-guard-victim/keep.txt", "keep");

		harness.model.script.route({
			name: "bash-block",
			when: (r) => r.isMainTurn && r.lastUserText.includes("RUN_BASH"),
			respond: [reply.toolCall("bash", { command: `rm -rf ${victim}` }), reply.text("收到拒绝。")],
			repeat: true,
		});
		harness.model.script.route({
			name: "web-block",
			when: (r) => r.isMainTurn && r.lastUserText.includes("RUN_WEB"),
			respond: [
				reply.toolCall("web_fetch", { url: "http://169.254.169.254/latest/meta-data/" }),
				reply.text("收到拒绝。"),
			],
			repeat: true,
		});

		harness.model.script.route({
			name: "search-block",
			when: (r) => r.isMainTurn && r.lastUserText.includes("RUN_SEARCH"),
			respond: [reply.toolCall("web_search", { query: "example search" }), reply.text("收到拒绝。")],
			repeat: true,
		});

		await harness.sendUserMessage("RUN_BASH 删掉目录");
		expect(existsSync(victim), "guard must stop the destructive rm").toBe(true);
		expect(JSON.stringify(harness.mainTurnRequests().at(-1)?.messages)).toMatch(/not allowed|blocked|guard/i);

		await harness.sendUserMessage("RUN_WEB 抓取元数据");
		expect(JSON.stringify(harness.mainTurnRequests().at(-1)?.messages)).toMatch(/Blocked|private|not allowed/i);

		await harness.sendUserMessage("RUN_SEARCH 使用已配置的检索");
		expect(JSON.stringify(harness.mainTurnRequests().at(-1)?.messages)).toMatch(/Blocked|private|not allowed/i);

		const audit = harness.readAuditLog();
		expect(audit).toContain("bash");
		expect(audit).toContain("169.254.169.254");
		expect(audit).toContain("http://127.0.0.1:1/search?q=example+search&format=json");
	});
});
