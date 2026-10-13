import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startMockProvider } from "../../support/mock-provider/server.js";
import { cleanupE2ETestHome, createDeterministicHome, type E2ETestHome } from "../../support/setup.js";

/**
 * Catches --print bypassing dispatch and treating slash commands as model input (spec 048 F1).
 * Disk deletion also catches a nonempty error reply masquerading as successful dispatch.
 * Mutation check: bypass the event handler in commands/router.ts; the definition stays on disk.
 */
describe("E2E deterministic: terminal TUI (--print) command plane", () => {
	let model: Awaited<ReturnType<typeof startMockProvider>>;
	let home: E2ETestHome;
	const previousHome = process.env.PIPICLAW_HOME;
	const previousOffline = process.env.PI_OFFLINE;

	beforeEach(async () => {
		model = await startMockProvider();
		home = createDeterministicHome({ mockBaseUrl: model.baseUrl });
		// ChannelRunner resolves auth/models from paths.ts constants derived from
		// PIPICLAW_HOME at module load, so set it before importing the TUI app.
		process.env.PIPICLAW_HOME = home.homeDir;
		process.env.PI_OFFLINE = "1";
	});

	afterEach(async () => {
		const bad = model.unmatched();
		await model.close();
		cleanupE2ETestHome(home.homeDir);
		if (previousHome === undefined) delete process.env.PIPICLAW_HOME;
		else process.env.PIPICLAW_HOME = previousHome;
		if (previousOffline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = previousOffline;
		expect(bad, `mock provider received ${bad.length} unmatched request(s)`).toHaveLength(0);
	});

	it("resolves a built-in slash command under --print without invoking the model", async () => {
		const { runTuiApp } = await import("../../../src/tui/app.js");
		const eventPath = join(home.workspaceDir, "events", "tui-probe.json");
		writeFileSync(
			eventPath,
			JSON.stringify({
				type: "periodic",
				channelId: "tui_e2e_builtin",
				text: "probe",
				schedule: "0 9 * * 1",
			}),
		);

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
				initialPrompt: "/events delete tui-probe",
				io: { log: () => {}, error: () => {} },
			});
		} finally {
			stdoutSpy.mockRestore();
		}

		const out = chunks.join("").trim();
		expect(out.length).toBeGreaterThan(0);
		expect(existsSync(eventPath)).toBe(false);
		expect(model.requests).toHaveLength(0);
	});
});
