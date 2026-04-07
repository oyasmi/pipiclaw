import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
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

		const second = bootstrapAppHome(paths);
		expect(second.channelTemplateCreated).toBe(false);
		expect(second.created).toEqual([]);
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
		});
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
