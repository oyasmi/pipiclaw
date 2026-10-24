import { describe, expect, it } from "vitest";
import { BootstrapExitError } from "../src/app/home.js";
import { runTui } from "../src/tui/cli.js";
import { useTempDirs } from "./helpers/fixtures.js";
import { bootstrapPathsIn } from "./support/fake-runner.js";

describe("pipiclaw tui startup", () => {
	const tempDir = useTempDirs();

	it("connects to a daemon that holds the app home, and says what to change when it has no socket", async () => {
		const errors: string[] = [];
		await expect(
			runTui(
				["node", "pipiclaw", "tui", "--print", "x"],
				{ startEmbeddedRuntime: async () => undefined },
				{ log: () => undefined, error: (...args: unknown[]) => void errors.push(args.join(" ")) },
				bootstrapPathsIn(tempDir()),
			),
		).rejects.toBeInstanceOf(BootstrapExitError);
		expect(errors.join("\n")).toMatch(/webapi/);
	});

	it("stops the runtime it started even when the client fails", async () => {
		let stopped = 0;
		await expect(
			runTui(
				["node", "pipiclaw", "tui", "--print", "x"],
				{ startEmbeddedRuntime: async () => ({ stop: async () => void stopped++ }) },
				{ log: () => undefined, error: () => undefined },
				// No socket was ever created here: the client cannot connect.
				bootstrapPathsIn(tempDir()),
			),
		).rejects.toThrow();
		expect(stopped).toBe(1);
	});
});
