import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_HOME_DIR } from "../paths.js";
import { isRecord } from "../shared/type-guards.js";
import type { SecurityConfig } from "./types.js";

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

function mergeSecurityConfig(source: unknown): SecurityConfig {
	if (!isRecord(source)) {
		return DEFAULT_SECURITY_CONFIG;
	}

	const commandGuard = isRecord(source.commandGuard) ? source.commandGuard : {};
	const pathGuard = isRecord(source.pathGuard) ? source.pathGuard : {};
	const networkGuard = isRecord(source.networkGuard) ? source.networkGuard : {};
	const audit = isRecord(source.audit) ? source.audit : {};

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

export function loadSecurityConfig(appHomeDir = APP_HOME_DIR): SecurityConfig {
	const configPath = getSecurityConfigPath(appHomeDir);
	if (!existsSync(configPath)) {
		return DEFAULT_SECURITY_CONFIG;
	}

	try {
		const raw = JSON.parse(readFileSync(configPath, "utf-8"));
		return mergeSecurityConfig(raw);
	} catch (error) {
		console.warn(`Failed to load security config from ${configPath}: ${error}`);
		return DEFAULT_SECURITY_CONFIG;
	}
}
