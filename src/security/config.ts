import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_HOME_DIR } from "../paths.js";
import type { ConfigDiagnostic } from "../shared/config-diagnostics.js";
import { isRecord } from "../shared/type-guards.js";
import type { SecurityConfig } from "./types.js";

export interface LoadedSecurityConfig {
	config: SecurityConfig;
	diagnostics: ConfigDiagnostic[];
}

export const DEFAULT_SECURITY_CONFIG: SecurityConfig = {
	enabled: true,
	commandGuard: {
		enabled: true,
		additionalDenyPatterns: [],
		allowPatterns: [],
		blockObfuscation: true,
	},
	pathGuard: {
		enabled: true,
		readAllow: [],
		readDeny: [],
		writeAllow: [],
		writeDeny: [],
		resolveSymlinks: true,
	},
	networkGuard: {
		enabled: true,
		allowedCidrs: [],
		allowedHosts: [],
		maxRedirects: 5,
	},
	audit: {
		logBlocked: true,
	},
};

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asOptionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function pushInvalidSecurityDiagnostic(
	diagnostics: ConfigDiagnostic[],
	configPath: string,
	field: string,
	message: string,
): void {
	diagnostics.push({
		source: "security",
		path: configPath,
		severity: "warning",
		message: `${field}: ${message}`,
	});
}

function mergeSecurityConfig(source: unknown, configPath: string, diagnostics: ConfigDiagnostic[]): SecurityConfig {
	if (!isRecord(source)) {
		pushInvalidSecurityDiagnostic(diagnostics, configPath, "root", "expected a JSON object; using defaults");
		return DEFAULT_SECURITY_CONFIG;
	}

	const commandGuard = isRecord(source.commandGuard) ? source.commandGuard : {};
	const pathGuard = isRecord(source.pathGuard) ? source.pathGuard : {};
	const networkGuard = isRecord(source.networkGuard) ? source.networkGuard : {};
	const audit = isRecord(source.audit) ? source.audit : {};

	if (networkGuard.maxRedirects !== undefined) {
		const maxRedirects = networkGuard.maxRedirects;
		const isValidMaxRedirects = typeof maxRedirects === "number" && Number.isFinite(maxRedirects) && maxRedirects > 0;
		if (!isValidMaxRedirects) {
			pushInvalidSecurityDiagnostic(
				diagnostics,
				configPath,
				"networkGuard.maxRedirects",
				"expected a positive integer; using default",
			);
		}
	}

	return {
		enabled: typeof source.enabled === "boolean" ? source.enabled : DEFAULT_SECURITY_CONFIG.enabled,
		commandGuard: {
			enabled:
				typeof commandGuard.enabled === "boolean"
					? commandGuard.enabled
					: DEFAULT_SECURITY_CONFIG.commandGuard.enabled,
			additionalDenyPatterns: asStringArray(commandGuard.additionalDenyPatterns),
			allowPatterns: asStringArray(commandGuard.allowPatterns),
			blockObfuscation:
				typeof commandGuard.blockObfuscation === "boolean"
					? commandGuard.blockObfuscation
					: DEFAULT_SECURITY_CONFIG.commandGuard.blockObfuscation,
		},
		pathGuard: {
			enabled:
				typeof pathGuard.enabled === "boolean" ? pathGuard.enabled : DEFAULT_SECURITY_CONFIG.pathGuard.enabled,
			readAllow: asStringArray(pathGuard.readAllow),
			readDeny: asStringArray(pathGuard.readDeny),
			writeAllow: asStringArray(pathGuard.writeAllow),
			writeDeny: asStringArray(pathGuard.writeDeny),
			resolveSymlinks:
				typeof pathGuard.resolveSymlinks === "boolean"
					? pathGuard.resolveSymlinks
					: DEFAULT_SECURITY_CONFIG.pathGuard.resolveSymlinks,
		},
		networkGuard: {
			enabled:
				typeof networkGuard.enabled === "boolean"
					? networkGuard.enabled
					: DEFAULT_SECURITY_CONFIG.networkGuard.enabled,
			allowedCidrs: asStringArray(networkGuard.allowedCidrs),
			allowedHosts: asStringArray(networkGuard.allowedHosts),
			maxRedirects:
				typeof networkGuard.maxRedirects === "number" &&
				Number.isFinite(networkGuard.maxRedirects) &&
				networkGuard.maxRedirects > 0
					? Math.floor(networkGuard.maxRedirects)
					: DEFAULT_SECURITY_CONFIG.networkGuard.maxRedirects,
		},
		audit: {
			logBlocked:
				typeof audit.logBlocked === "boolean" ? audit.logBlocked : DEFAULT_SECURITY_CONFIG.audit.logBlocked,
			logFile: asOptionalString(audit.logFile),
		},
	};
}

export function getSecurityConfigPath(appHomeDir = APP_HOME_DIR): string {
	return join(appHomeDir, "security.json");
}

export function loadSecurityConfigWithDiagnostics(appHomeDir = APP_HOME_DIR): LoadedSecurityConfig {
	const configPath = getSecurityConfigPath(appHomeDir);
	if (!existsSync(configPath)) {
		return { config: DEFAULT_SECURITY_CONFIG, diagnostics: [] };
	}

	try {
		const raw = JSON.parse(readFileSync(configPath, "utf-8"));
		const diagnostics: ConfigDiagnostic[] = [];
		return {
			config: mergeSecurityConfig(raw, configPath, diagnostics),
			diagnostics,
		};
	} catch (error) {
		return {
			config: DEFAULT_SECURITY_CONFIG,
			diagnostics: [
				{
					source: "security",
					path: configPath,
					severity: "error",
					message: error instanceof Error ? error.message : String(error),
				},
			],
		};
	}
}

export function loadSecurityConfig(appHomeDir = APP_HOME_DIR): SecurityConfig {
	return loadSecurityConfigWithDiagnostics(appHomeDir).config;
}
