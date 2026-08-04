/**
 * `pipiclaw auth` CLI: argument parsing and entry. Parsing is a pure function
 * (`parseAuthArgs`) so it can be unit-tested; `runAuth` wires it to the
 * transport-neutral orchestration in `provider-login.ts`. Deliberately does
 * not construct a runner, session, memory scheduler, or channel directory —
 * login is a short, one-shot operation (spec 039 §5.1).
 */
import { createInterface } from "node:readline/promises";
import type { AuthType } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import * as log from "../log.js";
import {
	BootstrapExitError,
	type BootstrapIO,
	type BootstrapPaths,
	bootstrapAppHome,
	DEFAULT_BOOTSTRAP_PATHS,
	prepareAppServices,
	printBootstrapSummary,
	readCliVersion,
} from "../runtime/bootstrap.js";
import { ReadlineLoginUi } from "./login-ui.js";
import {
	LoginCancelledError,
	type LoginUi,
	listProviderLoginOptions,
	loginProvider,
	logoutProvider,
	type ProviderLoginOption,
	renderAuthStatus,
} from "./provider-login.js";
import { createModelRuntime, formatModelReference } from "./utils.js";

export type ParsedAuth =
	| { kind: "status" }
	| { kind: "login"; provider?: string; apiKey: boolean; oauth: boolean; deviceCode: boolean; noBrowser: boolean }
	| { kind: "logout"; provider?: string; yes: boolean }
	| { kind: "help" }
	| { kind: "version" }
	| { kind: "error"; message: string };

/** Parse `pipiclaw auth` arguments (everything after the `auth` subcommand, including the subcommand name itself). */
export function parseAuthArgs(args: string[]): ParsedAuth {
	if (args.length === 0) {
		return { kind: "error", message: "Missing subcommand. Usage: pipiclaw auth status|login|logout" };
	}
	if (args[0] === "--version") return { kind: "version" };
	if (args[0] === "--help" || args[0] === "-h") return { kind: "help" };

	const subcommand = args[0];
	const rest = args.slice(1);

	if (subcommand === "status") {
		if (rest.some((arg) => arg === "--help" || arg === "-h")) return { kind: "help" };
		if (rest.length > 0) return { kind: "error", message: `Unknown option: ${rest[0]}` };
		return { kind: "status" };
	}

	if (subcommand === "login") {
		let apiKey = false;
		let oauth = false;
		let deviceCode = false;
		let noBrowser = false;
		const positional: string[] = [];

		for (const arg of rest) {
			if (arg === "--api-key") apiKey = true;
			else if (arg === "--oauth") oauth = true;
			else if (arg === "--device-code") deviceCode = true;
			else if (arg === "--no-browser") noBrowser = true;
			else if (arg === "--help" || arg === "-h") return { kind: "help" };
			else if (arg.startsWith("--")) return { kind: "error", message: `Unknown option: ${arg}` };
			else positional.push(arg);
		}

		if (apiKey && oauth) return { kind: "error", message: "--api-key and --oauth are mutually exclusive" };
		if (positional.length > 1) return { kind: "error", message: `Unexpected argument: ${positional[1]}` };

		return { kind: "login", provider: positional[0], apiKey, oauth, deviceCode, noBrowser };
	}

	if (subcommand === "logout") {
		let yes = false;
		const positional: string[] = [];

		for (const arg of rest) {
			if (arg === "--yes" || arg === "-y") yes = true;
			else if (arg === "--help" || arg === "-h") return { kind: "help" };
			else if (arg.startsWith("--")) return { kind: "error", message: `Unknown option: ${arg}` };
			else positional.push(arg);
		}

		if (positional.length > 1) return { kind: "error", message: `Unexpected argument: ${positional[1]}` };

		return { kind: "logout", provider: positional[0], yes };
	}

	return { kind: "error", message: `Unknown subcommand: ${subcommand}` };
}

