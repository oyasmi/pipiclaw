import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BootstrapPaths } from "../../../src/app/home.js";
import { createDesk } from "../../../src/desk/registry.js";
import type { Frontend, FrontendCallbacks } from "../../../src/tui/frontend.js";
import { reply } from "../../support/mock-provider/script.js";
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
	let paths: BootstrapPaths;
	const previousHome = process.env.PIPICLAW_HOME;
	const previousOffline = process.env.PI_OFFLINE;

	beforeEach(async () => {
		model = await startMockProvider();
		home = createDeterministicHome({ mockBaseUrl: model.baseUrl });
		paths = {
			appName: "pipiclaw",
			appHomeDir: home.homeDir,
			workspaceDir: home.workspaceDir,
			authConfigPath: join(home.homeDir, "auth.json"),
			channelConfigPath: join(home.homeDir, "channel.json"),
			modelsConfigPath: join(home.homeDir, "models.json"),
			settingsConfigPath: join(home.homeDir, "settings.json"),
			toolsConfigPath: join(home.homeDir, "tools.json"),
			securityConfigPath: join(home.homeDir, "security.json"),
			eventHistoryPath: join(home.homeDir, "state/events/history.jsonl"),
		};
		// ChannelRunner resolves auth/models from paths.ts constants derived from
		// PIPICLAW_HOME at module load, so set it before importing the TUI app.
		process.env.PIPICLAW_HOME = home.homeDir;
		process.env.PI_OFFLINE = "1";
	});

	afterEach(async () => {
		vi.restoreAllMocks();
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
		// Mutation (2026-10-23): requiring --desk prevents deletion of the default event.
		// Events belong to the desk the terminal opens (spec 058, D14, D18).
		await createDesk(home.workspaceDir, "default", new Date());
		await createDesk(home.workspaceDir, "another", new Date());
		mkdirSync(join(home.workspaceDir, "desk-default", "events"), { recursive: true });
		const eventPath = join(home.workspaceDir, "desk-default", "events", "tui-probe.json");
		writeFileSync(
			eventPath,
			JSON.stringify({
				type: "periodic",
				channelId: "tui",
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
				paths,
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

	it("starts a new terminal session while the outgoing provider remains held", async () => {
		// Catches the TUI busy-command refusal swallowing the emergency /new boundary.
		// Mutation (2026-10-22): remove the early /new route; no active-session ref is committed and this case fails.
		const renderer = await import("../../../src/tui/renderer.js");
		const { runTuiApp } = await import("../../../src/tui/app.js");
		await createDesk(home.workspaceDir, "tui-e2e", new Date());
		let callbacks!: FrontendCallbacks;
		let ready!: () => void;
		const started = new Promise<void>((resolve) => {
			ready = resolve;
		});
		let replied!: () => void;
		const resetReply = new Promise<void>((resolve) => {
			replied = resolve;
		});
		const frontend: Frontend = {
			start: (value) => {
				callbacks = value;
				ready();
			},
			appendProgress() {},
			showFinal: () => replied(),
			showNotice() {},
			clearProgress() {},
			setWorking() {},
			setStatus() {},
			setBusy() {},
			showBanner() {},
			stop() {},
		};
		vi.spyOn(renderer, "createFrontend").mockReturnValue(frontend);
		model.script.route({
			name: "turn",
			when: (request) => request.isMainTurn,
			respond: [reply.text("done")],
			repeat: true,
		});
		const old = model.script.hold({
			when: (request) => request.isMainTurn && request.lastUserText.includes("OLD_TERMINAL"),
		});
		const fresh = model.script.hold({
			when: (request) => request.isMainTurn && request.lastUserText.includes("NEW_TERMINAL"),
		});
		const app = runTuiApp({ paths, desk: "tui-e2e", plain: true, io: { log() {}, error() {} } });
		try {
			await Promise.race([started, app]);
			callbacks.onSubmit("OLD_TERMINAL");
			await old.arrived;
			callbacks.onSubmit("/new");
			await resetReply;
			const reference = join(home.workspaceDir, "desk-tui-e2e/conversations/tui-1/active-session.json");
			expect(existsSync(reference)).toBe(true);
			callbacks.onSubmit("NEW_TERMINAL");
			const request = await fresh.arrived;
			expect(JSON.stringify(request.messages)).not.toContain("OLD_TERMINAL");
		} finally {
			old.release();
			fresh.release();
			callbacks?.onEof();
			await app;
		}
	});
});
