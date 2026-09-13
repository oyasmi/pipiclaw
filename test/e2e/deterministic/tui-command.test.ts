import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startMockProvider } from "../../support/mock-provider/server.js";
import { cleanupE2ETestHome, createDeterministicHome, type E2ETestHome } from "../../support/setup.js";

/**
 * A2 (terminal transport variant, spec 048). The DingTalk-harness A2 in
 * commands.test.ts proves `/tasks` resolves zero-LLM through `dispatch()`.
 * This proves the same for the terminal `--print` path specifically, because
 * `runOnce()` (the --print path) used to call `beginTurn()` directly, skipping
 * `dispatch()` entirely — a built-in slash command like `/tasks` was sent to
 * the model as plain text instead of resolving zero-LLM through the same
 * transport-layer handler the DingTalk runtime and interactive TUI use
 * (spec 048 F1). Moved from the live layer (048 P1 note: "the proper zero-LLM
 * proof arrives with the mock provider") — it needs no real model, so it
 * belongs here, not gated behind local credentials.
 *
 * Mutation check: in `processSubmit` (turn-controller.ts), replace the
 * `dispatch()` call with a direct `this.deps.runner.beginTurn(text)` and this
 * goes red — `runOnce()` returns before the (now async, unawaited) turn
 * produces any stdout, so `out.length` is 0.
 */
describe("E2E deterministic: terminal TUI (--print) command plane", () => {
	let model: Awaited<ReturnType<typeof startMockProvider>>;
	let home: E2ETestHome;
	const previousHome = process.env.PIPICLAW_HOME;

	beforeEach(async () => {
		model = await startMockProvider();
		home = createDeterministicHome({ mockBaseUrl: model.baseUrl });
		// ChannelRunner resolves auth/models from paths.ts constants derived from
		// PIPICLAW_HOME at module load, so set it before importing the TUI app.
		process.env.PIPICLAW_HOME = home.homeDir;
	});

	afterEach(async () => {
		const bad = model.unmatched();
		await model.close();
		cleanupE2ETestHome(home.homeDir);
		if (previousHome === undefined) delete process.env.PIPICLAW_HOME;
		else process.env.PIPICLAW_HOME = previousHome;
		expect(bad, `mock provider received ${bad.length} unmatched request(s)`).toHaveLength(0);
	});

	it("resolves a built-in slash command under --print without invoking the model", async () => {
		const { runTuiApp } = await import("../../../src/tui/app.js");

		const chunks: string[] = [];
		const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
			chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
			return true;
		});

		try {
			await runTuiApp({
				channel: "tui_e2e_builtin",
				print: true,
				plain: true,
				quiet: true,
				initialPrompt: "/tasks",
				io: { log: () => {}, error: () => {} },
			});
		} finally {
			stdoutSpy.mockRestore();
		}

		const out = chunks.join("").trim();
		expect(out.length).toBeGreaterThan(0);
		expect(out).not.toContain("命令执行失败");
		expect(out).toContain("暂无");
		expect(model.requests).toHaveLength(0);
	});
});
