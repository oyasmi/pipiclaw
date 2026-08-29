import { existsSync } from "fs";
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
		harness.assertNoUnmatchedRequests();
		await harness.shutdown();
	});

	it("A20: bash hits the command guard and web_fetch hits the network guard — both rejected + audited", async () => {
		harness = await createDeterministicHarness({ web: true });
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

		await harness.sendUserMessage("RUN_BASH 删掉目录");
		expect(existsSync(victim), "guard must stop the destructive rm").toBe(true);
		expect(JSON.stringify(harness.mainTurnRequests().at(-1)?.messages)).toMatch(/not allowed|blocked|guard/i);

		await harness.sendUserMessage("RUN_WEB 抓取元数据");
		expect(JSON.stringify(harness.mainTurnRequests().at(-1)?.messages)).toMatch(/Blocked|private|not allowed/i);

		const audit = harness.readAuditLog();
		expect(audit).toContain("bash");
		expect(audit).toContain("169.254.169.254");
	});

	it("A20: a grep glob with shell metacharacters is escaped, not executed", async () => {
		// beta.3 fix: grep.ts shell-escapes the model-controlled glob before `grep --include=`.
		// Mutation check: drop the shellEscape() around the glob and `pwned` gets created.
		harness = await createDeterministicHarness();
		writeWorkspaceFile(harness, "src/hello.ts", "const needle = 1;");
		const pwned = join(harness.workspaceDir, "pwned-by-grep-glob");

		harness.model.script.route({
			name: "grep",
			when: (r) => r.isMainTurn && r.lastUserText.includes("RUN_GREP"),
			respond: [
				reply.toolCall("grep", {
					pattern: "needle",
					path: join(harness.workspaceDir, "src"),
					glob: `*.ts; touch ${pwned}`,
				}),
				reply.text("搜索结束。"),
			],
			repeat: true,
		});

		await harness.sendUserMessage("RUN_GREP 搜一下");
		expect(existsSync(pwned), "the injected `touch` must not run").toBe(false);
		// The grep still ran (result fed back to the model), it just matched nothing.
		expect(JSON.stringify(harness.mainTurnRequests().at(-1)?.messages)).toMatch(/No matches|matches/i);
	});
});
