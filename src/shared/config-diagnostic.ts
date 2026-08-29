import { existsSync, readFileSync } from "node:fs";
import { errorMessage } from "./text-utils.js";

/** A single configuration validation finding, rendered by `formatConfigDiagnostic`. */
export interface ConfigDiagnostic {
	source: "settings" | "tools" | "security";
	path: string;
	severity: "warning" | "error";
	message: string;
}

export function formatConfigDiagnostic(diagnostic: ConfigDiagnostic): string {
	return `${diagnostic.source}.json: ${diagnostic.message}`;
}

/**
 * Push a field-scoped warning, prefixing `field: ` onto the message — shared by every app-level
 * JSON config loader's per-field validators (`tools.json`, `security.json`).
 */
export function pushConfigWarning(
	diagnostics: ConfigDiagnostic[],
	source: ConfigDiagnostic["source"],
	path: string,
	field: string,
	message: string,
): void {
	diagnostics.push({ source, path, severity: "warning", message: `${field}: ${message}` });
}

/**
 * Shared "read JSON, merge onto defaults, collect diagnostics" shape for the app-level config
 * files (`tools.json`, `security.json`, spec 035): defaults when the file is absent, one `error`
 * diagnostic (never a thrown exception) when it fails to parse, otherwise whatever field-level
 * `warning`s `merge` collected. `merge` owns everything past "valid JSON" — structural validation,
 * per-field fallbacks, and pushing its own warnings via {@link pushConfigWarning}.
 */
export function loadJsonConfig<T>(input: {
	source: ConfigDiagnostic["source"];
	path: string;
	defaults: T;
	merge: (raw: unknown, path: string, diagnostics: ConfigDiagnostic[]) => T;
}): { config: T; diagnostics: ConfigDiagnostic[] } {
	if (!existsSync(input.path)) {
		return { config: input.defaults, diagnostics: [] };
	}
	try {
		const raw = JSON.parse(readFileSync(input.path, "utf-8"));
		const diagnostics: ConfigDiagnostic[] = [];
		return { config: input.merge(raw, input.path, diagnostics), diagnostics };
	} catch (error) {
		return {
			config: input.defaults,
			diagnostics: [{ source: input.source, path: input.path, severity: "error", message: errorMessage(error) }],
		};
	}
}
