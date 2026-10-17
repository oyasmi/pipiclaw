import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getBindingsPath } from "../../../src/dot/paths.js";
import { createDeterministicHarness, type DeterministicHarness } from "../../support/runtime-harness.js";

/** Spec 058: dots, bindings and what an unbound channel may and may not do. */
describe("E2E deterministic: dots and bindings", () => {
	let harness: DeterministicHarness;
	afterEach(async () => {
		await harness.shutdown();
	});

	it("DOT-4: an unbound channel calls no model and creates nothing on disk", async () => {
		// Catches a regression back to "every message grows its own assistant" (INV-2): any path that
		// builds a runner, a dot or a conversation for an unbound channel. Mutation check (2026-10-18):
		// making `DotRuntime.resolve` fall back to another channel's binding for an unbound channel
		// lets the turn reach the provider (model request count 2), and the case goes red.
		harness = await createDeterministicHarness();
		const stranger = "group_cidNEW/unbound+AA==";
		const dotsDir = join(harness.workspaceDir, "dots");
		const dotsBefore = readdirSync(dotsDir).sort();
		const conversationsBefore = readdirSync(join(harness.dotDir, "conversations")).sort();
		const bindingsBefore = readFileSync(getBindingsPath(harness.workspaceDir), "utf8");

		const before = harness.deliveries.length;
		await harness.sendUserMessage("你好，帮我看看这个群", {
			channelId: stranger,
			type: "group",
			conversationType: "2",
		});

		expect(harness.modelRequestCount()).toBe(0);
		const replies = harness.deliveries.slice(before).filter((d) => d.channelId === stranger);
		expect(replies).toHaveLength(1);
		expect(readdirSync(dotsDir).sort()).toEqual(dotsBefore);
		expect(readdirSync(join(harness.dotDir, "conversations")).sort()).toEqual(conversationsBefore);
		expect(readFileSync(getBindingsPath(harness.workspaceDir), "utf8")).toBe(bindingsBefore);
		expect(existsSync(join(harness.workspaceDir, stranger))).toBe(false);
	});
});
