import type { MockInstance } from "vitest";
import { describe, expect, it, vi } from "vitest";
import { createExecutor, parseSandboxArg, validateSandbox } from "../src/sandbox.js";

function mockProcessExit(): MockInstance {
	return vi.spyOn(process, "exit").mockImplementation((() => {
		throw new Error("process.exit");
	}) as (code?: string | number | null | undefined) => never);
}

describe("sandbox", () => {
	it("parses valid sandbox arguments", () => {
		expect(parseSandboxArg("host")).toEqual({ type: "host" });
		expect(parseSandboxArg("docker:pipiclaw-sandbox")).toEqual({
			type: "docker",
			container: "pipiclaw-sandbox",
		});
	});

	it("rejects invalid sandbox arguments by exiting", () => {
		const exitSpy = mockProcessExit();
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		expect(() => parseSandboxArg("docker:")).toThrow("process.exit");
		expect(() => parseSandboxArg("weird")).toThrow("process.exit");
		expect(exitSpy).toHaveBeenCalled();
		expect(errorSpy).toHaveBeenCalled();

		exitSpy.mockRestore();
		errorSpy.mockRestore();
	});

	it("returns working executors for host and docker path mapping", async () => {
		const hostExecutor = createExecutor({ type: "host" });
		await expect(hostExecutor.exec("printf hello")).resolves.toMatchObject({
			stdout: "hello",
			stderr: "",
			code: 0,
		});
		await expect(hostExecutor.exec("cat", { stdin: "hello" })).resolves.toMatchObject({
			stdout: "hello",
		});
		expect(hostExecutor.getWorkspacePath("/tmp/project")).toBe("/tmp/project");

		const dockerExecutor = createExecutor({ type: "docker", container: "sandbox" });
		expect(dockerExecutor.getWorkspacePath("/tmp/project")).toBe("/workspace");
	});

	it("accepts host sandbox validation without external checks", async () => {
		await expect(validateSandbox({ type: "host" })).resolves.toBeUndefined();
	});

	it("reports command exit codes, timeouts, and aborts from the host executor", async () => {
		const hostExecutor = createExecutor({ type: "host" });

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
