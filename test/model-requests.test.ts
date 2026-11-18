import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	cleanupSessionResources,
	type Message,
	type Model,
	type OAuthCredential,
	type Provider,
} from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { flushModelCredentials } from "../src/models/credential-work.js";
import { createModelRequests } from "../src/models/requests.js";
import { createModelRuntime } from "../src/models/runtime.js";
import { useTempDirs } from "./helpers/fixtures.js";

const temp = useTempDirs("pipiclaw-model-requests-");
afterEach(() => vi.unstubAllEnvs());

function model(provider: string): Model<"openai-completions"> {
	return {
		provider,
		id: "model",
		name: "Fixture",
		api: "openai-completions",
		baseUrl: "http://wrong.invalid/v1",
		reasoning: false,
		input: ["text"],
		contextWindow: 32768,
		maxTokens: 2048,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

function reply(): Response {
	const events = [
		{ choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] },
		{
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
		},
	];
	return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
		headers: { "content-type": "text/event-stream" },
	});
}

it("reuses a Codex socket only while the resolved endpoint and auth headers match", async () => {
	vi.stubEnv("PI_OFFLINE", "1");
	const home = temp();
	const runtime = await createModelRuntime({
		authConfigPath: join(home, "auth.json"),
		modelsConfigPath: join(home, "models.json"),
	});
	const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	await once(server, "listening");
	const address = server.address();
	if (typeof address !== "object" || !address) throw new Error("Expected a local TCP listener");
	const sessionId = "pipiclaw-codex-request-test";
	const workerSessionId = "pipiclaw-codex-worker-request-test";
	try {
		let route = "one";
		let authHeader = "initial";
		const selected: Model<"openai-codex-responses"> = { ...model("native-codex"), api: "openai-codex-responses" };
		const account = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } }),
		).toString("base64");
		runtime.registerNativeProvider({
			id: selected.provider,
			name: "Codex fixture",
			getModels: () => [selected],
			auth: {
				apiKey: {
					name: "Fixture auth",
					resolve: async () => ({
						auth: {
							apiKey: `synthetic.${account}.stub`,
							baseUrl: `http://127.0.0.1:${address.port}/${route}`,
							headers: { "x-gateway-auth": authHeader },
						},
					}),
				},
			},
			stream: () => {
				throw new Error("Expected a simple stream");
			},
			streamSimple,
		});
		const opened: Array<{ path?: string; auth: string | string[] | undefined }> = [];
		const payloads: Array<{ previous?: string; items: number }> = [];
		server.on("connection", (socket, request) => {
			opened.push({ path: request.url, auth: request.headers["x-gateway-auth"] });
			socket.on("message", (raw) => {
				const body = JSON.parse(raw.toString()) as { previous_response_id?: string; input: unknown[] };
				payloads.push({ previous: body.previous_response_id, items: body.input.length });
				const item = {
					type: "message",
					id: `msg_${payloads.length}`,
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "ok", annotations: [] }],
				};
				socket.send(
					JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } }),
				);
				socket.send(JSON.stringify({ type: "response.output_item.done", output_index: 0, item }));
				socket.send(
					JSON.stringify({
						type: "response.completed",
						response: { id: `resp_${payloads.length}`, status: "completed", output: [item] },
					}),
				);
			});
		});
		const requests = createModelRequests(runtime);
		const parentMessages: Message[] = [];
		const send = async (id = sessionId, messages = parentMessages) => {
			messages.push({ role: "user", content: `check ${messages.length}`, timestamp: 0 });
			const result = await requests
				.stream(selected, { messages }, { sessionId: id, transport: "auto", timeoutMs: 1500 })
				.result();
			expect(result.stopReason, result.errorMessage).toBe("stop");
			messages.push(result);
		};
		await send();
		await send();
		// A worker shares the adapter with its parent. Its next request must not
		// overwrite the route used to verify the parent's cached socket.
		await send(workerSessionId, []);
		route = "two";
		await send();
		cleanupSessionResources(workerSessionId);
		authHeader = "renewed";
		await send();
		expect(opened).toEqual([
			{ path: "/one/codex/responses", auth: "initial" },
			{ path: "/one/codex/responses", auth: "initial" },
			{ path: "/two/codex/responses", auth: "initial" },
			{ path: "/two/codex/responses", auth: "renewed" },
		]);
		expect(payloads.map(({ items }) => items)).toEqual([1, 1, 1, 5, 7]);
		expect(payloads.map(({ previous }) => previous)).toEqual([undefined, "resp_1", undefined, undefined, undefined]);
	} finally {
		cleanupSessionResources(workerSessionId);
		cleanupSessionResources(sessionId);
		for (const socket of server.clients) socket.terminate();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

it("preserves configured headers and request-time auth endpoints without leaking another provider's key", async () => {
	// Replaces the old API-key-only lookup scenario: that implementation loses the gateway header.
	vi.stubEnv("PI_OFFLINE", "1");
	const home = temp();
	writeFileSync(
		join(home, "models.json"),
		JSON.stringify({
			providers: {
				gateway: {
					baseUrl: "http://gateway.invalid/v1",
					api: "openai-completions",
					apiKey: "gateway-key",
					headers: { "x-required": "gateway" },
					models: [{ id: "model" }],
				},
			},
		}),
	);
	const runtime = await createModelRuntime({
		authConfigPath: join(home, "auth.json"),
		modelsConfigPath: join(home, "models.json"),
	});
	const requests = createModelRequests(runtime);
	const seen: Array<{ url: string; headers: Headers }> = [];
	const fetch: typeof globalThis.fetch = async (url, init) => {
		seen.push({ url: String(url), headers: new Headers(init?.headers) });
		return reply();
	};
	let authRevision = 0;
	const native = model("header-owned");
	runtime.registerNativeProvider({
		id: native.provider,
		name: "Fixture",
		getModels: () => [native],
		auth: {
			apiKey: {
				name: "Header-owned auth",
				resolve: async () => ({
					auth: {
						headers: { Authorization: `Bearer revision-${++authRevision}` },
						baseUrl: "http://resolved.invalid/v1",
					},
					env: { PIPICLAW_AUTH_FIXTURE: "scoped" },
				}),
			},
		},
		stream: () => {
			throw new Error("Expected provider-neutral streamSimple");
		},
		streamSimple: (m, ctx, options) => {
			expect(options?.env?.PIPICLAW_AUTH_FIXTURE).toBe("scoped");
			return streamSimple(m, ctx, options);
		},
	} satisfies Provider);
	const gateway = runtime.getModel("gateway", "model")!;
	const context = { messages: [{ role: "user" as const, content: "check", timestamp: 0 }] };
	for (const selected of [gateway, native, native]) {
		await requests.ensureAuth(selected);
		const stream = await requests.stream(selected, context, {
			fetch,
			apiKey: "stale-other-provider-key",
			maxRetries: 0,
		});
		expect((await stream.result()).stopReason).toBe("stop");
	}
	expect(seen[0]?.headers.get("x-required")).toBe("gateway");
	expect(seen[0]?.headers.get("authorization")).toBe("Bearer gateway-key");
	expect(seen.slice(1).map((entry) => entry.url)).toEqual([
		"http://resolved.invalid/v1/chat/completions",
		"http://resolved.invalid/v1/chat/completions",
	]);
	expect(seen[1]?.headers.get("x-required")).toBeNull();
	for (const request of seen.slice(1)) {
		expect(request.headers.get("authorization")).toMatch(/^Bearer revision-\d+$/);
	}
	expect(seen[1]?.headers.get("authorization")).not.toBe(seen[2]?.headers.get("authorization"));
	await expect(requests.ensureAuth(model("unconfigured"))).rejects.toThrow("pipiclaw auth login");
	await flushModelCredentials(join(home, "auth.json"));
});

it("keeps a rotated OAuth credential tracked after cancellation until it is saved", async () => {
	// New risk: the cancelled request finishes before the single-use refresh token's replacement is durable.
	vi.stubEnv("PI_OFFLINE", "1");
	const home = temp();
	const authPath = join(home, "auth.json");
	const expired: OAuthCredential = { type: "oauth", access: "old", refresh: "spent-on-refresh", expires: 0 };
	writeFileSync(authPath, JSON.stringify({ rotating: expired }));
	let entered!: () => void;
	const arrived = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const runtime = await createModelRuntime({ authConfigPath: authPath, modelsConfigPath: join(home, "models.json") });
	const selected = model("rotating");
	runtime.registerNativeProvider({
		id: selected.provider,
		name: "Rotating",
		getModels: () => [selected],
		auth: {
			oauth: {
				name: "Fixture",
				login: async () => expired,
				refresh: async () => {
					entered();
					await gate;
					return { type: "oauth", access: "new", refresh: "replacement", expires: Date.now() + 3_600_000 };
				},
				toAuth: async (credential) => ({ headers: { Authorization: `Bearer ${credential.access}` } }),
			},
		},
		stream: () => {
			throw new Error("Expected provider-neutral streamSimple");
		},
		streamSimple: (m, ctx, options) => streamSimple(m, ctx, options),
	} satisfies Provider);
	const controller = new AbortController();
	const check = createModelRequests(runtime).ensureAuth(selected, controller.signal);
	const cancelled = expect(check).rejects.toBeDefined();
	await arrived;
	controller.abort();
	await cancelled;
	let flushed = false;
	const flushing = flushModelCredentials(authPath).then(() => {
		flushed = true;
	});
	await Promise.resolve();
	expect(flushed).toBe(false);
	expect(JSON.parse(readFileSync(authPath, "utf8")).rotating.refresh).toBe(expired.refresh);
	release();
	await flushing;
	expect(JSON.parse(readFileSync(authPath, "utf8")).rotating.refresh).toBe("replacement");
});
