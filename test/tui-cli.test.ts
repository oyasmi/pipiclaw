import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BootstrapExitError } from "../src/app/home.js";
import { runTui } from "../src/tui/cli.js";
import { useTempDirs } from "./helpers/fixtures.js";
import { bootstrapPathsIn } from "./support/fake-runner.js";

describe("pipiclaw tui startup", () => {
	const tempDir = useTempDirs();

	it("connects to a daemon that holds the app home, and says what to change when it has no socket", async () => {
		const errors: string[] = [];
		const paths = bootstrapPathsIn(tempDir());
		mkdirSync(join(paths.appHomeDir, "state"), { recursive: true });
		writeFileSync(
			join(paths.appHomeDir, "state", "daemon.lock"),
			JSON.stringify({ pid: 4242, startedAt: "2026-11-15T10:00:00Z" }),
		);
		await expect(
			runTui(
				["node", "pipiclaw", "tui", "--print", "x"],
				{ startEmbeddedRuntime: async () => undefined },
				{ log: () => undefined, error: (...args: unknown[]) => void errors.push(args.join(" ")) },
				paths,
			),
		).rejects.toBeInstanceOf(BootstrapExitError);
		expect(errors.join("\n")).toMatch(/webapi/);
		expect(errors.join("\n")).toContain("PID 4242");
	});

	it("stops the runtime it started even when the client fails, and offers interactive login when no model credentials exist", async () => {
		const prevAnthropic = process.env.ANTHROPIC_API_KEY;
		const prevOpenAI = process.env.OPENAI_API_KEY;
		delete process.env.ANTHROPIC_API_KEY;
		delete process.env.OPENAI_API_KEY;
		let stopped = 0;
		let loginPrompted = 0;
		try {
			await expect(
				runTui(
					["node", "pipiclaw", "tui"],
					{
						startEmbeddedRuntime: async () => ({ stop: async () => void stopped++ }),
						interactive: true,
						confirmModelLogin: async () => true,
						performModelLogin: async () => {
							loginPrompted++;
						},
					},
					{ log: () => undefined, error: () => undefined },
					// No socket was ever created here: the client cannot connect after login finishes.
					bootstrapPathsIn(tempDir()),
				),
			).rejects.toThrow();
			expect(loginPrompted).toBe(1);
			expect(stopped).toBe(1);
		} finally {
			if (prevAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = prevAnthropic;
			if (prevOpenAI !== undefined) process.env.OPENAI_API_KEY = prevOpenAI;
		}
	});
});
