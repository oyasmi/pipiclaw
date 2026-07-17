import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	BootstrapExitError,
	type BootstrapIO,
	type BootstrapPaths,
	bootstrap,
	bootstrapAppHome,
	loadConfig,
	migrateLegacyAppHome,
	parseArgs,
} from "../src/runtime/bootstrap.js";
import { ChannelStore } from "../src/runtime/store.js";
import { useTempDirs } from "./helpers/fixtures.js";

const createTempDir = useTempDirs("pipiclaw-bootstrap-");

function createBootstrapPaths(): BootstrapPaths {
	const appHomeDir = createTempDir();
	const workspaceDir = join(appHomeDir, "workspace");
	return {
		appName: "pipiclaw",
		appHomeDir,
		workspaceDir,
		authConfigPath: join(appHomeDir, "auth.json"),
		channelConfigPath: join(appHomeDir, "channel.json"),
		modelsConfigPath: join(appHomeDir, "models.json"),
		settingsConfigPath: join(appHomeDir, "settings.json"),
		toolsConfigPath: join(appHomeDir, "tools.json"),
		securityConfigPath: join(appHomeDir, "security.json"),
		eventHistoryPath: join(appHomeDir, "state", "events", "history.jsonl"),
	};
}

function createIO() {
	return {
		log: vi.fn(),
		error: vi.fn(),
	} satisfies BootstrapIO;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("parseArgs", () => {
	it("accepts a bare invocation and an explicit `run` token", () => {
		const paths = createBootstrapPaths();
		expect(() => parseArgs(["node", "pipiclaw"], paths, createIO())).not.toThrow();
		expect(() => parseArgs(["node", "pipiclaw", "run"], paths, createIO())).not.toThrow();
	});

	it("rejects an unknown option with a non-zero exit", () => {
		const paths = createBootstrapPaths();
		const io = createIO();
		try {
			parseArgs(["node", "pipiclaw", "--bogus"], paths, io);
			throw new Error("expected parseArgs to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(BootstrapExitError);
			expect((err as BootstrapExitError).code).toBe(1);
		}
		expect(io.error).toHaveBeenCalledWith("Unknown option: --bogus");
	});

	it("lists both commands in --help", () => {
		const paths = createBootstrapPaths();
		const io = createIO();
		expect(() => parseArgs(["node", "pipiclaw", "--help"], paths, io)).toThrow(BootstrapExitError);
		const help = io.log.mock.calls.flat().join("\n");
		expect(help).toContain("run");
		expect(help).toContain("tui");
	});
});

describe("bootstrap", () => {
	it("creates app home templates and leaves an idempotent second run", () => {
		const paths = createBootstrapPaths();

		const first = bootstrapAppHome(paths);
		expect(first.channelTemplateCreated).toBe(true);
		expect(existsSync(paths.channelConfigPath)).toBe(true);
		expect(existsSync(paths.toolsConfigPath)).toBe(true);
		expect(existsSync(paths.securityConfigPath)).toBe(true);
		expect(existsSync(join(paths.workspaceDir, "SOUL.md"))).toBe(true);
		expect(existsSync(join(paths.workspaceDir, "AGENTS.md"))).toBe(true);
		expect(existsSync(join(paths.workspaceDir, "MEMORY.md"))).toBe(true);
		expect(existsSync(join(paths.workspaceDir, "ENVIRONMENT.md"))).toBe(true);
		expect(readFileSync(paths.toolsConfigPath, "utf-8")).toContain('"enable": false');
		expect(readFileSync(paths.toolsConfigPath, "utf-8")).toContain('"provider": "brave"');
		expect(readFileSync(paths.toolsConfigPath, "utf-8")).toContain('"maxResults": 5');
		expect(readFileSync(paths.toolsConfigPath, "utf-8")).toContain('"proxy": "http://127.0.0.1:7890"');
		expect(readFileSync(paths.toolsConfigPath, "utf-8")).toContain('"apiKey": "BSA..."');
		expect(readFileSync(paths.securityConfigPath, "utf-8")).toContain('"enabled": false');
		expect(readFileSync(paths.channelConfigPath, "utf-8")).toContain('"busyMessageDefault": "steer"');
		expect(readFileSync(paths.channelConfigPath, "utf-8")).toContain(
			'"responseMode": "full_progress_then_plain_final"',
		);
		expect(readFileSync(paths.channelConfigPath, "utf-8")).toContain('"cardAutoLayout": true');

		const second = bootstrapAppHome(paths);
		expect(second.channelTemplateCreated).toBe(false);
		expect(second.created).toEqual([]);
	});

	it("creates secret config files owner-only and tightens loose ones", () => {
		const paths = createBootstrapPaths();

		bootstrapAppHome(paths);

		for (const secretPath of [
			paths.channelConfigPath,
			paths.authConfigPath,
			paths.modelsConfigPath,
			paths.settingsConfigPath,
			paths.toolsConfigPath,
			paths.securityConfigPath,
		]) {
			expect(statSync(secretPath).mode & 0o777, `mode for ${secretPath}`).toBe(0o600);
		}

		// A pre-existing loose file is tightened on the next bootstrap.
		chmodSync(paths.authConfigPath, 0o644);
		bootstrapAppHome(paths);
		expect(statSync(paths.authConfigPath).mode & 0o777).toBe(0o600);
	});

	it("loads and normalizes a ready DingTalk config", () => {
		const paths = createBootstrapPaths();
		writeFileSync(
			paths.channelConfigPath,
			JSON.stringify(
				{
					clientId: "client-id",
					clientSecret: "secret",
					robotCode: "",
					allowFrom: ["alice", " ", "bob"],
					busyMessageDefault: "followup",
					responseMode: "rolling_progress_then_plain_final",
				},
				null,
				2,
			),
		);

		expect(loadConfig(paths)).toMatchObject({
			clientId: "client-id",
			clientSecret: "secret",
			robotCode: "client-id",
			cardTemplateKey: "content",
			allowFrom: ["alice", "bob"],
			busyMessageDefault: "followUp",
			responseMode: "rolling_progress_then_plain_final",
			cardAutoLayout: true,
		});
	});

	it("rejects invalid busy message defaults during config loading", () => {
		const paths = createBootstrapPaths();
		const io = createIO();
		writeFileSync(
			paths.channelConfigPath,
			JSON.stringify(
				{
					clientId: "client-id",
					clientSecret: "secret",
					busyMessageDefault: "follow-up",
				},
				null,
				2,
			),
		);

		expect(() => loadConfig(paths, io)).toThrowError(BootstrapExitError);
		expect(io.error).toHaveBeenCalledWith(
			'  - Invalid `busyMessageDefault`: expected "steer", "followUp", or "followup".',
		);
	});

	// FIXME(0.9.0): remove with the legacy `~/.pi/pipiclaw` -> `~/.pipiclaw` migration.
	it("moves a legacy app home to the new default when the target is missing", () => {
		const legacyDir = createTempDir();
		const targetDir = join(createTempDir(), "new-home");
		writeFileSync(join(legacyDir, "channel.json"), '{"clientId":"legacy"}');
		const io = createIO();

		expect(migrateLegacyAppHome(targetDir, legacyDir, io)).toBe(true);
		expect(existsSync(legacyDir)).toBe(false);
		expect(readFileSync(join(targetDir, "channel.json"), "utf-8")).toContain("legacy");
		expect(io.log).toHaveBeenCalledWith(expect.stringContaining("Migrated existing data"));
	});

	it("does not migrate when the new home already exists or no legacy home is present", () => {
		const existingTarget = createTempDir();
		const legacyDir = createTempDir();
		writeFileSync(join(legacyDir, "channel.json"), "{}");
		// Target already exists -> no move, legacy left untouched.
		expect(migrateLegacyAppHome(existingTarget, legacyDir, createIO())).toBe(false);
		expect(existsSync(join(legacyDir, "channel.json"))).toBe(true);

		// No legacy dir -> nothing to move.
		const freshTarget = join(createTempDir(), "fresh");
		mkdirSync(freshTarget, { recursive: true });
		expect(migrateLegacyAppHome(join(freshTarget, "sub"), join(freshTarget, "absent"), createIO())).toBe(false);
	});

	it("bootstraps without starting services when requested", async () => {
		const paths = createBootstrapPaths();
		bootstrapAppHome(paths);
		writeFileSync(
			paths.channelConfigPath,
			JSON.stringify(
				{
					clientId: "client-id",
					clientSecret: "secret",
					robotCode: "",
					cardTemplateId: "",
					cardTemplateKey: "content",
					allowFrom: [],
				},
				null,
				2,
			),
		);
		const app = await bootstrap(["node", "main"], {
			paths,
			registerSignalHandlers: false,
			startServices: false,
			env: { ...process.env },
		});

		expect(app.store).toBeInstanceOf(ChannelStore);
		expect(readFileSync(paths.channelConfigPath, "utf-8")).toContain('"clientId": "client-id"');

		await expect(app.shutdown()).resolves.toBeUndefined();
	});
});
