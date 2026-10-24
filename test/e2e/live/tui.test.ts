import { existsSync } from "fs";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bootstrapPathsIn } from "../../support/fake-runner.js";
import {
	canRunE2E,
	cleanupE2ETestHome,
	createE2ETestHome,
	type E2ETestHome,
	getE2ESkipReason,
} from "../../support/setup.js";

const describeE2E = canRunE2E() ? describe : describe.skip;

// Unlike the other e2e specs (which drive the runtime through a fake DingTalk bot), this one runs
// the real `pipiclaw tui --print` path: the terminal starts the runtime itself, asks over the Web
// API socket, and a live model's answer reaches stdout.
describeE2E("E2E: terminal TUI (--print)", () => {
	let home: E2ETestHome;

	beforeAll(() => {
		home = createE2ETestHome();
		// paths.ts derives its constants from PIPICLAW_HOME at module load, so set it before importing the runtime.
		process.env.PIPICLAW_HOME = home.homeDir;
	});

	afterAll(() => {
		cleanupE2ETestHome(home.homeDir);
	});

	it("answers a one-shot prompt through the Web API socket and creates the desk", async () => {
		const [{ runTui }, { bootstrapEmbedded }] = await Promise.all([
			import("../../../src/tui/cli.js"),
			import("../../../src/runtime/bootstrap.js"),
		]);

		const chunks: string[] = [];
		const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
			chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
			return true;
		});

		try {
			await runTui(
				[
					"node",
					"pipiclaw",
					"tui",
					"--desk",
					"tui-e2e",
					"--create",
					"--print",
					"--plain",
					"--quiet",
					"请只回复一个单词：PONG，不要包含任何其他内容。",
				],
				{ startEmbeddedRuntime: bootstrapEmbedded },
				{ log: () => {}, error: () => {} },
				bootstrapPathsIn(home.homeDir),
			);
		} finally {
			stdoutSpy.mockRestore();
		}

		expect(chunks.join("").toUpperCase(), getE2ESkipReason() ?? undefined).toContain("PONG");
		expect(existsSync(join(home.workspaceDir, "desk-tui-e2e", "desk.json"))).toBe(true);
	});
});
