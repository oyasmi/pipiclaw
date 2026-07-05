import { describe, expect, it, vi } from "vitest";
import { SandboxConfigError } from "../src/sandbox.js";
import { parseTuiArgs, runTui } from "../src/tui/cli.js";

describe("parseTuiArgs", () => {
	it("defaults to an interactive host-sandbox run", () => {
		expect(parseTuiArgs([])).toEqual({
			kind: "run",
			channel: undefined,
			sandbox: { type: "host" },
			print: false,
			quiet: false,
			plain: false,
			positional: [],
		});
	});

	it("parses --channel in both forms", () => {
		expect(parseTuiArgs(["--channel", "dm_42"])).toMatchObject({ channel: "dm_42" });
		expect(parseTuiArgs(["--channel=dm_42"])).toMatchObject({ channel: "dm_42" });
	});

	it("parses the sandbox and flags", () => {
		const parsed = parseTuiArgs(["--sandbox=docker:box", "--print", "-q", "--plain"]);
		expect(parsed).toMatchObject({
			kind: "run",
			sandbox: { type: "docker", container: "box" },
			print: true,
			quiet: true,
			plain: true,
		});
	});

	it("collects positional words as the initial prompt", () => {
		expect(parseTuiArgs(["hello", "there"])).toMatchObject({ positional: ["hello", "there"] });
	});

	it("recognizes help and version", () => {
		expect(parseTuiArgs(["--help"])).toEqual({ kind: "help" });
		expect(parseTuiArgs(["-h"])).toEqual({ kind: "help" });
		expect(parseTuiArgs(["--version"])).toEqual({ kind: "version" });
	});

	it("throws on an invalid sandbox spec", () => {
		expect(() => parseTuiArgs(["--sandbox", "bogus:"])).toThrow(SandboxConfigError);
	});
});

describe("runTui", () => {
	it("prints help without starting the app", async () => {
		const log = vi.fn();
		await runTui(["node", "pipiclaw", "tui", "--help"], { log, error: vi.fn() });
		expect(log).toHaveBeenCalled();
		expect(log.mock.calls.flat().join("\n")).toContain("Usage: pipiclaw tui");
	});

	it("prints the version", async () => {
		const log = vi.fn();
		await runTui(["node", "pipiclaw", "tui", "--version"], { log, error: vi.fn() });
		expect(log).toHaveBeenCalledTimes(1);
	});
});
