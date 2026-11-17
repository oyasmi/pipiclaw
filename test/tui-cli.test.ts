import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BootstrapExitError } from "../src/app/home.js";
import { initializeBindings } from "../src/desk/bindings.js";
import { createDeskRecord } from "../src/desk/registry.js";
import { parseTuiArgs, runTui } from "../src/tui/cli.js";
import { openConversation } from "../src/tui/client.js";
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

		// `--here` parsing, conflict rejection, and deterministic repository desk resolution.
		expect(parseTuiArgs(["--here"])).toMatchObject({ kind: "run", here: true });
		expect(parseTuiArgs(["--here", "--desk", "x"]).kind).toBe("error");
		expect(parseTuiArgs(["--here", "--cwd", "."]).kind).toBe("error");

		const herePaths = bootstrapPathsIn(tempDir());
		initializeBindings(herePaths.workspaceDir);
		const repoA = join(tempDir(), "My-Service");
		const repoCollide = join(tempDir(), "other", "My-Service");
		mkdirSync(repoA, { recursive: true });
		mkdirSync(repoCollide, { recursive: true });
		const sentCommands: string[] = [];
		const fakeClient = {
			conversations: {
				create: async () => ({ id: "conv_here_1" }),
				retrieve: async () => ({ id: "conv_here_1" }),
			},
			responses: {
				create: async ({ input }: { input: string }) => {
					sentCommands.push(input);
					if (input.startsWith("/desk new ")) {
						const [, , name, cwd] = input.split(" ");
						createDeskRecord(herePaths.workspaceDir, name!, new Date(), cwd);
					}
					if (input.startsWith("/desk bind ")) {
						const name = input.slice("/desk bind ".length).trim();
						writeFileSync(
							join(herePaths.workspaceDir, "desk-bindings.json"),
							JSON.stringify({
								version: 1,
								bindings: { "webapi:conv_here_1": { desk: name, boundAt: new Date().toISOString() } },
							}),
						);
					}
					return { status: "completed", output_text: "ok" };
				},
			},
		} as never;
		const opened = await openConversation(
			fakeClient,
			herePaths,
			{ here: true, hereDir: repoA, create: false, fresh: false },
			{ log: () => undefined, error: () => undefined },
		);
		expect(opened.desk).toBe("my-service");
		expect(sentCommands).toEqual([`/desk new my-service ${repoA}`, "/desk bind my-service"]);
		// A second directory with the same basename (`My-Service`) refuses to silently clobber `my-service`.
		await expect(
			openConversation(
				fakeClient,
				herePaths,
				{ here: true, hereDir: repoCollide, create: false, fresh: false },
				{ log: () => undefined, error: () => undefined },
			),
		).rejects.toBeInstanceOf(BootstrapExitError);
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
