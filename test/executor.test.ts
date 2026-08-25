import { describe, expect, it } from "vitest";
import { CommandTerminatedError, createExecutor } from "../src/executor.js";

describe("executor", () => {
	it("runs commands on the host and streams stdin", async () => {
		const hostExecutor = createExecutor();
		await expect(hostExecutor.exec("printf hello")).resolves.toMatchObject({
			stdout: "hello",
			stderr: "",
			code: 0,
		});
		await expect(hostExecutor.exec("cat", { stdin: "hello" })).resolves.toMatchObject({
			stdout: "hello",
		});
	});

	it("reports command exit codes, timeouts, and aborts from the host executor", async () => {
		const hostExecutor = createExecutor();

		await expect(hostExecutor.exec("printf out; printf err >&2; exit 3")).resolves.toMatchObject({
			stdout: "out",
			stderr: "err",
			code: 3,
		});

		await expect(hostExecutor.exec("sleep 1", { timeout: 0.01 })).rejects.toThrow(
			"Command timed out after 0.01 seconds",
		);

		const controller = new AbortController();
		const aborted = hostExecutor.exec("sleep 1", { signal: controller.signal });
		setTimeout(() => controller.abort(), 10);
		await expect(aborted).rejects.toThrow("Command aborted");
	});

	// Fix plan §2.2: the rejection's message must stay short even when the command produced a lot
	// of output, because the pi SDK puts `Error.message` verbatim and untruncated into the model's
	// context. Full output belongs on `CommandTerminatedError.stdout`/`.stderr`, not in the message.
	it("keeps the timeout error message short and puts output on the error's stdout/stderr instead", async () => {
		const hostExecutor = createExecutor();
		let caught: unknown;
		try {
			await hostExecutor.exec("yes | head -c 200000; sleep 1", { timeout: 0.05 });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(CommandTerminatedError);
		const error = caught as CommandTerminatedError;
		expect(error.message.length).toBeLessThan(200);
		expect(error.reason).toBe("timeout");
		expect(error.stdout.length).toBeGreaterThan(1000);
	});

	// Spec 044, D6.1: decoding must happen once at close, over the concatenated raw bytes -- not
	// per chunk -- or a multi-byte UTF-8 sequence split across a stream `data` event boundary mints
	// a U+FFFD in the middle of otherwise-valid text.
	it("does not corrupt multi-byte UTF-8 output split across stream chunks", async () => {
		const hostExecutor = createExecutor();
		// ~900KB of Chinese text, comfortably spanning many default (64KB) stream highWaterMarks.
		const line = "汉字测试内容一二三四五六七八九十".repeat(50);
		const lineCount = Math.ceil((900 * 1024) / Buffer.byteLength(line, "utf-8"));

		const result = await hostExecutor.exec(`for i in $(seq 1 ${lineCount}); do printf '%s' '${line}'; done`);

		expect(result.stdout.includes("�")).toBe(false);
		expect(Buffer.byteLength(result.stdout, "utf-8")).toBeGreaterThan(800 * 1024);
	});

	// Spec 044, D6.2: the byte cap must be a byte cap, not a UTF-16 code-unit cap -- and a caller
	// must be able to tell whether it was hit.
	it("caps capture by byte count and reports truncation, honoring a per-call override", async () => {
		const hostExecutor = createExecutor();

		const small = await hostExecutor.exec("printf 'hello'", { maxCaptureBytes: 3 });
		expect(small.stdout).toBe("hel");
		expect(small.stdoutTruncated).toBe(true);

		const untouched = await hostExecutor.exec("printf 'hello'", { maxCaptureBytes: 100 });
		expect(untouched.stdout).toBe("hello");
		expect(untouched.stdoutTruncated).toBeUndefined();
	});

	// Spec 044, D6.3: `spillTo` streams the *full*, uncapped output to disk as it arrives, so a
	// caller can offer a genuinely complete "full output" file even when the in-memory capture was
	// truncated at `maxCaptureBytes`.
	it("spillTo streams the complete raw output to disk, uncapped by maxCaptureBytes", async () => {
		const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "pipiclaw-executor-test-"));
		const spillTo = join(dir, "spill.log");
		try {
			const hostExecutor = createExecutor();
			const result = await hostExecutor.exec("printf '0123456789'", { maxCaptureBytes: 4, spillTo });

			expect(result.stdout).toBe("0123");
			expect(result.stdoutTruncated).toBe(true);
			expect(readFileSync(spillTo, "utf-8")).toBe("0123456789");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
