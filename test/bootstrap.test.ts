import { chmodSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	BootstrapExitError,
	type BootstrapIO,
	type BootstrapPaths,
	bootstrapAppHome,
	parseArgs,
} from "../src/app/home.js";
import { prepareAppServices } from "../src/app/services.js";
import { createModelRuntime } from "../src/models/runtime.js";
import { bootstrap } from "../src/runtime/bootstrap.js";
import { authenticate } from "../src/webapi/auth.js";
import { parseWebApiConfig } from "../src/webapi/config.js";
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
	it("routes CLI arguments: bare/run invocations, --help listing, and unknown-option rejection", () => {
		const paths = createBootstrapPaths();
		expect(() => parseArgs(["node", "pipiclaw"], paths, createIO())).not.toThrow();
		expect(() => parseArgs(["node", "pipiclaw", "run"], paths, createIO())).not.toThrow();

		const helpIo = createIO();
		expect(() => parseArgs(["node", "pipiclaw", "--help"], paths, helpIo)).toThrow(BootstrapExitError);
		const help = helpIo.log.mock.calls.flat().join("\n");
		expect(help).toContain("run");
		expect(help).toContain("tui");
		expect(help).toContain("auth");

		const io = createIO();
		try {
			parseArgs(["node", "pipiclaw", "--bogus"], paths, io);
			throw new Error("expected parseArgs to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(BootstrapExitError);
			expect((err as BootstrapExitError).code).toBe(1);
		}
		expect(io.error).toHaveBeenCalledWith("未知参数：--bogus");
	});
});

describe("bootstrap", () => {
	it("starts out of the box with Web API enabled + a generated default key, prompts login when interactive without credentials, and refuses unfilled DingTalk placeholders when enabled", async () => {
		const paths = createBootstrapPaths();
		const io = createIO();
		const prevAnthropic = process.env.ANTHROPIC_API_KEY;
		const prevOpenAI = process.env.OPENAI_API_KEY;
		delete process.env.ANTHROPIC_API_KEY;
		delete process.env.OPENAI_API_KEY;

		try {
			let loginRan = 0;
			const app = await bootstrap(["node", "pipiclaw"], {
				paths,
				io,
				registerSignalHandlers: false,
				startServices: false,
				interactive: true,
				confirmModelLogin: async () => true,
				performModelLogin: async () => {
					loginRan += 1;
				},
			});
			await app.shutdown();

			expect(loginRan).toBe(1);
			const logged = io.log.mock.calls.flat().join("\n");
			const printedKey = logged
				.split("\n")
				.map((line) => line.trim())
				.find((line) => line.startsWith("pk_"));
			expect(printedKey).toBeDefined();

			const channelConfig = JSON.parse(readFileSync(paths.channelConfigPath, "utf8"));
			expect(channelConfig.dingtalk).toMatchObject({
				enabled: false,
				robotCode: "",
				cardTemplateId: "",
				allowFrom: [],
			});
			expect(channelConfig.webapi).toMatchObject({
				enabled: true,
				socket: true,
				tcp: "127.0.0.1:8787",
				tls: null,
			});
			const parsedWebApi = parseWebApiConfig(channelConfig.webapi);
			expect(authenticate(`Bearer ${printedKey}`, parsedWebApi.keys)).toMatchObject({
				name: "default",
				desks: ["default"],
				local: false,
			});

			// Enabling DingTalk without filling real credentials still refuses cleanly with exit code 1.
			channelConfig.dingtalk.enabled = true;
			writeFileSync(paths.channelConfigPath, JSON.stringify(channelConfig, null, 2));
			await expect(
				bootstrap(["node", "pipiclaw"], {
					paths,
					io: createIO(),
					registerSignalHandlers: false,
					startServices: false,
				}),
			).rejects.toMatchObject({ code: 1 });
		} finally {
			if (prevAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = prevAnthropic;
			if (prevOpenAI !== undefined) process.env.OPENAI_API_KEY = prevOpenAI;
		}
	});

	it("creates self-documenting app home templates and leaves an idempotent second run", async () => {
		const paths = createBootstrapPaths();

		const first = bootstrapAppHome(paths);
		expect(first.channelTemplateCreated).toBe(true);
		expect(first.initialWebApiKey).toMatch(/^pk_/);
		expect(existsSync(paths.channelConfigPath)).toBe(true);
		expect(existsSync(paths.toolsConfigPath)).toBe(true);
		expect(JSON.parse(readFileSync(paths.toolsConfigPath, "utf8"))).toMatchObject({
			tools: { web: { enable: false, search: { provider: "duckduckgo" } } },
		});
		expect(JSON.parse(readFileSync(paths.settingsConfigPath, "utf8"))).toMatchObject({
			defaultThinkingLevel: "medium",
			compaction: { enabled: true },
		});
		const modelRuntime = await createModelRuntime({
			authConfigPath: paths.authConfigPath,
			modelsConfigPath: paths.modelsConfigPath,
		});
		expect(modelRuntime.getError()).toBeUndefined();
		expect(existsSync(paths.securityConfigPath)).toBe(true);
		expect(existsSync(join(paths.workspaceDir, "SOUL.md"))).toBe(true);
		expect(existsSync(join(paths.workspaceDir, "AGENTS.md"))).toBe(true);
		expect(existsSync(join(paths.workspaceDir, "MEMORY.md"))).toBe(true);
		expect(existsSync(join(paths.workspaceDir, "ENVIRONMENT.md"))).toBe(true);

		const deskPath = join(paths.workspaceDir, "desk-default", "desk.json");
		const record = readFileSync(deskPath, "utf8");
		expect(JSON.parse(record)).toMatchObject({ name: "default", conversations: {} });
		const second = bootstrapAppHome(paths);
		expect(second.channelTemplateCreated).toBe(false);
		expect(second.created).toEqual([]);
		expect(readFileSync(deskPath, "utf8")).toBe(record);
		// An existing broken identity is an operator repair, never an empty replacement.
		writeFileSync(deskPath, "{broken");
		bootstrapAppHome(paths);
		expect(readFileSync(deskPath, "utf8")).toBe("{broken");
		rmSync(join(paths.workspaceDir, "desk-default"), { recursive: true });
		writeFileSync(
			join(paths.workspaceDir, "desk-bindings.json"),
			JSON.stringify({ version: 1, bindings: { "dingtalk:dm:1": { desk: "default", boundAt: "2026-10-23" } } }),
		);
		bootstrapAppHome(paths);
		expect(existsSync(deskPath)).toBe(false);
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
});

describe("prepareAppServices", () => {
	const originalProxyEnv = process.env.PIPICLAW_PROXY;

	afterEach(() => {
		if (originalProxyEnv === undefined) delete process.env.PIPICLAW_PROXY;
		else process.env.PIPICLAW_PROXY = originalProxyEnv;
	});

	it("installs the LLM proxy dispatcher when PIPICLAW_PROXY is set", () => {
		const paths = createBootstrapPaths();
		bootstrapAppHome(paths);
		const originalDispatcher = getGlobalDispatcher();
		process.env.PIPICLAW_PROXY = "http://127.0.0.1:65535";

		try {
			prepareAppServices(paths);
			expect(getGlobalDispatcher()).not.toBe(originalDispatcher);
		} finally {
			setGlobalDispatcher(originalDispatcher);
		}
	});
});
