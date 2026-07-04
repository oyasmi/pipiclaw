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
		log.configureLogging({ level: "info", file: { enabled: true, maxSizeBytes: 5_000_000, maxFiles: 3 } });

		log.logToolSuccess({ channelId: "team-1", userName: "alice" }, "bash", 1500, "output body");
		log.logInfo("boot complete");
		await flush();

		const records = readRecords(runtimeLogPath);
		const tool = records.find((r) => r.event === "tool_end");
		expect(tool).toMatchObject({
			level: "info",
			event: "tool_end",
			channelId: "team-1",
			userName: "alice",
			message: "bash",
			fields: { toolName: "bash", durationMs: 1500, isError: false },
		});
		expect(typeof tool?.ts).toBe("string");
		expect(records.find((r) => r.event === "system")).toMatchObject({ message: "boot complete", level: "info" });
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
		expect(records.find((r) => r.event === "thinking")).toBeTruthy();
	});
});
