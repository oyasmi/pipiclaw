import { describe, expect, it, vi } from "vitest";
import { parseTuiArgs, runTui } from "../src/tui/cli.js";

describe("parseTuiArgs", () => {
	it.each([
		[
			"with no args",
			[],
			{ kind: "run", channel: undefined, print: false, quiet: false, plain: false, positional: [] },
		],
		["--channel dm_42", ["--channel", "dm_42"], { channel: "dm_42" }],
		["--channel=dm_42", ["--channel=dm_42"], { channel: "dm_42" }],
		["--print -q --plain", ["--print", "-q", "--plain"], { kind: "run", print: true, quiet: true, plain: true }],
		["positional words", ["hello", "there"], { positional: ["hello", "there"] }],
	] as const)("parses %s", (_label, args, expected) => {
		expect(parseTuiArgs([...args])).toMatchObject(expected);
	});

	it("recognizes help and version", () => {
		expect(parseTuiArgs(["--help"])).toEqual({ kind: "help" });
		expect(parseTuiArgs(["-h"])).toEqual({ kind: "help" });
		expect(parseTuiArgs(["--version"])).toEqual({ kind: "version" });
	});

	it("rejects an unknown long option instead of treating it as a prompt", () => {
		expect(parseTuiArgs(["--pritn", "hello"])).toEqual({
			kind: "error",
			message: "Unknown option: --pritn",
		});
	});
});

describe("runTui", () => {
	it("prints help without starting the app", async () => {
		const log = vi.fn();
		await runTui(["node", "pipiclaw", "tui", "--help"], { log, error: vi.fn() });
		expect(log).toHaveBeenCalled();
		expect(log.mock.calls.flat().join("\n")).toContain("Usage: pipiclaw tui");
	});
});
