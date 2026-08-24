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
});
