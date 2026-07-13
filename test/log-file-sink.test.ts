import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalHome = process.env.PIPICLAW_HOME;
const originalLevel = process.env.PIPICLAW_LOG_LEVEL;
const originalFile = process.env.PIPICLAW_LOG_FILE;

let home: string;

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

async function loadLog() {
	vi.resetModules();
	const paths = await import("../src/paths.js");
	const log = await import("../src/log.js");
	return { log, runtimeLogPath: paths.RUNTIME_LOG_PATH };
}

function readRecords(path: string): Array<Record<string, unknown>> {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf-8")
		.split("\n")
		.filter((l) => l.length > 0)
		.map((l) => JSON.parse(l));
}

async function flush(): Promise<void> {
	// The file sink appends asynchronously off the serial queue.
	await new Promise((r) => setTimeout(r, 20));
}

describe("log file sink", () => {
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "log-sink-"));
		process.env.PIPICLAW_HOME = home;
		delete process.env.PIPICLAW_LOG_LEVEL;
		delete process.env.PIPICLAW_LOG_FILE;
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
		restoreEnv("PIPICLAW_HOME", originalHome);
		restoreEnv("PIPICLAW_LOG_LEVEL", originalLevel);
		restoreEnv("PIPICLAW_LOG_FILE", originalFile);
		vi.restoreAllMocks();
	});

	it("writes nothing to disk before configureLogging (console-only default)", async () => {
		const { log, runtimeLogPath } = await loadLog();
		log.logInfo("early startup");
		await flush();
		expect(existsSync(runtimeLogPath)).toBe(false);
	});

	it("persists structured records after configureLogging", async () => {
		const { log, runtimeLogPath } = await loadLog();
		log.configureLogging({ level: "debug", file: { enabled: true, maxSizeBytes: 5_000_000, maxFiles: 3 } });

		log.logToolSuccess({ channelId: "team-1", userName: "alice" }, "bash", 1500, "output body");
		log.logInfo("boot complete");
		await flush();

		const records = readRecords(runtimeLogPath);
		const tool = records.find((r) => r.event === "agent.tool.finished");
		expect(tool).toMatchObject({
			level: "debug",
			event: "agent.tool.finished",
			channelId: "team-1",
			userName: "alice",
			message: "Tool completed",
			fields: { tool: "bash", durationMs: 1500, resultLength: 11 },
		});
		expect(typeof tool?.ts).toBe("string");
		expect(records.find((r) => r.event === "system.info")).toMatchObject({ message: "boot complete", level: "info" });
	});

	it("filters records below the configured level", async () => {
		const { log, runtimeLogPath } = await loadLog();
		log.configureLogging({ level: "warn", file: { enabled: true, maxSizeBytes: 5_000_000, maxFiles: 3 } });

		log.logInfo("info line"); // info < warn → dropped
		log.logWarning("warn line"); // kept
		await flush();

		const records = readRecords(runtimeLogPath);
		expect(records.map((r) => r.message)).toEqual(["warn line"]);
	});

	it("lets PIPICLAW_LOG_FILE=0 override settings.file.enabled", async () => {
		process.env.PIPICLAW_LOG_FILE = "0";
		const { log, runtimeLogPath } = await loadLog();
		log.configureLogging({ level: "info", file: { enabled: true, maxSizeBytes: 5_000_000, maxFiles: 3 } });

		log.logInfo("should not persist");
		await flush();
		expect(existsSync(runtimeLogPath)).toBe(false);
	});

	it("lets PIPICLAW_LOG_LEVEL override settings.level", async () => {
		process.env.PIPICLAW_LOG_LEVEL = "debug";
		const { log, runtimeLogPath } = await loadLog();
		log.configureLogging({ level: "warn", file: { enabled: true, maxSizeBytes: 5_000_000, maxFiles: 3 } });

		log.logThinking({ channelId: "dm_1", userName: "a" }, "hmm"); // debug event
		await flush();

		const records = readRecords(runtimeLogPath);
		expect(records.find((r) => r.event === "agent.thinking")).toBeTruthy();
	});

	it("uses one stdout format, honors the level, and redacts fields", async () => {
		const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { log } = await loadLog();
		log.configureLogging({ level: "warn", file: { enabled: false, maxSizeBytes: 5_000_000, maxFiles: 3 } });
		log.logEvent("info", "agent.turn.started", "not visible");
		log.logEvent("warn", "runtime.request.failed", "Request failed", {
			ctx: { channelId: "dm_1", userName: "alice" },
			fields: { authorization: "Bearer top-secret", nested: { token: "hidden", safe: "ok" } },
		});

		expect(consoleSpy).toHaveBeenCalledTimes(1);
		const line = String(consoleSpy.mock.calls[0]?.[0]);
		expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T.* WARN {2}runtime\.request\.failed Request failed /);
		expect(line).toContain('authorization="[REDACTED]"');
		expect(line).toContain("[REDACTED]");
		expect(line).not.toContain("hidden");
	});

	it("redacts sensitive values and bounds details in structured records", async () => {
		const { log, runtimeLogPath } = await loadLog();
		log.configureLogging({ level: "info", file: { enabled: true, maxSizeBytes: 5_000_000, maxFiles: 3 } });

		log.logEvent("info", "runtime.request.failed", "Authorization: Bearer top-secret", {
			fields: {
				token: "hidden",
				nested: { cookie: "session=hidden", safe: "ok" },
				long: "x".repeat(300),
			},
		});
		await flush();

		const record = readRecords(runtimeLogPath)[0];
		expect(record.message).toContain("[REDACTED]");
		expect(record.fields).toMatchObject({
			token: "[REDACTED]",
			nested: { cookie: "[REDACTED]", safe: "ok" },
		});
		expect(((record.fields as Record<string, unknown>).long as string).length).toBeLessThan(300);
	});
});
