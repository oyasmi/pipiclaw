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

async function flush(log: { flushLogging(): Promise<void> }): Promise<void> {
	// The file sink appends asynchronously off the serial queue; wait for it to drain rather
	// than guessing a duration, which turns flaky whenever the suite is under load.
	await log.flushLogging();
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

	it("persists structured records after configureLogging", async () => {
		const { log, runtimeLogPath } = await loadLog();
		log.configureLogging({ level: "debug", file: { enabled: true, maxSizeBytes: 5_000_000, maxFiles: 3 } });

		log.logToolSuccess({ channelId: "team-1", userName: "alice" }, "bash", 1500, "output body");
		log.logInfo("boot complete");
		await flush(log);

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
		await flush(log);

		const records = readRecords(runtimeLogPath);
		expect(records.map((r) => r.message)).toEqual(["warn line"]);
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
		await flush(log);

		const record = readRecords(runtimeLogPath)[0];
		// Assert on the secret's absence, not on `[REDACTED]` being present somewhere: the
		// scheme-swallowing bug produced "Authorization:[REDACTED] top-secret", which satisfies
		// a `toContain("[REDACTED]")` assertion while leaving the token in the archive.
		expect(record.message).not.toContain("top-secret");
		expect(record.message).toContain("[REDACTED]");
		expect(record.fields).toMatchObject({
			token: "[REDACTED]",
			nested: { cookie: "[REDACTED]", safe: "ok" },
		});
		expect(((record.fields as Record<string, unknown>).long as string).length).toBeLessThan(300);
	});

	// `details` carries verbatim tool output (bash/web results, `curl -v` headers, kubectl
	// errors), so these shapes reach the archive in practice, not just in theory.
	it.each([
		["scheme after colon", "Authorization: Bearer sk-ant-api03-SECRETVALUE"],
		["scheme after equals", "Authorization=Bearer sk-ant-api03-SECRETVALUE"],
		["quoted json", '{"authorization":"Bearer sk-ant-api03-SECRETVALUE","safe":"ok"}'],
		["bare scheme", "bearer sk-ant-api03-SECRETVALUE"],
		["value containing a colon", "token=SECRETVALUE:SECRETVALUE"],
		["header inside a command line", "curl -v -H 'Authorization: Bearer sk-ant-api03-SECRETVALUE' https://api"],
	])("keeps the secret out of message and details: %s", async (_name, text) => {
		const { log, runtimeLogPath } = await loadLog();
		log.configureLogging({ level: "info", file: { enabled: true, maxSizeBytes: 5_000_000, maxFiles: 3 } });

		log.logEvent("info", "agent.tool.finished", text, { details: text });
		await flush(log);

		const record = readRecords(runtimeLogPath)[0];
		expect(record.message).not.toContain("SECRETVALUE");
		expect(record.details).not.toContain("SECRETVALUE");
		expect(record.details).toContain("[REDACTED]");
	});
});
