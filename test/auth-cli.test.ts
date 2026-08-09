import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseAuthArgs, runAuth } from "../src/models/auth-cli.js";
import { BootstrapExitError, type BootstrapPaths } from "../src/runtime/app-home.js";

describe("parseAuthArgs", () => {
	it("rejects a missing subcommand", () => {
		expect(parseAuthArgs([])).toEqual({ kind: "error", message: expect.stringContaining("Missing subcommand") });
	});

	it("parses --help and --version at the top level", () => {
		expect(parseAuthArgs(["--help"])).toEqual({ kind: "help" });
		expect(parseAuthArgs(["-h"])).toEqual({ kind: "help" });
		expect(parseAuthArgs(["--version"])).toEqual({ kind: "version" });
	});

	it("rejects an unknown subcommand", () => {
		expect(parseAuthArgs(["bogus"])).toEqual({ kind: "error", message: "Unknown subcommand: bogus" });
	});

	it.each([
		["status", { kind: "status" }],
		[
			"login",
			{ kind: "login", provider: undefined, apiKey: false, oauth: false, deviceCode: false, noBrowser: false },
		],
		["logout", { kind: "logout", provider: undefined, yes: false }],
	] as const)("parses %s with no arguments", (subcommand, expected) => {
		expect(parseAuthArgs([subcommand])).toEqual(expected);
	});

	// status/login/logout each parse their own `--help`/unknown-option branch inline (not through a
	// shared helper), so this table exercises all three independently rather than just once.
	it.each([
		["status", ["--help"], { kind: "help" }],
		["status", ["--bogus"], { kind: "error", message: "Unknown option: --bogus" }],
		["login", ["--bogus"], { kind: "error", message: "Unknown option: --bogus" }],
		["logout", ["--bogus"], { kind: "error", message: "Unknown option: --bogus" }],
	] as const)("dispatches %s %j through its per-subcommand option parsing", (subcommand, args, expected) => {
		expect(parseAuthArgs([subcommand, ...args])).toEqual(expected);
	});

	describe("login", () => {
		it.each([
			[
				"openai-codex",
				["--oauth", "--device-code", "--no-browser"],
				{ apiKey: false, oauth: true, deviceCode: true, noBrowser: true },
			],
			["anthropic", ["--api-key"], { apiKey: true, oauth: false, deviceCode: false, noBrowser: false }],
		] as const)("parses provider %s with flags %j", (provider, flags, flagExpectations) => {
			expect(parseAuthArgs(["login", provider, ...flags])).toEqual({
				kind: "login",
				provider,
				...flagExpectations,
			});
		});

		it("rejects --api-key combined with --oauth", () => {
			expect(parseAuthArgs(["login", "--api-key", "--oauth"])).toEqual({
				kind: "error",
				message: "--api-key and --oauth are mutually exclusive",
			});
		});
	});

	describe("logout", () => {
		it("parses a provider positional plus --yes", () => {
			expect(parseAuthArgs(["logout", "anthropic", "--yes"])).toEqual({
				kind: "logout",
				provider: "anthropic",
				yes: true,
			});
		});

		it("accepts -y as a short form of --yes", () => {
			expect(parseAuthArgs(["logout", "-y"])).toEqual({ kind: "logout", provider: undefined, yes: true });
		});
	});

	it.each(["login", "logout"] as const)("rejects more than one positional argument for %s", (subcommand) => {
		expect(parseAuthArgs([subcommand, "anthropic", "extra"])).toEqual({
			kind: "error",
			message: "Unexpected argument: extra",
		});
	});
});

describe("runAuth", () => {
	let home: string;
	let paths: BootstrapPaths;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "auth-cli-"));
		paths = {
			appName: "pipiclaw",
			appHomeDir: home,
			workspaceDir: join(home, "workspace"),
			authConfigPath: join(home, "auth.json"),
			channelConfigPath: join(home, "channel.json"),
			modelsConfigPath: join(home, "models.json"),
			settingsConfigPath: join(home, "settings.json"),
			toolsConfigPath: join(home, "tools.json"),
			securityConfigPath: join(home, "security.json"),
			eventHistoryPath: join(home, "state", "events", "history.jsonl"),
		};
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	function fakeIo() {
		const logs: string[] = [];
		const errors: string[] = [];
		return {
			log: (...args: unknown[]) => logs.push(args.join(" ")),
			error: (...args: unknown[]) => errors.push(args.join(" ")),
			logs,
			errors,
		};
	}

	it("exits 1 on a usage error, as a BootstrapExitError", async () => {
		const io = fakeIo();
		try {
			await runAuth(["node", "pipiclaw", "auth", "bogus"], io, paths);
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(BootstrapExitError);
			expect(error).toMatchObject({ code: 1 });
		}
		expect(io.errors.join("\n")).toContain("Unknown subcommand");
	});

	it("prints the auth.json path for `auth status`", async () => {
		const io = fakeIo();
		await runAuth(["node", "pipiclaw", "auth", "status"], io, paths);
		expect(io.logs.join("\n")).toContain(paths.authConfigPath);
	});

	it("rejects login/logout with exit code 1 when stdin is not a TTY", async () => {
		const io = fakeIo();
		const originalIsTTY = process.stdin.isTTY;
		Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
		try {
			await expect(runAuth(["node", "pipiclaw", "auth", "login"], io, paths)).rejects.toMatchObject({ code: 1 });
			expect(io.errors.join("\n")).toContain("interactive terminal");
		} finally {
			Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
		}
	});
});
