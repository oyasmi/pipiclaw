import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Model, OAuthCredential, Provider } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { afterEach, expect, it, vi } from "vitest";
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
