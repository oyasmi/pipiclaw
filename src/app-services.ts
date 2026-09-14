import * as log from "./log.js";
import { type BootstrapPaths, DEFAULT_BOOTSTRAP_PATHS } from "./runtime/app-home.js";
import { installLlmProxy } from "./runtime/proxy.js";
import { loadSecurityConfigWithDiagnostics } from "./security/config.js";
import { PipiclawSettingsManager } from "./settings.js";
import { formatConfigDiagnostic } from "./shared/config-diagnostic.js";
import { loadToolsConfigWithDiagnostics } from "./tools/config.js";

/**
 * Transport-neutral app services shared by the DingTalk runtime, the terminal TUI, and the
 * `pipiclaw auth` CLI: loads settings (surfacing load errors) and reports tool/security config
 * diagnostics. Does NOT touch DingTalk config, so non-DingTalk entrypoints can call it without
 * any DingTalk credentials.
 *
 * Lives at the package root rather than in `runtime/` on purpose: `models/auth-cli.ts` needs it
 * before a runner or channel exists, and `runtime/bootstrap.ts` separately depends on `models/`
 * (for the default model reference) — parking this function inside `bootstrap.ts` made `models`
 * and `runtime` depend on each other. Everything this function touches (`settings.ts`,
 * `tools/config.ts`, `security/config.ts`, `runtime/app-home.ts`, `runtime/proxy.ts`) has no
 * import back to `models/`, so this file doesn't reintroduce the cycle it was extracted to break.
 */
export function prepareAppServices(paths: BootstrapPaths = DEFAULT_BOOTSTRAP_PATHS): {
	settingsManager: PipiclawSettingsManager;
} {
	// Shared by the DingTalk daemon, the TUI, and the auth CLI (all call prepareAppServices), so
	// this covers every entrypoint that talks to an LLM provider.
	installLlmProxy();

	const settingsManager = new PipiclawSettingsManager(paths.appHomeDir);
	for (const { scope, error } of settingsManager.drainErrors()) {
		log.logWarning(`Failed to load ${scope} settings`, `${error.message}\n${paths.settingsConfigPath}`);
	}
	// Errors already went out above with a richer message; this pass exists for the
	// warnings, chiefly retired settings keys (spec 035 D3).
	for (const diagnostic of settingsManager.getDiagnostics()) {
		if (diagnostic.severity === "error") continue;
		log.logWarning(formatConfigDiagnostic(diagnostic), diagnostic.path);
	}
	for (const diagnostic of loadToolsConfigWithDiagnostics(paths.appHomeDir).diagnostics) {
		log.logWarning(formatConfigDiagnostic(diagnostic), diagnostic.path);
	}
	for (const diagnostic of loadSecurityConfigWithDiagnostics(paths.appHomeDir).diagnostics) {
		log.logWarning(formatConfigDiagnostic(diagnostic), diagnostic.path);
	}

	return { settingsManager };
}
