import { join } from "node:path";
import { createJsonlAppender, type JsonlAppender } from "../shared/jsonl-appender.js";
import { formatLocalTime } from "../shared/local-time.js";
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
	// external-agent records a permitted action, not a blocked one (spec 040, D8.1): it must not
	// disappear just because the operator only wants blocked-action logging.
	if (!config.audit.logBlocked && event.type !== "external-agent") return;
	if (event.type === "external-agent") {
		// External agents bypass command-guard. Their complete dispatch record is therefore a
		// security gate, not best-effort observability: do not return until it is on disk, and let
		// capacity/permission/I/O failures reject the dispatch before a child can be spawned.
		await getAppender(getLogPath(workspaceDir, config)).appendStrict({ date: formatLocalTime(), ...event });
		return;
	}

	let timer: NodeJS.Timeout | undefined;
	try {
		await Promise.race([
			getAppender(getLogPath(workspaceDir, config)).append({ date: formatLocalTime(), ...event }),
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
