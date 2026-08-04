/**
 * Transport-neutral provider login/logout/status orchestration. Imports no
 * terminal code — the human-machine interface is the injected `LoginUi`, so a
 * future TUI `/login` can supply a different implementation without touching
 * this file (see docs/specs/039-provider-login-cli/design.md §10).
 */
import {
	type Api,
	type AuthEvent,
	type AuthPrompt,
	type AuthType,
	type Model,
	ModelsError,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export class LoginCancelledError extends Error {
	constructor(message = "登录已取消") {
		super(message);
		this.name = "LoginCancelledError";
	}
}

/** Human-machine interface for a login flow. Readline is the only implementation today. */
export interface LoginUi {
	/** Resolves to the entered/selected value; `select` resolves to the option id. Rejects with `LoginCancelledError` on cancel. */
	ask(prompt: AuthPrompt): Promise<string>;
	notify(event: AuthEvent): void;
	/** Aborts the whole login flow (SIGINT). */
	signal: AbortSignal;
}

export interface ProviderLoginOption {
	id: string;
	name: string;
	authType: AuthType;
	/** OAuth subscription login label, e.g. "OpenAI (ChatGPT Plus/Pro)". */
	loginLabel?: string;
	configured: boolean;
	configuredAs?: AuthType;
	source?: string;
}

export interface ProviderLoginResult {
	providerId: string;
	credentialType: AuthType;
	/** Models newly available after login (before/after `getAvailableSnapshot()` diff). */
	newModels: Model<Api>[];
}

function modelKey(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

/** List every provider x auth-type combination the provider supports (not just ones with an interactive `login`). */
export function listProviderLoginOptions(runtime: ModelRuntime, authType?: AuthType): ProviderLoginOption[] {
	const options: ProviderLoginOption[] = [];
	for (const provider of runtime.getProviders()) {
		const status = runtime.getProviderAuthStatus(provider.id);
		const configuredAs: AuthType | undefined = status.configured
			? runtime.isUsingOAuth(provider.id)
				? "oauth"
				: "api_key"
			: undefined;

		if (provider.auth.oauth && (!authType || authType === "oauth")) {
			options.push({
				id: provider.id,
				name: provider.name,
				authType: "oauth",
				loginLabel: provider.auth.oauth.loginLabel ?? provider.auth.oauth.name,
				configured: status.configured,
				configuredAs,
				source: status.source,
			});
		}
		if (provider.auth.apiKey && (!authType || authType === "api_key")) {
			options.push({
				id: provider.id,
				name: provider.name,
				authType: "api_key",
				configured: status.configured,
				configuredAs,
				source: status.source,
			});
		}
	}

	return options.sort((a, b) => a.name.localeCompare(b.name) || a.authType.localeCompare(b.authType));
}

/** Turn an SDK-level failure into a message with an actionable next step. Cancellation passes through untouched. */
function humanizeLoginError(providerId: string, error: unknown): Error {
	if (error instanceof LoginCancelledError) return error;

	if (error instanceof ModelsError) {
		const hint =
			error.code === "oauth"
				? "OAuth 流程失败，请重新执行 `pipiclaw auth login` 并在有效期内完成授权（device code 有效期 15 分钟）。"
				: error.code === "auth"
					? "认证失败，请确认输入的凭据正确后重试。"
					: error.code === "provider"
						? `provider "${providerId}" 配置有误，请检查 models.json。`
						: "请重试；如反复失败可改用 --api-key 或 --oauth 明确认证方式。";
		return new Error(`${error.message}\n${hint}`, { cause: error });
	}

	if (error instanceof Error) {
		return new Error(`登录失败：${error.message}\n请检查网络连接后重试；如配置了 PIPICLAW_PROXY，确认代理可达。`, {
			cause: error,
		});
	}

	return new Error(`登录失败：${String(error)}`);
}

export async function loginProvider(
	runtime: ModelRuntime,
	providerId: string,
	authType: AuthType,
	ui: LoginUi,
): Promise<ProviderLoginResult> {
	const before = runtime.getAvailableSnapshot();

	let credential: Awaited<ReturnType<ModelRuntime["login"]>>;
	try {
		credential = await runtime.login(providerId, authType, {
			signal: ui.signal,
			prompt: (prompt) => ui.ask(prompt),
			notify: (event) => ui.notify(event),
		});
	} catch (error) {
		throw humanizeLoginError(providerId, error);
	}

	const after = runtime.getAvailableSnapshot();
	const beforeKeys = new Set(before.map(modelKey));
	const newModels = after.filter((model) => !beforeKeys.has(modelKey(model)));

	return { providerId, credentialType: credential.type, newModels };
}

export async function logoutProvider(runtime: ModelRuntime, providerId: string): Promise<void> {
	await runtime.logout(providerId);
}

/** Render the `pipiclaw auth status` report: one row per provider, plus the auth.json path and any models.json error. */
export async function renderAuthStatus(runtime: ModelRuntime, authPath: string): Promise<string> {
	const providers = runtime
		.getProviders()
		.slice()
		.sort((a, b) => a.name.localeCompare(b.name));

	const rows = providers.map((provider) => {
		const status = runtime.getProviderAuthStatus(provider.id);
		const type = status.configured ? (runtime.isUsingOAuth(provider.id) ? "oauth" : "api_key") : "-";
		return {
			name: provider.name,
			configured: status.configured ? "yes" : "no",
			type,
			source: status.source ?? status.label ?? "-",
		};
	});

	const nameWidth = Math.max(8, ...rows.map((row) => row.name.length));
	const configuredWidth = Math.max(10, ...rows.map((row) => row.configured.length));
	const typeWidth = Math.max(4, ...rows.map((row) => row.type.length));

	const lines: string[] = [
		`${"Provider".padEnd(nameWidth)}  ${"Configured".padEnd(configuredWidth)}  ${"Type".padEnd(typeWidth)}  Source`,
	];
	for (const row of rows) {
		lines.push(
			`${row.name.padEnd(nameWidth)}  ${row.configured.padEnd(configuredWidth)}  ${row.type.padEnd(typeWidth)}  ${row.source}`,
		);
	}

	lines.push("");
	lines.push(`auth.json: ${authPath}`);

	const modelsError = runtime.getError();
	if (modelsError) {
		lines.push(`models.json error: ${modelsError}`);
	}

	lines.push("Note: a running daemon or TUI session must be restarted to pick up new credentials.");

	return lines.join("\n");
}
