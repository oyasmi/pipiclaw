import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	BootstrapExitError,
	type BootstrapIO,
	type BootstrapPaths,
	bootstrap,
	bootstrapAppHome,
	loadConfig,
	parseArgs,
} from "../src/runtime/bootstrap.js";
import { ChannelStore } from "../src/runtime/store.js";

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pipiclaw-bootstrap-"));
	tempDirs.push(dir);
	return dir;
}

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
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
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

	it("rejects an invalid --sandbox argument with exit code 1", () => {
		const paths = createBootstrapPaths();
		const io = createIO();

		expect(() => parseArgs(["node", "main", "--sandbox=weird"], paths, io)).toThrowError(BootstrapExitError);
		try {
			parseArgs(["node", "main", "--sandbox=weird"], paths, io);
		} catch (error) {
			expect((error as BootstrapExitError).code).toBe(1);
		}
		expect(io.error).toHaveBeenCalledWith(expect.stringContaining("Invalid sandbox type"));
	});

	it("parses help and exits with code 0", () => {
		const paths = createBootstrapPaths();
		const io = createIO();

		expect(() => parseArgs(["node", "main", "--help"], paths, io)).toThrowError(BootstrapExitError);
		try {
			parseArgs(["node", "main", "--help"], paths, io);
		} catch (error) {
			expect(error).toBeInstanceOf(BootstrapExitError);
			expect((error as BootstrapExitError).code).toBe(0);
		}
		expect(io.log).toHaveBeenCalledWith("Options:");
		expect(io.log).toHaveBeenCalledWith("  --version                   Print the current version and exit");
	});

	it("parses version and exits with code 0", () => {
		const paths = createBootstrapPaths();
		const io = createIO();

		expect(() => parseArgs(["node", "main", "--version"], paths, io)).toThrowError(BootstrapExitError);
		try {
			parseArgs(["node", "main", "--version"], paths, io);
		} catch (error) {
			expect(error).toBeInstanceOf(BootstrapExitError);
			expect((error as BootstrapExitError).code).toBe(0);
		}
		expect(io.log).toHaveBeenCalledWith(
			expect.stringMatching(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/),
		);
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

	it("rejects invalid response mode during config loading", () => {
		const paths = createBootstrapPaths();
		const io = createIO();
		writeFileSync(
			paths.channelConfigPath,
			JSON.stringify(
				{
					clientId: "client-id",
					clientSecret: "secret",
					responseMode: "final_only",
				},
				null,
				2,
			),
		);

		expect(() => loadConfig(paths, io)).toThrowError(BootstrapExitError);
		expect(io.error).toHaveBeenCalledWith(
			'  - Invalid `responseMode`: expected "full_progress_then_plain_final", "rolling_progress_then_plain_final", or "final_card_only".',
		);
	});

	it("rejects invalid cardAutoLayout during config loading", () => {
		const paths = createBootstrapPaths();
		const io = createIO();
		writeFileSync(
			paths.channelConfigPath,
			JSON.stringify(
				{
					clientId: "client-id",
					clientSecret: "secret",
					cardAutoLayout: "true",
				},
				null,
				2,
			),
		);

		expect(() => loadConfig(paths, io)).toThrowError(BootstrapExitError);
		expect(io.error).toHaveBeenCalledWith("  - Invalid `cardAutoLayout`: expected boolean.");
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

	it("does not sanitize proxy environment variables during bootstrap", async () => {
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
		const env = { ...process.env, HTTP_PROXY: "http://127.0.0.1:7890" };

		const app = await bootstrap(["node", "main"], {
			paths,
			registerSignalHandlers: false,
			startServices: false,
			env,
		});

		expect(env.HTTP_PROXY).toBe("http://127.0.0.1:7890");
		await app.shutdown();
	});
});
