import { existsSync, readFileSync } from "fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRuntimeHarness, type E2ERuntimeHarness, writeWorkspaceFile } from "../../support/runtime-harness.js";
import { canRunE2E, getE2ESkipReason } from "../../support/setup.js";

const describeE2E = canRunE2E() ? describe : describe.skip;

/**
 * B1 (spec 048 D3): one turn with real tool calls against the real model, to
 * prove our tool schemas are actually callable. Tool *error* contracts and
 * out-of-bounds behaviour are covered deterministically (A19); this is only the
 * "the model can drive our tools at all" smoke.
 */
describeE2E("E2E live: tool round-trip", () => {
	let harness: E2ERuntimeHarness;

	beforeAll(async () => {
		harness = await createRuntimeHarness();
	});
	afterAll(async () => {
		await harness.shutdown();
	});

	it("reads a file and writes a file in one conversation", async () => {
		const marker = "E2E_TOOLS_MARKER_5b2f";
		const src = writeWorkspaceFile(harness, "fixtures/in.txt", marker);
		const out = `${harness.workspaceDir}/e2e-tools-out.txt`;

		await harness.sendUserMessage(`读取 ${src} 的内容，然后把同样的内容写到 ${out}，完成后告诉我。`);

		expect(existsSync(out), getE2ESkipReason() ?? undefined).toBe(true);
		expect(readFileSync(out, "utf-8")).toContain(marker);
		expect(harness.deliveries.some((d) => d.method === "sendPlain" || d.method === "finalizeCard")).toBe(true);
	});
});
