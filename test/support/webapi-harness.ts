import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import net, { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import OpenAI from "openai";
import { ResponsesWS } from "openai/resources/responses/ws";
import { Agent, fetch as undiciFetch } from "undici";
import { createDeskRecord } from "../../src/desk/registry.js";
import { generateKey, hashKey } from "../../src/webapi/auth.js";
import type { WebApiConfig } from "../../src/webapi/config.js";
import { WebApiTransport } from "../../src/webapi/transport.js";
import { waitFor } from "../e2e/helpers/wait.js";
import type { CapturedRequest } from "./mock-provider/script.js";
import { startMockProvider } from "./mock-provider/server.js";
import { cleanupE2ETestHome, createDeterministicHome } from "./setup.js";

export { reply } from "./mock-provider/script.js";

/** The desk a key (and the harness's socket conversations) works in. */
export const WEBAPI_DESK = "e2e";

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as net.AddressInfo;
			server.close(() => resolve(port));
		});
	});
}

export interface WebApiHarness {
	homeDir: string;
	workspaceDir: string;
	stateDir: string;
	socketPath: string;
	port: number;
	/** The bearer key the TCP listener accepts. */
	key: string;
	runtime: import("../../src/runtime/bootstrap.js").RuntimeContext;
	model: import("./mock-provider/server.js").MockProvider;
	/** The official SDK over loopback TCP with the key. */
	tcp: OpenAI;
	/** The official SDK over the local unix socket (no key). */
	socket: OpenAI;
	/** A WebSocket-mode connection, over TCP with the key or over the socket. */
	openWebSocket(over?: "tcp" | "socket"): ResponsesWS;
	/** Wait until the runtime has no queued or running turn and every response has ended. */
	waitForIdle(): Promise<void>;
	mainTurnRequests(): CapturedRequest[];
	/** Shut the runtime down and boot a new one on the same home (in this process). */
	restart(): Promise<void>;
	shutdown(): Promise<void>;
}

export async function createWebApiHarness(options?: {
	/** Start the background services (durable dispatch, task driver, job sweep). */
	services?: boolean;
	config?: Partial<WebApiConfig>;
	maxWebSocketMs?: number;
}): Promise<WebApiHarness> {
	const model = await startMockProvider();
	const homeDir = mkdtempSync(join(tmpdir(), "pipiclaw-e2e-wa-"));
	const home = createDeterministicHome({ mockBaseUrl: model.baseUrl, homeDir });
	createDeskRecord(home.workspaceDir, WEBAPI_DESK, new Date());
	const stateDir = join(homeDir, "state", "webapi");
	mkdirSync(stateDir, { recursive: true });
	const socketPath = join(stateDir, "api.sock");
	const key = generateKey();
	const port = await freePort();
	const config: WebApiConfig = {
		socket: true,
		tcp: { host: "127.0.0.1", port, loopback: true },
		keys: [{ name: "test", sha256: hashKey(key), desks: [WEBAPI_DESK] }],
		...options?.config,
	};
	const paths = {
		appName: "pipiclaw",
		appHomeDir: homeDir,
		workspaceDir: home.workspaceDir,
		authConfigPath: join(homeDir, "auth.json"),
		channelConfigPath: join(homeDir, "channel.json"),
		modelsConfigPath: join(homeDir, "models.json"),
		settingsConfigPath: join(homeDir, "settings.json"),
		toolsConfigPath: join(homeDir, "tools.json"),
		securityConfigPath: join(homeDir, "security.json"),
		eventHistoryPath: join(homeDir, "state", "events", "history.jsonl"),
	};

	const previousOffline = process.env.PI_OFFLINE;
	process.env.PI_OFFLINE = "1";
	process.env.PIPICLAW_HOME = homeDir;
	const { createRuntimeContext } = await import("../../src/runtime/bootstrap.js");
	let runtime!: WebApiHarness["runtime"];
	const boot = async () => {
		process.env.PIPICLAW_HOME = homeDir;
		runtime = await createRuntimeContext({
			paths,
			transports: [
				new WebApiTransport({
					config,
					stateDir,
					audit: () => undefined,
					...(options?.maxWebSocketMs ? { maxWebSocketMs: options.maxWebSocketMs } : {}),
				}),
			],
			registerSignalHandlers: false,
			startServices: options?.services ?? false,
			jobSweepIntervalMs: options?.services ? 150 : undefined,
			createEventsWatcher: () => ({ start() {}, stop() {} }),
		});
		// Background services start the transports themselves; otherwise they are started here.
		if (!options?.services) await runtime.transports.startAll(runtime.ingress);
	};
	try {
		await boot();
	} catch (error) {
		await model.close();
		cleanupE2ETestHome(homeDir);
		throw error;
	}

	const dispatcher = new Agent({ connect: { socketPath } });
	const tcp = new OpenAI({ apiKey: key, baseURL: `http://127.0.0.1:${port}/v1`, maxRetries: 0 });
	const socket = new OpenAI({
		apiKey: "unused-on-the-socket",
		baseURL: "http://localhost/v1",
		maxRetries: 0,
		fetch: undiciFetch as never,
		fetchOptions: { dispatcher },
	});

	return {
		homeDir,
		workspaceDir: home.workspaceDir,
		stateDir,
		socketPath,
		port,
		key,
		get runtime() {
			return runtime;
		},
		model,
		tcp,
		socket,
		openWebSocket(over = "tcp") {
			return over === "tcp"
				? new ResponsesWS(tcp)
				: new ResponsesWS(socket, { createConnection: () => net.connect(socketPath) });
		},
		async waitForIdle() {
			await waitFor("webapi idle", () => runtime.ingress.isIdle(), { timeoutMs: 30_000, intervalMs: 20 });
		},
		mainTurnRequests: () => model.requests.filter((request) => request.isMainTurn),
		async restart() {
			await runtime.shutdown("manual");
			await boot();
		},
		async shutdown() {
			await runtime.shutdown("manual");
			dispatcher.close().catch(() => undefined);
			await model.close();
			if (previousOffline === undefined) delete process.env.PI_OFFLINE;
			else process.env.PI_OFFLINE = previousOffline;
			cleanupE2ETestHome(homeDir);
		},
	};
}

/** The text of the model's last main-turn request, for assertions about what the agent was shown. */
export function readJsonl(path: string): unknown[] {
	return readFileSync(path, "utf-8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line));
}