function printAuthHelp(io: BootstrapIO): void {
	io.log("Usage: pipiclaw auth status|login|logout [options]");
	io.log("");
	io.log("Manage provider credentials stored in auth.json. A one-shot, interactive");
	io.log("operation — it does not start the daemon, load memory, or touch any channel.");
	io.log("");
	io.log("  pipiclaw auth status");
	io.log("      List configured providers, credential type, and the auth.json path.");
	io.log("");
	io.log("  pipiclaw auth login [provider] [--api-key] [--oauth] [--device-code] [--no-browser]");
	io.log("      Log in to a provider. With no arguments, prompts for auth type then");
	io.log("      provider. `provider` matches by id or name, case-insensitively.");
	io.log("      --api-key / --oauth   Skip the auth-type prompt.");
	io.log("      --device-code         Preset answer for headless OAuth flows (no local browser/port).");
	io.log("      --no-browser          Print the auth URL only; never try to open a browser.");
	io.log("");
	io.log("  pipiclaw auth logout [provider] [--yes]");
	io.log("      Remove a stored credential. Confirms unless --yes is given.");
	io.log("");
	io.log("Note: a running daemon or TUI session must be restarted to see new credentials.");
}

type LoginTarget = { kind: "target"; providerId: string; authType: AuthType } | { kind: "unsupported"; name: string };

function providerAuthAvailable(runtime: ModelRuntime, option: ProviderLoginOption): boolean {
	const provider = runtime.getProvider(option.id);
	if (!provider) return false;
	return option.authType === "oauth"
		? provider.auth.oauth?.login !== undefined
		: provider.auth.apiKey?.login !== undefined;
}

function toTarget(runtime: ModelRuntime, option: ProviderLoginOption): LoginTarget {
	return providerAuthAvailable(runtime, option)
		? { kind: "target", providerId: option.id, authType: option.authType }
		: { kind: "unsupported", name: option.name };
}

async function askAuthTypeChoice(ui: LoginUi): Promise<AuthType> {
	const answer = await ui.ask({
		type: "select",
		message: "Authentication method:",
		options: [
			{ id: "oauth", label: "Subscription login (OAuth)" },
			{ id: "api_key", label: "API key" },
		],
	});
	return answer === "api_key" ? "api_key" : "oauth";
}

async function resolveLoginTarget(
	runtime: ModelRuntime,
	parsed: Extract<ParsedAuth, { kind: "login" }>,
	ui: LoginUi,
): Promise<LoginTarget> {
	const forcedAuthType: AuthType | undefined = parsed.oauth ? "oauth" : parsed.apiKey ? "api_key" : undefined;

	if (parsed.provider) {
		const needle = parsed.provider.toLowerCase();
		let candidates = listProviderLoginOptions(runtime).filter(
			(option) => option.id.toLowerCase() === needle || option.name.toLowerCase() === needle,
		);
		if (forcedAuthType) candidates = candidates.filter((option) => option.authType === forcedAuthType);
		if (candidates.length === 0) {
			throw new Error(
				`Unknown provider: "${parsed.provider}". Run \`pipiclaw auth status\` to see available providers.`,
			);
		}

		let chosen = candidates[0];
		if (candidates.length > 1) {
			const authTypeId = await ui.ask({
				type: "select",
				message: `Select login method for ${chosen.name}:`,
				options: candidates.map((candidate) => ({
					id: candidate.authType,
					label: candidate.authType === "oauth" ? (candidate.loginLabel ?? "OAuth") : "API key",
				})),
			});
			chosen = candidates.find((candidate) => candidate.authType === authTypeId) ?? chosen;
		}
		return toTarget(runtime, chosen);
	}

	const authType = forcedAuthType ?? (await askAuthTypeChoice(ui));
	const options = listProviderLoginOptions(runtime, authType);
	if (options.length === 0) {
		throw new Error(`No providers support ${authType === "oauth" ? "subscription login" : "API key login"}.`);
	}

	const providerId = await ui.ask({
		type: "select",
		message: "Select a provider:",
		options: options.map((option) => ({
			id: option.id,
			label: option.name,
			description: option.configured ? `configured (${option.configuredAs})` : "not configured",
		})),
	});
	const chosen = options.find((option) => option.id === providerId);
	if (!chosen) throw new Error(`Unknown provider: "${providerId}".`);
	return toTarget(runtime, chosen);
}

