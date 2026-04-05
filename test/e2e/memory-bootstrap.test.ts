import { mkdirSync, writeFileSync } from "fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	channelFileExists,
	createRuntimeHarness,
	type E2ERuntimeHarness,
	getChannelFile,
} from "./helpers/runtime-harness.js";
import { canRunE2E } from "./helpers/setup.js";
import { waitForFileContent } from "./helpers/wait.js";

const describeE2E = canRunE2E() ? describe : describe.skip;

describeE2E("E2E: memory bootstrap", () => {
	let harness: E2ERuntimeHarness;

	beforeAll(async () => {
		harness = await createRuntimeHarness({ enableDebug: true });
	});

	afterAll(async () => {
		delete process.env.PIPICLAW_DEBUG;
		await harness.shutdown();
	});

	it("injects channel memory into the first prompt debug artifact", async () => {
		mkdirSync(harness.channelDir, { recursive: true });
		writeFileSync(
			getChannelFile(harness, "MEMORY.md"),
			"# Channel Memory\n\n## Durable Facts\n\n- 用户偏好使用中文\n- 用户关注 E2E_MEMORY_MARKER_55\n",
			"utf-8",
		);

		await harness.sendUserMessage("你好，请结合我之前的偏好，简短回复。");

		expect(channelFileExists(harness, "last_prompt.json")).toBe(true);
		const content = await waitForFileContent(getChannelFile(harness, "last_prompt.json"), (text) =>
			text.includes("E2E_MEMORY_MARKER_55"),
		);

		expect(content).toContain("durableMemoryBootstrap");
		expect(content).toContain("E2E_MEMORY_MARKER_55");
	});
});
