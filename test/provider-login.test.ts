import type {
	Api,
	AuthEvent,
	AuthInteraction,
	AuthPrompt,
	AuthType,
	Credential,
	Model,
	Provider,
} from "@earendil-works/pi-ai";
import { ModelsError } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	LoginCancelledError,
	type LoginUi,
	listProviderLoginOptions,
	loginProvider,
	logoutProvider,
	renderAuthStatus,
} from "../src/models/provider-login.js";

function fakeModel(provider: string, id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider,
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	} as Model<Api>;
}

interface FakeRuntimeOptions {
	providers: Provider[];
	authStatus?: Record<string, { configured: boolean; source?: string; label?: string }>;
	usingOAuth?: Record<string, boolean>;
	availableModels?: Model<Api>[];
	loginImpl?: (providerId: string, type: AuthType, interaction: AuthInteraction) => Promise<Credential>;
	error?: string;
}

function makeFakeRuntime(options: FakeRuntimeOptions): ModelRuntime {
	let available = options.availableModels ?? [];
	return {
		getProviders: () => options.providers,
		getProvider: (id: string) => options.providers.find((p) => p.id === id),
		getProviderAuthStatus: (id: string) => options.authStatus?.[id] ?? { configured: false },
		isUsingOAuth: (id: string) => options.usingOAuth?.[id] ?? false,
		getAvailableSnapshot: () => available,
		getError: () => options.error,
		login: async (providerId: string, type: AuthType, interaction: AuthInteraction) => {
			if (!options.loginImpl) throw new Error("no loginImpl configured");
			const credential = await options.loginImpl(providerId, type, interaction);
			available = [...available, fakeModel(providerId, "new-model")];
			return credential;
		},
		logout: vi.fn(async () => {}),
	} as unknown as ModelRuntime;
}

function provider(
	id: string,
	name: string,
	opts: { oauth?: boolean; apiKey?: boolean } = { oauth: true, apiKey: true },
): Provider {
	return {
		id,
		name,
		auth: {
			...(opts.apiKey
				? { apiKey: { name: `${name} API key`, login: async () => ({ type: "api_key", key: "k" }) } }
				: {}),
			...(opts.oauth
				? {
						oauth: {
							name: `${name} OAuth`,
							loginLabel: `${name} (Subscription)`,
							login: async () => ({ type: "oauth", access: "a", refresh: "r", expires: Date.now() + 1000 }),
							refresh: async (c: Credential) => c,
							toAuth: async () => ({ apiKey: "x" }),
						},
					}
				: {}),
		},
		getModels: () => [],
	} as unknown as Provider;
}

function noopUi(overrides: Partial<LoginUi> = {}): LoginUi {
	return {
		signal: new AbortController().signal,
		ask: vi.fn(async () => ""),
		notify: vi.fn(),
		...overrides,
	};
}

describe("listProviderLoginOptions", () => {
	it("lists one row per supported auth type, sorted by name then auth type", () => {
		const runtime = makeFakeRuntime({
			providers: [provider("z-provider", "Zeta"), provider("a-provider", "Alpha", { apiKey: true })],
			authStatus: { "a-provider": { configured: true, source: "stored" } },
			usingOAuth: {},
		});

		const options = listProviderLoginOptions(runtime);
		expect(options.map((o) => `${o.name}:${o.authType}`)).toEqual(["Alpha:api_key", "Zeta:api_key", "Zeta:oauth"]);
		expect(options.find((o) => o.id === "a-provider")).toMatchObject({
			configured: true,
			configuredAs: "api_key",
			source: "stored",
		});
	});

	it("filters by requested auth type", () => {
		const runtime = makeFakeRuntime({ providers: [provider("acme", "Acme")] });
		const oauthOnly = listProviderLoginOptions(runtime, "oauth");
		expect(oauthOnly).toHaveLength(1);
		expect(oauthOnly[0].authType).toBe("oauth");
	});
});

describe("loginProvider", () => {
	it("drives select → device_code success and returns the new models diff", async () => {
		const p = provider("acme", "Acme");
		const runtime = makeFakeRuntime({
			providers: [p],
			availableModels: [fakeModel("acme", "existing")],
			loginImpl: async (_id, _type, interaction) => {
				const method = await interaction.prompt({
					type: "select",
					message: "Login method",
					options: [
						{ id: "browser", label: "Browser" },
						{ id: "device_code", label: "Device code" },
					],
				});
				expect(method).toBe("device_code");
				interaction.notify({
					type: "device_code",
					userCode: "ABCD-1234",
					verificationUri: "https://example.test/device",
				});
				return { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 1000 };
			},
		});

		const events: AuthEvent[] = [];
		const ui = noopUi({
			ask: vi.fn(async (prompt: AuthPrompt) => {
				expect(prompt.type).toBe("select");
				return "device_code";
			}),
			notify: (event) => events.push(event),
		});

		const result = await loginProvider(runtime, "acme", "oauth", ui);

		expect(result.credentialType).toBe("oauth");
		expect(result.newModels.map((m) => m.id)).toEqual(["new-model"]);
		expect(events).toEqual([
			{ type: "device_code", userCode: "ABCD-1234", verificationUri: "https://example.test/device" },
		]);
	});

	it("propagates LoginCancelledError unchanged and writes nothing", async () => {
		const p = provider("acme", "Acme");
		const runtime = makeFakeRuntime({
			providers: [p],
			loginImpl: async (_id, _type, interaction) => {
				await interaction.prompt({ type: "text", message: "never answered" });
				throw new Error("unreachable");
			},
		});

		const cancelled = new LoginCancelledError();
		const ui = noopUi({ ask: vi.fn(async () => Promise.reject(cancelled)) });

		await expect(loginProvider(runtime, "acme", "oauth", ui)).rejects.toBe(cancelled);
	});

	it("turns a ModelsError into a message with an actionable next step", async () => {
		const p = provider("acme", "Acme");
		const cause = new ModelsError("oauth", "device code expired");
		const runtime = makeFakeRuntime({
			providers: [p],
			loginImpl: async () => {
				throw cause;
			},
		});

		await expect(loginProvider(runtime, "acme", "oauth", noopUi())).rejects.toMatchObject({
			message: expect.stringContaining("device code expired"),
			cause,
		});
		await expect(loginProvider(runtime, "acme", "oauth", noopUi())).rejects.toThrow(/pipiclaw auth login/);
	});
});

describe("logoutProvider", () => {
	it("delegates to runtime.logout", async () => {
		const runtime = makeFakeRuntime({ providers: [] });
		await logoutProvider(runtime, "acme");
		expect(runtime.logout).toHaveBeenCalledWith("acme");
	});
});

describe("renderAuthStatus", () => {
	it("includes every provider, the auth path, and a models.json error when present", async () => {
		const runtime = makeFakeRuntime({
			providers: [provider("acme", "Acme"), provider("beta", "Beta")],
			authStatus: { acme: { configured: true, source: "stored" } },
			usingOAuth: { acme: true },
			error: "bad models.json",
		});

		const report = await renderAuthStatus(runtime, "/home/user/.pipiclaw/auth.json");
		expect(report).toContain("Acme");
		expect(report).toContain("Beta");
		expect(report).toContain("oauth");
		expect(report).toContain("/home/user/.pipiclaw/auth.json");
		expect(report).toContain("bad models.json");
		expect(report).toMatch(/restart/i);
	});
});