function auditAuthEvent(
	action: "login" | "logout",
	providerId: string,
	authType: AuthType | undefined,
	ok: boolean,
): void {
	// Deliberately not routed through src/security/logger.ts: that module is
	// scoped to per-channel blocked-operation audit (workspaceDir + SecurityConfig
	// gate) and this is a process-level, channel-less event. Never includes a
	// token/secret fragment.
	log.logInfo(`auth ${action}: ${providerId}${authType ? ` (${authType})` : ""} — ${ok ? "ok" : "failed"}`);
}

async function runLogin(
	runtime: ModelRuntime,
	parsed: Extract<ParsedAuth, { kind: "login" }>,
	io: BootstrapIO,
	signal: AbortSignal,
): Promise<void> {
	const ui = new ReadlineLoginUi({
		signal,
		presetFirstSelect: parsed.deviceCode ? "device_code" : undefined,
		noBrowser: parsed.noBrowser,
	});

	try {
		const target = await resolveLoginTarget(runtime, parsed, ui);
		if (target.kind === "unsupported") {
			io.error(
				`"${target.name}" uses ambient credentials (environment variables / local config files), not interactive login.`,
			);
			io.error("See docs/configuration.md for how to configure it.");
			throw new BootstrapExitError(1);
		}

		let result: Awaited<ReturnType<typeof loginProvider>>;
		try {
			result = await loginProvider(runtime, target.providerId, target.authType, ui);
		} catch (error) {
			auditAuthEvent("login", target.providerId, target.authType, false);
			throw error;
		}
		auditAuthEvent("login", target.providerId, target.authType, true);

		io.log(`Logged in: ${target.providerId} (${result.credentialType})`);
		if (result.newModels.length > 0) {
			const sorted = result.newModels
				.slice()
				.sort((a, b) => formatModelReference(a).localeCompare(formatModelReference(b)));
			io.log("New models available:");
			for (const model of sorted) io.log(`  - ${formatModelReference(model)}`);
			io.log("");
			io.log("This does not change your default model. To use one of these:");
			io.log(`  /model ${formatModelReference(sorted[0])}   (inside \`pipiclaw tui\`)`);
			io.log("or add to settings.json:");
			io.log(`  { "defaultProvider": "${sorted[0].provider}", "defaultModel": "${sorted[0].id}" }`);
		}
		io.log("A running daemon or TUI session must be restarted to see this credential.");

		if (process.env.PIPICLAW_PROXY && !process.env.HTTPS_PROXY && !process.env.HTTP_PROXY) {
			io.log("");
			io.log(
				"Warning: PIPICLAW_PROXY is set but HTTPS_PROXY/HTTP_PROXY is not. Codex chat traffic uses a " +
					"WebSocket transport that only honors HTTPS_PROXY/HTTP_PROXY and may connect directly — see " +
					"docs/configuration.md.",
			);
		}
	} catch (error) {
		if (error instanceof BootstrapExitError) throw error;
		if (error instanceof LoginCancelledError || signal.aborted) {
			io.error("Cancelled.");
			throw new BootstrapExitError(130);
		}
		io.error(error instanceof Error ? error.message : String(error));
		throw new BootstrapExitError(2);
	} finally {
		ui.close();
	}
}

