import { createHash } from "node:crypto";
import { readFileSync } from "fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRuntimeHarness, type E2ERuntimeHarness, getChannelFile } from "../support/runtime-harness.js";
import { canRunE2E } from "../support/setup.js";

const describeE2E = canRunE2E() ? describe : describe.skip;

/**
 * The only place that observes the prompt a provider actually received: the debug
 * dump is written from the `before_agent_start` capture, so it is the fully
 * assembled string (Pipiclaw sections + pi's skills/date/cwd tail + boundary footer).
 */
describeE2E("E2E: system prompt ownership", () => {
	let harness: E2ERuntimeHarness;

	beforeAll(async () => {
		harness = await createRuntimeHarness({ enableDebug: true });
	});

	afterAll(async () => {
		await harness.shutdown();
	});

	it("sends the Pipiclaw prompt, with pi's default base prompt gone", async () => {
		await harness.sendUserMessage("你好，请用一句话回复。");

		const dump = JSON.parse(readFileSync(getChannelFile(harness, "last_prompt.json"), "utf-8")) as {
			systemPrompt: string;
			promptManifest?: { fingerprint: string; finalPromptSha256?: string; diagnostics: unknown[] };
		};

		expect(dump.systemPrompt).toContain("## Pipiclaw");
		expect(dump.systemPrompt).not.toContain("operating inside pi, a coding agent harness");
		expect(dump.systemPrompt).not.toContain("Pi documentation");
		expect(dump.systemPrompt).not.toContain("(none)");
		// pi's tail is still there, and the runtime boundary is appended *after* it — the
		// last thing the model reads is runtime-authored, not workspace/retrieved text
		// (spec 025 §6.11). Asserting the ordering, not the exact footer sentence, which
		// is cosmetic and drifts (spec 048 F1).
		const cwdAt = dump.systemPrompt.indexOf("Current working directory:");
		const boundaryAt = dump.systemPrompt.lastIndexOf("## Runtime Boundary");
		expect(cwdAt).toBeGreaterThan(-1);
		expect(boundaryAt).toBeGreaterThan(cwdAt);
		// Nothing of substance after the boundary block — it really is the last section.
		expect(dump.systemPrompt.trimEnd().length - boundaryAt).toBeLessThan(400);
		// No channel id or channel directory in the system prompt: those ride the turn.
		expect(dump.systemPrompt).not.toContain(harness.channelId);
		expect(dump.promptManifest?.diagnostics).toEqual([]);
		// The manifest hash must be the hash of that same prompt: it is what makes the
		// manifest evidence of what the provider received rather than of what we built.
		expect(dump.promptManifest?.finalPromptSha256).toBe(
			createHash("sha256").update(dump.systemPrompt, "utf8").digest("hex"),
		);
	});
});
