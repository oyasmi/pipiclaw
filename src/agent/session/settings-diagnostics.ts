import { join } from "node:path";
import type { PipiclawSettingsManager } from "../../config/settings.js";
import * as log from "../../log.js";
import { type ConfigDiagnostic, formatConfigDiagnostic } from "../../shared/config-diagnostic.js";

/** Surface settings.json load errors (once drained) as warnings; shared by construction and reload. */
export function reportSettingsDiagnostics(
	settingsManager: PipiclawSettingsManager,
	channelId: string,
	appHomeDir: string,
): void {
	for (const { scope, error } of settingsManager.drainErrors()) {
		log.logWarn("config.settings.load_failed", "Settings load failed", {
			channelId,
			reason: error.message,
			fields: { scope, path: join(appHomeDir, "settings.json") },
		});
	}
}

export function reportConfigDiagnostics(diagnostics: ConfigDiagnostic[], channelId: string): void {
	for (const diagnostic of diagnostics) {
		log.logWarn("config.diagnostic", formatConfigDiagnostic(diagnostic), {
			channelId: channelId,
			fields: { path: diagnostic.path },
		});
	}
}
