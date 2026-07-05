import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	canRunE2E,
	cleanupE2ETestHome,
	createE2ETestHome,
	type E2ETestHome,
	getE2ESkipReason,
} from "./helpers/setup.js";

const describeE2E = canRunE2E() ? describe : describe.skip;

// Unlike the other e2e specs (which drive the runtime through a fake DingTalk
// bot), this one exercises the terminal channel end-to-end: the real
// `pipiclaw tui --print` path, a real ChannelRunner on a live model, and the
// terminal ChannelContext delivering the final answer to stdout. It is the only
// e2e where an unstubbed transport carries a turn from entry to output.
describeE2E("E2E: terminal TUI (--print)", () => {
	let home: E2ETestHome;

	beforeAll(() => {
		home = createE2ETestHome();
		// ChannelRunner resolves auth/models from paths.ts constants derived from
		// PIPICLAW_HOME at module load, so set it before importing the TUI app.
		process.env.PIPICLAW_HOME = home.homeDir;
	});

	afterAll(() => {
		cleanupE2ETestHome(home.homeDir);
	});

	it("answers a one-shot prompt through the terminal channel and persists channel memory", async () => {
		const { runTuiApp } = await import("../../src/tui/app.js");

		const chunks: string[] = [];
		const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
			chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
			return true;
		});

		try {
			await runTuiApp({
				sandbox: { type: "host" },
				channel: "tui_e2e",
				print: true,
				plain: true,
				quiet: true,
				initialPrompt: "请只回复一个单词：PONG，不要包含任何其他内容。",
				// Absorb bootstrap/init chatter so it does not land on captured stdout;
				// the plain frontend writes the final answer straight to process.stdout.
				io: { log: () => {}, error: () => {} },
			});
		} finally {
			stdoutSpy.mockRestore();
		}

		const output = chunks.join("");
		expect(output.toUpperCase(), getE2ESkipReason() ?? undefined).toContain("PONG");

		// The terminal channel shares the DingTalk memory layout: workspace/<id>/.
		const channelDir = join(home.workspaceDir, "tui_e2e");
		expect(existsSync(join(channelDir, "SESSION.md"))).toBe(true);
		const logPath = join(channelDir, "log.jsonl");
		expect(existsSync(logPath)).toBe(true);
		// The incoming user message was archived, mirroring the DingTalk path.
		expect(readFileSync(logPath, "utf-8")).toContain("PONG");
	});
});
