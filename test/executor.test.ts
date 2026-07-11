import { describe, expect, it } from "vitest";
import { createExecutor } from "../src/executor.js";

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
});
