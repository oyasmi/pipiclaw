import { join } from "node:path";
import { createJsonlAppender, type JsonlAppender } from "../shared/jsonl-appender.js";
import type { SecurityConfig, SecurityLogEvent } from "./types.js";

const AUDIT_WRITE_TIMEOUT_MS = 1_000;
const appenders = new Map<string, JsonlAppender>();

function getLogPath(workspaceDir: string, config: SecurityConfig): string {
	return config.audit.logFile?.trim() ? config.audit.logFile : join(workspaceDir, ".pipiclaw", "security.log");
}

function getAppender(path: string): JsonlAppender {
	let appender = appenders.get(path);
	if (!appender) {
		appender = createJsonlAppender({
			path,
			maxPendingRecords: 4_000,
			maxPendingBytes: 16 * 1024 * 1024,
		});
		appenders.set(path, appender);
	}
	return appender;
}

/** Persist a blocked operation without synchronously stalling the Node event loop. */
export async function logSecurityEvent(
	workspaceDir: string,
	config: SecurityConfig,
	event: SecurityLogEvent,
): Promise<void> {
	if (!config.audit.logBlocked) return;

	let timer: NodeJS.Timeout | undefined;
	try {
		await Promise.race([
			getAppender(getLogPath(workspaceDir, config)).append({ date: new Date().toISOString(), ...event }),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, AUDIT_WRITE_TIMEOUT_MS);
				timer.unref?.();
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export async function flushSecurityLogs(): Promise<void> {
	await Promise.allSettled([...appenders.values()].map((appender) => appender.flush()));
}
