import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SecurityConfig, SecurityLogEvent } from "./types.js";

function getLogPath(workspaceDir: string, config: SecurityConfig): string {
	return config.audit.logFile?.trim() ? config.audit.logFile : join(workspaceDir, ".pipiclaw", "security.log");
}

export function logSecurityEvent(workspaceDir: string, config: SecurityConfig, event: SecurityLogEvent): void {
	if (!config.audit.logBlocked) {
		return;
	}

	const logPath = getLogPath(workspaceDir, config);
	try {
		mkdirSync(dirname(logPath), { recursive: true });
		appendFileSync(logPath, `${JSON.stringify({ date: new Date().toISOString(), ...event })}\n`, "utf-8");
	} catch {
		// Audit logging must never break the tool path.
	}
}