async function runLogout(
	runtime: ModelRuntime,
	parsed: Extract<ParsedAuth, { kind: "logout" }>,
	io: BootstrapIO,
	signal: AbortSignal,
): Promise<void> {
	const credentials = await runtime.listCredentials();
	if (credentials.length === 0) {
		io.log("No stored credentials.");
		return;
	}
	const providerNames = new Map(runtime.getProviders().map((provider) => [provider.id, provider.name]));

	const rl = createInterface({ input: process.stdin, output: process.stderr });
	try {
		let providerId = parsed.provider;
		if (providerId) {
			const needle = providerId.toLowerCase();
			const match = credentials.find(
				(credential) =>
					credential.providerId.toLowerCase() === needle ||
					(providerNames.get(credential.providerId) ?? "").toLowerCase() === needle,
			);
			if (!match) {
				io.error(
					`No stored credential for "${providerId}". Run \`pipiclaw auth status\` to see what's configured.`,
				);
				throw new BootstrapExitError(1);
			}
			providerId = match.providerId;
		} else if (credentials.length === 1) {
			providerId = credentials[0].providerId;
		} else {
			io.error("Select a provider to log out:");
			credentials.forEach((credential, index) => {
				io.error(
					`  ${index + 1}) ${providerNames.get(credential.providerId) ?? credential.providerId} (${credential.type})`,
				);
			});
			const raw = (await rl.question("> ", { signal })).trim();
			const index = Number.parseInt(raw, 10);
			const match = Number.isInteger(index) ? credentials[index - 1] : undefined;
			if (!match) {
				io.error(`Invalid choice: ${raw}`);
				throw new BootstrapExitError(1);
			}
			providerId = match.providerId;
		}

		const displayName = providerNames.get(providerId) ?? providerId;
		if (!parsed.yes) {
			const answer = (await rl.question(`Log out of ${displayName}? [y/N] `, { signal })).trim().toLowerCase();
			if (answer !== "y" && answer !== "yes") {
				io.log("Cancelled.");
				return;
			}
		}

		try {
			await logoutProvider(runtime, providerId);
		} catch (error) {
			auditAuthEvent("logout", providerId, undefined, false);
			io.error(error instanceof Error ? error.message : String(error));
			throw new BootstrapExitError(2);
		}
		auditAuthEvent("logout", providerId, undefined, true);
		io.log(`Logged out: ${displayName}`);
	} catch (error) {
		if (error instanceof BootstrapExitError) throw error;
		if (signal.aborted) {
			io.error("Cancelled.");
			throw new BootstrapExitError(130);
		}
		throw error;
	} finally {
		rl.close();
	}
}

export async function runAuth(
	argv: string[],
	io: BootstrapIO = console,
	paths: BootstrapPaths = DEFAULT_BOOTSTRAP_PATHS,
): Promise<void> {
	const parsed = parseAuthArgs(argv.slice(3));

	if (parsed.kind === "help") {
		printAuthHelp(io);
		return;
	}
	if (parsed.kind === "version") {
		io.log(readCliVersion());
		return;
	}
	if (parsed.kind === "error") {
		io.error(parsed.message);
		io.error("Run `pipiclaw auth --help` for usage.");
		throw new BootstrapExitError(1);
	}

	if (parsed.kind !== "status" && process.stdin.isTTY !== true) {
		io.error("pipiclaw auth login/logout requires an interactive terminal (stdin is not a TTY).");
		throw new BootstrapExitError(1);
	}

	printBootstrapSummary(bootstrapAppHome(paths, io), io, paths);
	prepareAppServices(paths);
	const runtime = await createModelRuntime({
		authConfigPath: paths.authConfigPath,
		modelsConfigPath: paths.modelsConfigPath,
	});

	if (parsed.kind === "status") {
		io.log(await renderAuthStatus(runtime, paths.authConfigPath));
		return;
	}

	const controller = new AbortController();
	const onSigint = () => controller.abort();
	process.once("SIGINT", onSigint);
	try {
		if (parsed.kind === "login") {
			await runLogin(runtime, parsed, io, controller.signal);
		} else {
			await runLogout(runtime, parsed, io, controller.signal);
		}
	} finally {
		process.removeListener("SIGINT", onSigint);
	}
}
