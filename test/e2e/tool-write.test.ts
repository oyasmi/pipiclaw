import { existsSync, readFileSync } from "fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRuntimeHarness, type E2ERuntimeHarness } from "./helpers/runtime-harness.js";
import { canRunE2E } from "./helpers/setup.js";

const describeE2E = canRunE2E() ? describe : describe.skip;

describeE2E("E2E: write tools", () => {
	let harness: E2ERuntimeHarness;

	beforeAll(async () => {
		harness = await createRuntimeHarness();
	});

	afterAll(async () => {
		await harness.shutdown();
	});

	it("creates a file with requested content", async () => {
		const filePath = `${harness.workspaceDir}/e2e-output.txt`;
		const marker = "E2E_WRITE_MARKER_92ab";

		await harness.sendUserMessage(`请创建文件 ${filePath}，写入 ${marker}，然后告诉我完成了。`);

		expect(existsSync(filePath)).toBe(true);
		expect(readFileSync(filePath, "utf-8")).toContain(marker);
		expect(harness.deliveries.some((delivery) => delivery.method === "sendPlain")).toBe(true);
	});

	it("executes bash and leaves a filesystem side effect", async () => {
		const filePath = `${harness.workspaceDir}/bash-output.txt`;
		const marker = "E2E_BASH_MARKER_42";

		await harness.sendUserMessage(`请执行 bash 命令把 ${marker} 写入 ${filePath}，然后告诉我结果。`);

		expect(existsSync(filePath)).toBe(true);
		expect(readFileSync(filePath, "utf-8")).toContain(marker);
	});
});
